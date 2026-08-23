/**
 * Database queries for thoughts: insert, search, list, stats.
 * All queries use parameterized SQL (no interpolation).
 */

import { createHash } from "node:crypto";

import type pg from "pg";

// ─── Types ───────────────────────────────────────────────────────────

export interface ThoughtMetadata {
  type?: string;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  dates?: string[];
  source?: string;
  provenance?: {
    origin: string;
    original_id?: string;
    imported_at?: string;
  };
}

export interface ThoughtRow {
  id: string;
  content: string;
  metadata: ThoughtMetadata;
  project?: string | null;
  created_by?: string | null;
  archived?: boolean;
  supersedes?: string | null;
  created_at: Date;
}

export interface SearchResult extends ThoughtRow {
  similarity: number;
}

export interface ThoughtStats {
  total_thoughts: number;
  types: Record<string, number>;
  top_topics: [string, number][];
  top_people: [string, number][];
  date_range: { earliest: string | null; latest: string | null };
}

export interface ListFilters {
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  project?: string;
  created_by?: string;
  include_archived?: boolean;
  /** Case-insensitive substring match against the first line of content (the tags: line). */
  tags_contain?: string;
}

// --- Capture idempotency -------------------------------------------

/**
 * A client timeout on capture does NOT cancel the server write: the row commits, the
 * client sees a transport error, and a retry writes a SECOND copy. Measured on the live
 * corpus at S275 -- all five uncontaminated exact-duplicate groups were pairs written
 * 39-98 SECONDS apart, byte-identical, three of them sharing one first-write timestamp
 * (a batch retried wholesale).
 *
 * The window is what separates a RETRY from a DELIBERATE re-capture. It is policy, not
 * an invariant, so it lives here and NOT as a unique constraint on content_hash --
 * permanent uniqueness would forbid ever legitimately re-capturing the same text.
 *
 * 10 minutes against an observed worst case of 98 seconds: ~6x headroom, while still far
 * below any plausible interval at which a human deliberately re-captures identical text.
 * Widening this trades duplicate-suppression for silently swallowing real writes.
 */
export const DEDUP_WINDOW_MINUTES = 10;

export interface CaptureOptions {
  /** Overrides DEDUP_WINDOW_MINUTES. 0 disables content-hash dedup entirely. */
  dedupWindowMinutes?: number;
  /**
   * Optional client-supplied key. Exact semantics, independent of the window -- but it
   * only helps a client that can REUSE the key across a retry, which is precisely what a
   * timed-out agent cannot be relied upon to do. The content hash is the load-bearing
   * mechanism; this is the belt to its braces.
   */
  idempotencyKey?: string;
}

export interface CaptureResult {
  row: ThoughtRow;
  /** True when an existing row was returned instead of inserting a new one. */
  deduplicated: boolean;
}

/** sha256 hex of content. Verified byte-identical to the DB's generated column. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const RETURNING_COLS =
  "id, content, metadata, project, created_by, archived, supersedes, created_at";

/**
 * Look for an existing row this capture would duplicate.
 *
 * Scope is (content_hash, project, created_by) within the window. `source` is
 * deliberately NOT part of the identity -- a retry carries the same source anyway, and
 * two sources capturing byte-identical text inside ten minutes is a duplicate worth
 * collapsing regardless.
 *
 * IS NOT DISTINCT FROM, never `=`: project and created_by are nullable and `NULL = NULL`
 * is NULL, so `=` would silently never match the very common unscoped rows -- a dedup
 * that quietly does nothing for most captures.
 */
