/**
 * REST API routes using Hono.
 * Provides /health, /memories, /memories/search, /memories/list, /memories/batch,
 * /memories/:id (PUT, DELETE), /stats endpoints.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { getPool } from "../db/connection.js";
import {
  captureThought,
  searchThoughts,
  listThoughts,
  countThoughts,
  getThoughtById,
  getThoughtStats,
  updateThought,
  deleteThought,
  captureThoughts,
  searchThoughtsBySource,
  type ListFilters,
  type BatchThoughtInput,
} from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import type { EmbedderPing } from "../embedder/types.js";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  logWarnings,
  isStrictIngestEnabled,
} from "./validation.js";

/** Upper bound on one /memories/list page. `total` is always returned, so a caller can page past it. */
const LIST_MAX_LIMIT = 1000;

const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApi(): Hono {
  const app = new Hono();
  const embedder = getEmbedder();
  const pool = getPool();

  // Middleware
  app.use("*", cors());
  app.use("*", logger());

  // Global error handler — return structured JSON for all errors
  app.onError((err, c) => {
    console.error("[api] Unhandled error:", err.message);
    return c.json(
      { error: err.message, service: "open-brain-api" },
      500
    );
  });

  // ─── Health Check ────────────────────────────────────────────────

  /**
   * Cached dependency probe (S275, task_1785713207341).
   *
   * The container HEALTHCHECK runs every 30s and a human may curl /health at any
   * time, so the probe is cached: a healthcheck that hammers its dependency is a
   * healthcheck that becomes part of the problem.
   */
  let depCache: { at: number; ping: EmbedderPing } | null = null;
  const DEP_TTL_MS = 10_000;

  async function probeDependency(): Promise<EmbedderPing> {
    if (depCache && Date.now() - depCache.at < DEP_TTL_MS) return depCache.ping;
    const ping: EmbedderPing = embedder.ping
      ? await embedder.ping()
      : // NOT PROBED, and it says so rather than defaulting to a pass. A provider
        // with no free liveness endpoint (azure, openrouter) must not be billed
        // every 30s just so a healthcheck can look thorough.
        { provider: "unknown", reachable: null, ms: null, detail: "provider exposes no free liveness probe" };
    depCache = { at: Date.now(), ping };
    return ping;
  }

  app.get("/health", async (c) => {
    const capabilities = [
      "capture",
      "search",
      "list",
      "batch",
      "update",
      "delete",
      "stats",
      "by-source",
      "strict-validation",
      "warning-channel",
      "embed-truncation-warning",
    ];
    if (isStrictIngestEnabled()) capabilities.push("strict-ingest");

    // *** `status` DELIBERATELY STILL MEANS "THIS PROCESS IS UP". ***
    // It is NOT widened to cover dependencies, because collect-ob1-health.mjs
    // keys api_healthy off `status === "healthy"`, and ops-ob1.capability -- the
    // estate's only `critical` seam -- derives its verdict from that. Widening it
    // here would silently re-label a dead-ollama condition from `search-failed`
    // to `api-unhealthy` on that seam. Same fact, different name, no announcement.
    //
    // What WAS wrong is that this endpoint reported nothing about its dependency
    // at all, so a reader was actively misled during the S204 and S231 outages.
    // `dependencies` fixes that without moving anyone's goalposts. The endpoint
    // that actually FAILS is /health/deep, below.
    const dependency = await probeDependency();
    return c.json({
      status: "healthy",
      service: "open-brain-api",
      capabilities,
      dependencies: { embedder: dependency },
    });
  });

  /**
   * Dependency-aware health, for the container HEALTHCHECK.
   *
   * *** THIS IS THE ONE THAT CAN GO RED. *** The Dockerfile HEALTHCHECK points
   * here, so `docker inspect` finally reflects something that can fail --
   * measured green through the S204 and S231 outages while search was dead.
   *
   * It proves REACHABILITY, not capability: a wedged runner answers /api/tags
   * perfectly (S269). Complementary to ops-ob1.capability, never a substitute --
   * what shipped there makes US know, this makes DOCKER act.
   *
   * A NOT-PROBED dependency is NOT a failure: a provider with no free liveness
   * endpoint would otherwise be permanently unhealthy, which is the always-red
   * class. Only a MEASURED false fails.
   */
  app.get("/health/deep", async (c) => {
    const dependency = await probeDependency();
    const degraded = dependency.reachable === false;
    return c.json(
      {
        status: degraded ? "degraded" : "healthy",
        service: "open-brain-api",
        dependencies: { embedder: dependency },
      },
      degraded ? 503 : 200
    );
  });

  // ─── Capture Memory ──────────────────────────────────────────────

  app.post("/memories", async (c) => {
    let input;
    try {
      input = validateCaptureInput(await c.req.json(), { defaultSource: "api" });
    } catch (err) {
      if (err instanceof CaptureValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const [embedding, autoMetadata] = await Promise.all([
        embedder.generateEmbedding(input.content),
        embedder.extractMetadata(input.content),
      ]);

      // Caller-supplied metadata wins over auto-extracted; both lose to `source` which
      // is canonicalised at the top level so we can index on it.
      const fullMetadata = { ...autoMetadata, ...input.metadata, source: input.source };
      const { row: result, deduplicated } = await captureThought(
        pool, input.content, embedding, fullMetadata, input.project, input.supersedes,
        input.created_by, { idempotencyKey: input.idempotency_key }
      );

      logWarnings(input.warnings, {
        transport: "rest",
        source: input.source,
        project: input.project,
        created_by: input.created_by,
      });

      return c.json({
        id: result.id,
        type: (fullMetadata.type as string | undefined) ?? autoMetadata.type,
        topics: (fullMetadata.topics as string[] | undefined) ?? autoMetadata.topics,
        people: (fullMetadata.people as string[] | undefined) ?? autoMetadata.people,
        project: result.project,
        captured_at: result.created_at.toISOString(),
        // True when this request duplicated a recent identical capture and the ORIGINAL
        // row was returned. Not an error: it is what makes retrying a timeout safe.
        deduplicated,
        warnings: input.warnings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Capture failed:", message);
      return c.json(
        { error: "Failed to capture thought", detail: message },
        502
      );
    }
  });

  // ─── Batch Capture ───────────────────────────────────────────────

  app.post("/memories/batch", async (c) => {
    let batch;
    try {
      batch = validateBatchInput(await c.req.json(), { defaultSource: "api" });
    } catch (err) {
      if (err instanceof CaptureValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const processed: BatchThoughtInput[] = await Promise.all(
        batch.items.map(async (item) => {
          const [embedding, autoMetadata] = await Promise.all([
            embedder.generateEmbedding(item.content),
            embedder.extractMetadata(item.content),
          ]);
          return {
            content: item.content,
            embedding,
            metadata: { ...autoMetadata, ...item.metadata, source: item.source },
            project: item.project,
            created_by: item.created_by,
          };
        })
      );

      const results = await captureThoughts(pool, processed);

      for (const w of batch.warnings) {
        console.warn(
          `[ingest-warning] ${JSON.stringify({
            transport: "rest",
            scope: "batch-envelope",
            field: w.field,
            reason: w.reason,
            message: w.message,
          })}`,
        );
      }
      for (const item of batch.items) {
        logWarnings(item.warnings, {
          transport: "rest",
          source: item.source,
          project: item.project,
          created_by: item.created_by,
        });
      }

      return c.json({
        count: results.length,
        deduplicated_count: results.filter((r) => r.deduplicated).length,
        envelope_warnings: batch.warnings,
        results: results.map(({ row: r, deduplicated }, i) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          captured_at: r.created_at.toISOString(),
          deduplicated,
          warnings: batch.items[i]?.warnings ?? [],
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Batch capture failed:", message);
      return c.json(
        { error: "Failed to batch capture thoughts", detail: message },
        502
      );
    }
  });

  // ─── Search Memories ─────────────────────────────────────────────

  app.post("/memories/search", async (c) => {
    const body = await c.req.json<{
      query: string;
      limit?: number;
      threshold?: number;
      project?: string;
      created_by?: string;
      type?: string;
      topic?: string;
      include_archived?: boolean;
    }>();

    if (!body.query || body.query.trim().length === 0) {
      return c.json({ error: "query is required" }, 400);
    }

    try {
      // Build JSONB filter from type/topic
      const filter: Record<string, unknown> = {};
      if (body.type) filter.type = body.type;
      if (body.topic) filter.topics = [body.topic];

      const queryEmbedding = await embedder.generateEmbedding(body.query);
      const results = await searchThoughts(
        pool,
        queryEmbedding,
        body.limit ?? 10,
        body.threshold ?? 0.5,
        filter,
        body.project,
        body.include_archived,
        body.created_by
      );

      return c.json({
        query: body.query,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          similarity: Math.round(r.similarity * 1000) / 1000,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Search failed:", message);
      return c.json(
        { error: "Failed to search thoughts", detail: message },
        502
      );
    }
  });

  // ─── List Memories ───────────────────────────────────────────────

  // `limit` and `offset` used to be accepted in the body and silently dropped: the
  // filters went through, the page size did not, so every call returned the default 50
  // with `count: 50` reading like a total. A consumer asking for 200 rows of a 352-row
  // class got 50 and believed it. The MCP list_thoughts tool paged correctly the whole
  // time -- only this route was missed. Now mirrors it, and returns `total` so a caller
  // can tell a full page from a complete answer.
  app.post("/memories/list", async (c) => {
    try {
      const body = await c.req.json<ListFilters & { limit?: unknown; offset?: unknown }>();
      const { limit: rawLimit, offset: rawOffset, ...filters } = body;
      const limit = Math.min(
        LIST_MAX_LIMIT,
        Math.max(1, Number.isInteger(rawLimit) ? (rawLimit as number) : 50)
      );
      const offset = Math.max(0, Number.isInteger(rawOffset) ? (rawOffset as number) : 0);

      const [results, total] = await Promise.all([
        listThoughts(pool, filters, limit, offset),
        countThoughts(pool, filters),
      ]);

      return c.json({
        count: results.length,
        total,
        limit,
        offset,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] List failed:", message);
      return c.json(
        { error: "Failed to list thoughts", detail: message },
        500
      );
    }
  });

  // ─── Update Memory ───────────────────────────────────────────────

  app.put("/memories/:id", async (c) => {
    const id = c.req.param("id");

    if (!UUID_RE.test(id)) {
      return c.json({ error: "id must be a valid UUID" }, 400);
    }

    const body = await c.req.json<{ content?: string; tags_line?: string }>();

    const hasContent = typeof body.content === "string" && body.content.trim().length > 0;
    const hasTagsLine = typeof body.tags_line === "string";

    if (hasContent === hasTagsLine) {
      return c.json({ error: "provide exactly one of content or tags_line" }, 400);
    }

    try {
      let result;
      let responseType: string | undefined;
      let responseTopics: string[] | undefined;
      let mode: string;

      if (hasTagsLine) {
        // Tag-only update: splice the first line, keep body + metadata as-is.
        // No metadata re-extraction — a tag flip must never disturb
        // type/topics/source/provenance. Embedding regenerated (content changed).
        const tagsLine = body.tags_line!;
        if (tagsLine.trim().length === 0 || tagsLine.includes("\n")) {
          return c.json({ error: "tags_line must be a non-empty single line" }, 400);
        }

        const thought = await getThoughtById(pool, id);
        if (!thought) {
          return c.json({ error: `Thought not found: ${id}` }, 404);
        }

        const newlineIdx = thought.content.indexOf("\n");
        const bodyText = newlineIdx === -1 ? "" : thought.content.slice(newlineIdx);
        const newContent = tagsLine + bodyText;

        const embedding = await embedder.generateEmbedding(newContent);
        result = await updateThought(pool, id, newContent, embedding, thought.metadata);
        responseType = thought.metadata?.type;
        responseTopics = thought.metadata?.topics;
        mode = "tags_line";
      } else {
        // Full-content update: re-embed + re-extract; updateThought carries
        // source + provenance over from the existing row.
        const [embedding, metadata] = await Promise.all([
          embedder.generateEmbedding(body.content!),
          embedder.extractMetadata(body.content!),
        ]);

        result = await updateThought(pool, id, body.content!, embedding, metadata);
        responseType = metadata.type;
        responseTopics = metadata.topics;
        mode = "content";
      }

      return c.json({
        status: "updated",
        mode,
        id: result.id,
        type: responseType,
        topics: responseTopics,
        source: result.metadata?.source ?? null,
        content: result.content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      console.error("[api] Update failed:", message);
      return c.json(
        { error: "Failed to update thought", detail: message },
        502
      );
    }
  });

  // ─── Delete Memory ───────────────────────────────────────────────

  app.delete("/memories/:id", async (c) => {
    const id = c.req.param("id");

    if (!UUID_RE.test(id)) {
      return c.json({ error: "id must be a valid UUID" }, 400);
    }

    try {
      const result = await deleteThought(pool, id);

      if (!result.deleted) {
        return c.json({ error: `Thought not found: ${id}` }, 404);
      }

      return c.json({ status: "deleted", id: result.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Delete failed:", message);
      return c.json(
        { error: "Failed to delete thought", detail: message },
        502
      );
    }
  });

  // ─── Get Memories by Source ──────────────────────────────────────────

  app.get("/memories/by-source", async (c) => {
    const source = c.req.query("source");

    if (!source || source.trim().length === 0) {
      return c.json({ error: "source query parameter is required" }, 400);
    }

    try {
      const project = c.req.query("project");
      const created_by = c.req.query("created_by");
      const include_archived = c.req.query("include_archived") === "true";
      const limitParam = c.req.query("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;

      const results = await searchThoughtsBySource(pool, source, {
        project: project ?? undefined,
        created_by: created_by ?? undefined,
        include_archived,
        limit,
      });

      return c.json({
        source,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] By-source lookup failed:", message);
      return c.json(
        { error: "Failed to look up memories by source", detail: message },
        500
      );
    }
  });

  // ─── Stats ───────────────────────────────────────────────────────

  app.get("/stats", async (c) => {
    try {
      const project = c.req.query("project");
      const created_by = c.req.query("created_by");
      const stats = await getThoughtStats(pool, project, created_by);
      return c.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Stats failed:", message);
      return c.json(
        { error: "Failed to get stats", detail: message },
        500
      );
    }
  });

  return app;
}