async function findDuplicate(
  client: pg.PoolClient,
  hash: string,
  project: string | null,
  created_by: string | null,
  windowMinutes: number,
  idempotencyKey?: string
): Promise<ThoughtRow | null> {
  if (idempotencyKey) {
    const { rows } = await client.query<ThoughtRow>(
      `SELECT ${RETURNING_COLS} FROM thoughts WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (rows[0]) return rows[0];
  }

  if (windowMinutes <= 0) return null;

  const { rows } = await client.query<ThoughtRow>(
    `SELECT ${RETURNING_COLS}
       FROM thoughts
      WHERE content_hash = $1
        AND project    IS NOT DISTINCT FROM $2
        AND created_by IS NOT DISTINCT FROM $3
        AND created_at > now() - ($4 || ' minutes')::interval
      ORDER BY created_at ASC
      LIMIT 1`,
    [hash, project, created_by, String(windowMinutes)]
  );
  return rows[0] ?? null;
}

/**
 * Serialise concurrent captures of identical content so check-then-insert cannot
 * interleave. Transaction-scoped: released on COMMIT/ROLLBACK, so there is no leak path.
 */
async function lockOnHash(client: pg.PoolClient, hash: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [hash]);
}


// ─── Insert ──────────────────────────────────────────────────────────

/**
 * RAW insert -- NO dedup, NO transaction. Prefer captureThought() for anything reached by
 * a network client: this path cannot tell a retry from a new thought. Kept exported
 * because it is the honest primitive and the unit tests exercise it directly.
 */
export async function insertThought(
  pool: pg.Pool,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  project?: string,
  supersedes?: string,
  created_by?: string
): Promise<ThoughtRow> {
  const embeddingStr = `[${embedding.join(",")}]`;

  const { rows } = await pool.query<ThoughtRow>(
    `INSERT INTO thoughts (content, embedding, metadata, project, supersedes, created_by)
     VALUES ($1, $2::vector, $3::jsonb, $4, $5, $6)
     RETURNING id, content, metadata, project, created_by, archived, supersedes, created_at`,
    [content, embeddingStr, JSON.stringify(metadata), project ?? null, supersedes ?? null, created_by ?? null]
  );

  return rows[0]!;
}

// ─── Semantic Search ─────────────────────────────────────────────────

export async function searchThoughts(
  pool: pg.Pool,
  queryEmbedding: number[],
  limit: number = 10,
  threshold: number = 0.5,
  filter: Record<string, unknown> = {},
  project?: string,
  include_archived?: boolean,
  created_by?: string
): Promise<SearchResult[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const { rows } = await pool.query<SearchResult>(
    `SELECT id, content, metadata, similarity, created_at
     FROM match_thoughts($1::vector, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      embeddingStr,
      threshold,
      limit,
      JSON.stringify(filter),
      project ?? null,
      include_archived ?? false,
      created_by ?? null,
    ]
  );

  return rows;
}

// ─── Filtered List ───────────────────────────────────────────────────

/** Build the WHERE clause + params shared by listThoughts and countThoughts. */
function buildListConditions(filters: ListFilters): {
  whereClause: string;
  params: unknown[];
  idx: number;
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  if (filters.type) {
    idx++;
    conditions.push(`metadata->>'type' = $${idx}`);
    params.push(filters.type);
  }

  if (filters.topic) {
    idx++;
    conditions.push(`metadata->'topics' ? $${idx}`);
    params.push(filters.topic);
  }

  if (filters.person) {
    idx++;
    conditions.push(`metadata->'people' ? $${idx}`);
    params.push(filters.person);
  }

  if (filters.days) {
    idx++;
    const since = new Date();
    since.setDate(since.getDate() - filters.days);
    conditions.push(`created_at >= $${idx}`);
    params.push(since.toISOString());
  }

  if (filters.project) {
    idx++;
    conditions.push(`project = $${idx}`);
    params.push(filters.project);
  }

  if (filters.created_by) {
    idx++;
    conditions.push(`created_by = $${idx}`);
    params.push(filters.created_by);
  }

  if (filters.tags_contain) {
    idx++;
    // Match against the first line of content only (the canonical tags: line),
    // so prose mentions of a tag elsewhere in the body don't false-positive.
    conditions.push(`split_part(content, E'\\n', 1) ILIKE $${idx}`);
    params.push(`%${filters.tags_contain}%`);
  }

  if (!filters.include_archived) {
    conditions.push(`(archived = false OR archived IS NULL)`);
  }

  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";
  return { whereClause, params, idx };
}

export async function listThoughts(
  pool: pg.Pool,
  filters: ListFilters,
  limit: number = 50,
  offset: number = 0
): Promise<ThoughtRow[]> {
  const { whereClause, params, idx } = buildListConditions(filters);

  const limitIdx = idx + 1;
  const offsetIdx = idx + 2;
  params.push(limit, offset);

  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, metadata, created_by, created_at
     FROM thoughts
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}
     OFFSET $${offsetIdx}`,
    params
  );

  return rows;
}

/** Count thoughts matching the same filters as listThoughts (for pagination totals). */
export async function countThoughts(
  pool: pg.Pool,
  filters: ListFilters
): Promise<number> {
  const { whereClause, params } = buildListConditions(filters);

  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts WHERE ${whereClause}`,
    params
  );

  return parseInt(rows[0]?.count ?? "0", 10);
}

// ─── Get by ID ───────────────────────────────────────────────────────

export async function getThoughtById(
  pool: pg.Pool,
  id: string
): Promise<ThoughtRow | null> {
  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, metadata, project, created_by, archived, supersedes, created_at
     FROM thoughts
     WHERE id = $1`,
    [id]
  );

  return rows[0] ?? null;
}

// ─── Statistics ──────────────────────────────────────────────────────

export async function getThoughtStats(
  pool: pg.Pool,
  project?: string,
  created_by?: string
): Promise<ThoughtStats> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  if (project) {
    idx++;
    conditions.push(`project = $${idx}`);
    params.push(project);
  }
  if (created_by) {
    idx++;
    conditions.push(`created_by = $${idx}`);
    params.push(created_by);
  }

  const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  // Build the AND clause for joined queries (use t. prefix)
  const joinConditions = [];
  let jIdx = 0;
  if (project) {
    jIdx++;
    joinConditions.push(`t.project = $${jIdx}`);
  }
  if (created_by) {
    jIdx++;
    joinConditions.push(`t.created_by = $${jIdx}`);
  }
  const joinAndClause = joinConditions.length > 0 ? "AND " + joinConditions.join(" AND ") : "";

  // Total count
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  // Type distribution
  const typeResult = await pool.query<{ thought_type: string; count: string }>(
    `SELECT metadata->>'type' AS thought_type, COUNT(*)::text AS count
     FROM thoughts t
     WHERE TRUE ${joinAndClause}
     GROUP BY metadata->>'type'
     ORDER BY COUNT(*) DESC`,
    params
  );
  const types: Record<string, number> = {};
  for (const row of typeResult.rows) {
    types[row.thought_type ?? "unknown"] = parseInt(row.count, 10);
  }

  // Top topics
  const topicResult = await pool.query<{ topic: string; count: string }>(
    `SELECT topic, COUNT(*)::text AS count
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'topics') AS topic
     WHERE TRUE ${joinAndClause}
     GROUP BY topic
     ORDER BY COUNT(*) DESC
     LIMIT 10`,
    params
  );
  const topTopics: [string, number][] = topicResult.rows.map((r) => [
    r.topic,
    parseInt(r.count, 10),
  ]);

  // Top people
  const peopleResult = await pool.query<{ person: string; count: string }>(
    `SELECT person, COUNT(*)::text AS count
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'people') AS person
     WHERE TRUE ${joinAndClause}
     GROUP BY person
     ORDER BY COUNT(*) DESC
     LIMIT 10`,
    params
  );
  const topPeople: [string, number][] = peopleResult.rows.map((r) => [
    r.person,
    parseInt(r.count, 10),
  ]);

  // Date range
  const rangeResult = await pool.query<{ earliest: Date | null; latest: Date | null }>(
    `SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM thoughts ${whereClause}`,
    params
  );
  const range = rangeResult.rows[0];

  return {
    total_thoughts: total,
    types,
    top_topics: topTopics,
    top_people: topPeople,
    date_range: {
      earliest: range?.earliest?.toISOString() ?? null,
      latest: range?.latest?.toISOString() ?? null,
    },
  };
}

// ─── Update ──────────────────────────────────────────────────────────

/**
 * Provenance-class metadata keys must survive updates. The update pipeline
 * re-extracts metadata from content, which can never reproduce `source` or
 * `provenance` — they describe where the thought CAME FROM, not what it says.
 * Losing them breaks import-dedup identity (searchThoughtsBySource matches on
 * metadata.source / provenance.origin) and nulls the generated columns
 * source_file_hash / code_hash (derived from provenance.contentHash), which
 * re-opens the duplicate-import window those hashes exist to close.
 *
 * Merge rule: keys carried over from the existing row unless the caller
 * explicitly supplies a replacement value. Explicit app-code merge (not SQL
 * `||`) so the preserved key set is visible and reviewable here.
 */
const PRESERVED_METADATA_KEYS = ["source", "provenance"] as const;

export function mergePreservedMetadata(
  existing: ThoughtMetadata | null | undefined,
  incoming: ThoughtMetadata
): ThoughtMetadata {
  const merged: ThoughtMetadata = { ...incoming };
  if (!existing) return merged;
  for (const key of PRESERVED_METADATA_KEYS) {
    if (merged[key] === undefined && existing[key] !== undefined) {
      merged[key] = existing[key] as never;
    }
  }
  return merged;
}

export async function updateThought(
  pool: pg.Pool,
  id: string,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata
): Promise<ThoughtRow> {
  const embeddingStr = `[${embedding.join(",")}]`;

  const existing = await pool.query<{ metadata: ThoughtMetadata | null }>(
    `SELECT metadata FROM thoughts WHERE id = $1`,
    [id]
  );

  if (!existing.rowCount || existing.rowCount === 0) {
    throw new Error(`Thought not found: ${id}`);
  }

  const merged = mergePreservedMetadata(existing.rows[0]!.metadata, metadata);

  const { rows, rowCount } = await pool.query<ThoughtRow>(
    `UPDATE thoughts
     SET content = $2, embedding = $3::vector, metadata = $4::jsonb
     WHERE id = $1
     RETURNING id, content, metadata, project, archived, supersedes, created_at`,
    [id, content, embeddingStr, JSON.stringify(merged)]
  );

  if (!rowCount || rowCount === 0) {
    throw new Error(`Thought not found: ${id}`);
  }

  return rows[0]!;
}

// ─── Delete ──────────────────────────────────────────────────────────

export async function deleteThought(
  pool: pg.Pool,
  id: string
): Promise<{ deleted: boolean; id: string }> {
  // Clear supersedes references pointing to this thought first
  await pool.query(
    `UPDATE thoughts SET supersedes = NULL WHERE supersedes = $1`,
    [id]
  );

  const { rowCount } = await pool.query(
    `DELETE FROM thoughts WHERE id = $1`,
    [id]
  );

  return { deleted: (rowCount ?? 0) > 0, id };
}

// ─── Search by Source / Provenance ───────────────────────────────────

export async function searchThoughtsBySource(
  pool: pg.Pool,
  source: string,
  options: {
    project?: string;
    created_by?: string;
    include_archived?: boolean;
    limit?: number;
  } = {}
): Promise<ThoughtRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  // Match on metadata.source OR metadata.provenance.origin
  idx++;
  conditions.push(
    `(metadata->>'source' = $${idx} OR metadata->'provenance'->>'origin' = $${idx})`
  );
  params.push(source);

  if (options.project) {
    idx++;
    conditions.push(`project = $${idx}`);
    params.push(options.project);
  }

  if (options.created_by) {
    idx++;
    conditions.push(`created_by = $${idx}`);
    params.push(options.created_by);
  }

  if (!options.include_archived) {
    conditions.push(`(archived = false OR archived IS NULL)`);
  }

  const limit = options.limit ?? 50;
  idx++;
  params.push(limit);

  const whereClause = conditions.join(" AND ");

  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, metadata, project, created_by, archived, supersedes, created_at
     FROM thoughts
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    params
  );

  return rows;
}

// ─── Batch Insert ────────────────────────────────────────────────────

export interface BatchThoughtInput {
  content: string;
  embedding: number[];
  metadata: ThoughtMetadata;
  project?: string;
  created_by?: string;
}

/**
 * RAW batch insert -- NO dedup. Prefer captureThoughts(). See insertThought's note.
 */
export async function batchInsertThoughts(
  pool: pg.Pool,
  thoughts: BatchThoughtInput[]
): Promise<ThoughtRow[]> {
  const client = await pool.connect();
  const results: ThoughtRow[] = [];

  try {
    await client.query("BEGIN");

    for (const thought of thoughts) {
      const embeddingStr = `[${thought.embedding.join(",")}]`;

      const { rows } = await client.query<ThoughtRow>(
        `INSERT INTO thoughts (content, embedding, metadata, project, created_by)
         VALUES ($1, $2::vector, $3::jsonb, $4, $5)
         RETURNING id, content, metadata, project, created_by, archived, supersedes, created_at`,
        [
          thought.content,
          embeddingStr,
          JSON.stringify(thought.metadata),
          thought.project ?? null,
          thought.created_by ?? null,
        ]
      );

      results.push(rows[0]!);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return results;
}


// --- Deduplicating capture (the front door) ------------------------

/**
 * Capture a thought, collapsing a retry of a recent identical capture onto the row it
 * would have duplicated.
 *
 * Returns the EXISTING row with deduplicated:true rather than erroring, so a client is
 * free to retry any timeout safely -- which is the whole point. Refusing the write would
 * have preserved the duplicate-avoidance while destroying the retry-safety it exists for.
 */
export async function captureThought(
  pool: pg.Pool,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  project?: string,
  supersedes?: string,
  created_by?: string,
  options: CaptureOptions = {}
): Promise<CaptureResult> {
  const hash = contentHash(content);
  const windowMinutes = options.dedupWindowMinutes ?? DEDUP_WINDOW_MINUTES;
  const proj = project ?? null;
  const by = created_by ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockOnHash(client, hash);

    const existing = await findDuplicate(client, hash, proj, by, windowMinutes, options.idempotencyKey);
    if (existing) {
      await client.query("COMMIT");
      return { row: existing, deduplicated: true };
    }

    const { rows } = await client.query<ThoughtRow>(
      `INSERT INTO thoughts (content, embedding, metadata, project, supersedes, created_by, idempotency_key)
       VALUES ($1, $2::vector, $3::jsonb, $4, $5, $6, $7)
       RETURNING ${RETURNING_COLS}`,
      [
        content,
        `[${embedding.join(",")}]`,
        JSON.stringify(metadata),
        proj,
        supersedes ?? null,
        by,
        options.idempotencyKey ?? null,
      ]
    );

    await client.query("COMMIT");
    return { row: rows[0]!, deduplicated: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Batch counterpart. Dedups PER ITEM, not per batch: the S275 evidence shows whole
 * batches retried wholesale (three duplicate pairs sharing one first-write timestamp),
 * and a partially-succeeded batch must converge on re-send rather than duplicating the
 * items that did land.
 *
 * One transaction and one advisory lock per item, taken in a STABLE order (sorted by
 * hash) so two concurrent overlapping batches cannot deadlock by grabbing the same two
 * locks in opposite orders.
 */
export async function captureThoughts(
  pool: pg.Pool,
  thoughts: BatchThoughtInput[],
  options: CaptureOptions = {}
): Promise<CaptureResult[]> {
  const windowMinutes = options.dedupWindowMinutes ?? DEDUP_WINDOW_MINUTES;
  const hashes = thoughts.map((t) => contentHash(t.content));
  const results: CaptureResult[] = new Array(thoughts.length);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const h of [...new Set(hashes)].sort()) {
      await lockOnHash(client, h);
    }

    for (let i = 0; i < thoughts.length; i++) {
      const t = thoughts[i]!;
      const proj = t.project ?? null;
      const by = t.created_by ?? null;

      const existing = await findDuplicate(client, hashes[i]!, proj, by, windowMinutes);
      if (existing) {
        results[i] = { row: existing, deduplicated: true };
        continue;
      }

      const { rows } = await client.query<ThoughtRow>(
        `INSERT INTO thoughts (content, embedding, metadata, project, created_by)
         VALUES ($1, $2::vector, $3::jsonb, $4, $5)
         RETURNING ${RETURNING_COLS}`,
        [t.content, `[${t.embedding.join(",")}]`, JSON.stringify(t.metadata), proj, by]
      );
      results[i] = { row: rows[0]!, deduplicated: false };
    }

    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
