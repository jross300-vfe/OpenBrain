/**
 * MCP Server for Open Brain.
 * Exposes eight tools: search_thoughts, list_thoughts, get_thought, capture_thought,
 * thought_stats, update_thought, delete_thought, capture_thoughts (batch).
 *
 * Uses the official @modelcontextprotocol/sdk TypeScript SDK.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getPool } from "../db/connection.js";
import {
  insertThought,
  searchThoughts,
  listThoughts,
  countThoughts,
  getThoughtById,
  getThoughtStats,
  updateThought,
  deleteThought,
  batchInsertThoughts,
  type ListFilters,
  type BatchThoughtInput,
} from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  formatWarnings,
  logWarnings,
} from "../api/validation.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMcpServer(): Server {
  const server = new Server(
    { name: "open-brain", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const embedder = getEmbedder();
  const pool = getPool();

  // ─── List Tools ──────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_thoughts",
        description:
          "Search your brain for thoughts semantically related to a query. Returns results ranked by similarity score. Supports project scoping and metadata filters.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: {
              type: "integer",
              description: "Maximum results to return (default: 10)",
              default: 10,
            },
            threshold: {
              type: "number",
              description: "Minimum similarity score 0-1 (default: 0.5)",
              default: 0.5,
            },
            project: {
              type: "string",
              description: "Scope search to a specific project",
            },
            type: {
              type: "string",
              description:
                "Filter by thought type: observation, task, idea, reference, person_note, decision, meeting, architecture, pattern, postmortem, requirement, bug, convention",
            },
            topic: {
              type: "string",
              description: "Filter by topic tag",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived thoughts (default: false)",
              default: false,
            },
            created_by: {
              type: "string",
              description: "Filter results to thoughts created by a specific user",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_thoughts",
        description:
          "List thoughts filtered by type, topic, person mentioned, project, or time range.",
        inputSchema: {
          type: "object" as const,
          properties: {
            type: {
              type: "string",
              description:
                "Filter by thought type: observation, task, idea, reference, person_note, decision, meeting, architecture, pattern, postmortem, requirement, bug, convention",
            },
            topic: {
              type: "string",
              description: "Filter by topic tag",
            },
            person: {
              type: "string",
              description: "Filter by person mentioned",
            },
            days: {
              type: "integer",
              description: "Only return thoughts from the last N days",
            },
            project: {
              type: "string",
              description: "Scope to a specific project",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived thoughts (default: false)",
              default: false,
            },
            created_by: {
              type: "string",
              description: "Filter results to thoughts created by a specific user",
            },
            limit: {
              type: "integer",
              description:
                "Maximum results per page (default: 50). Prefer small pages (10-25) on large corpora — full thought bodies are big, and oversized responses may overflow client-side buffers.",
              default: 50,
            },
            offset: {
              type: "integer",
              description:
                "Number of results to skip, for pagination (default: 0). Results are ordered most-recent-first; page with limit+offset until the returned count is less than limit, or use the total field.",
              default: 0,
            },
            tags_contain: {
              type: "string",
              description:
                "Case-insensitive substring filter against the FIRST line of content only (the canonical 'tags:' line), e.g. 'lesson:open'. Prose mentions of a tag deeper in the body do not match.",
            },
            minimal: {
              type: "boolean",
              description:
                "When true, return only id, created_at, and the first line of content (the tags: line) per thought — ~10x smaller payload. Use for enumeration, then fetch full bodies via get_thought.",
              default: false,
            },
          },
        },
      },
      {
        name: "get_thought",
        description:
          "Fetch a single thought by its UUID, returning the full content and metadata. Companion to list_thoughts minimal mode: enumerate cheaply, then fetch full bodies one at a time.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to fetch",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "capture_thought",
        description:
          "Save a new thought to your brain. Automatically generates embedding and extracts metadata (type, topics, people, action items). Supports project scoping and provenance tracking.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description: "The thought to capture (raw text)",
            },
            project: {
              type: "string",
              description: "Scope this thought to a project/workspace",
            },
            source: {
              type: "string",
              description: "Provenance tracking — where this thought came from (default: 'mcp')",
            },
            supersedes: {
              type: "string",
              description: "UUID of a prior thought this one replaces",
            },
            created_by: {
              type: "string",
              description: "User who created this thought (optional, for multi-developer provenance)",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "thought_stats",
        description:
          "Get statistics about your brain: total thoughts, type distribution, top topics, and top people mentioned. Optionally scoped to a project or user.",
        inputSchema: {
          type: "object" as const,
          properties: {
            project: {
              type: "string",
              description: "Scope stats to a specific project",
            },
            created_by: {
              type: "string",
              description: "Scope stats to a specific user",
            },
          },
        },
      },
      {
        name: "update_thought",
        description:
          "Update an existing thought. Provide `content` for a full-content update (re-generates embedding and re-extracts metadata), or `tags_line` to replace ONLY the first line of content (the canonical 'tags:' line) — the rest of the body and all metadata are left untouched (embedding is regenerated). Provenance metadata (source, provenance) always survives updates. Exactly one of content/tags_line is required.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to update",
            },
            content: {
              type: "string",
              description: "New full content for the thought (mutually exclusive with tags_line)",
            },
            tags_line: {
              type: "string",
              description:
                "Replacement for the first line of content only, e.g. flipping 'lesson:open' to 'lesson:incorporated' in the tags line. Body and metadata untouched. (mutually exclusive with content)",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "delete_thought",
        description:
          "Permanently delete a thought by ID. Deleted thoughts no longer appear in search or list results.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "capture_thoughts",
        description:
          "Batch capture multiple thoughts in one call. Each thought gets independent embedding and metadata extraction. All share the same project and source.",
        inputSchema: {
          type: "object" as const,
          properties: {
            thoughts: {
              type: "array",
              description: "Array of thoughts to capture",
              items: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description: "The thought content (raw text)",
                  },
                },
                required: ["content"],
              },
            },
            project: {
              type: "string",
              description: "Scope all thoughts to a project/workspace",
            },
            source: {
              type: "string",
              description: "Provenance tracking (default: 'mcp')",
            },
            created_by: {
              type: "string",
              description: "User who created these thoughts (optional, for multi-developer provenance)",
            },
          },
          required: ["thoughts"],
        },
      },
    ],
  }));

  // ─── Call Tool ───────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── search_thoughts ──
        case "search_thoughts": {
          const query = args?.query as string;
          const limit = (args?.limit as number) ?? 10;
          const threshold = (args?.threshold as number) ?? 0.5;
          const project = args?.project as string | undefined;
          const type = args?.type as string | undefined;
          const topic = args?.topic as string | undefined;
          const include_archived = (args?.include_archived as boolean) ?? false;
          const created_by = args?.created_by as string | undefined;

          // Build JSONB filter from type/topic
          const filter: Record<string, unknown> = {};
          if (type) filter.type = type;
          if (topic) filter.topics = [topic];

          const queryEmbedding = await embedder.generateEmbedding(query);
          const results = await searchThoughts(
            pool, queryEmbedding, limit, threshold, filter, project, include_archived, created_by
          );

          const formatted = results.map((r) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            similarity: Math.round(r.similarity * 1000) / 1000,
            created_at: r.created_at.toISOString(),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: formatted.length, results: formatted }, null, 2),
              },
            ],
          };
        }

        // ── list_thoughts ──
        case "list_thoughts": {
          const filters: ListFilters = {
            type: args?.type as string | undefined,
            topic: args?.topic as string | undefined,
            person: args?.person as string | undefined,
            days: args?.days as number | undefined,
            project: args?.project as string | undefined,
            created_by: args?.created_by as string | undefined,
            include_archived: (args?.include_archived as boolean) ?? false,
            tags_contain: args?.tags_contain as string | undefined,
          };

          const limit = Math.max(1, (args?.limit as number) ?? 50);
          const offset = Math.max(0, (args?.offset as number) ?? 0);
          const minimal = (args?.minimal as boolean) ?? false;

          const [results, total] = await Promise.all([
            listThoughts(pool, filters, limit, offset),
            countThoughts(pool, filters),
          ]);

          const formatted = results.map((r) =>
            minimal
              ? {
                  id: r.id,
                  tags_line: r.content.split("\n", 1)[0] ?? "",
                  created_at: r.created_at.toISOString(),
                }
              : {
                  id: r.id,
                  content: r.content,
                  metadata: r.metadata,
                  created_at: r.created_at.toISOString(),
                }
          );

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { count: formatted.length, total, offset, limit, results: formatted },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // ── get_thought ──
        case "get_thought": {
          const id = args?.id as string;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          const thought = await getThoughtById(pool, id);

          if (!thought) {
            return {
              content: [{ type: "text" as const, text: `Error: Thought not found: ${id}` }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    id: thought.id,
                    content: thought.content,
                    metadata: thought.metadata,
                    project: thought.project ?? null,
                    created_by: thought.created_by ?? null,
                    archived: thought.archived ?? false,
                    supersedes: thought.supersedes ?? null,
                    created_at: thought.created_at.toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // ── capture_thought ──
        case "capture_thought": {
          let input;
          try {
            input = validateCaptureInput(args ?? {}, { defaultSource: "mcp" });
          } catch (err) {
            if (err instanceof CaptureValidationError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          // Generate embedding and extract metadata in parallel
          const [embedding, autoMetadata] = await Promise.all([
            embedder.generateEmbedding(input.content),
            embedder.extractMetadata(input.content),
          ]);

          const fullMetadata = { ...autoMetadata, ...input.metadata, source: input.source };
          const result = await insertThought(
            pool, input.content, embedding, fullMetadata, input.project, input.supersedes, input.created_by
          );

          logWarnings(input.warnings, {
            transport: "mcp",
            source: input.source,
            project: input.project,
            created_by: input.created_by,
          });

          const captureContent: { type: "text"; text: string }[] = [];
          if (input.warnings.length > 0) {
            captureContent.push({ type: "text" as const, text: formatWarnings(input.warnings) });
          }
          captureContent.push({
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "captured",
                id: result.id,
                type: (fullMetadata.type as string | undefined) ?? autoMetadata.type,
                topics: (fullMetadata.topics as string[] | undefined) ?? autoMetadata.topics,
                people: (fullMetadata.people as string[] | undefined) ?? autoMetadata.people,
                action_items: autoMetadata.action_items,
                captured_at: result.created_at.toISOString(),
                warnings: input.warnings,
              },
              null,
              2
            ),
          });

          return { content: captureContent };
        }

        // ── thought_stats ──
        case "thought_stats": {
          const project = args?.project as string | undefined;
          const created_by = args?.created_by as string | undefined;
          const stats = await getThoughtStats(pool, project, created_by);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        // ── update_thought ──
        case "update_thought": {
          const id = args?.id as string;
          const content = args?.content as string | undefined;
          const tagsLine = args?.tags_line as string | undefined;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          if ((content === undefined) === (tagsLine === undefined)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: provide exactly one of content or tags_line",
                },
              ],
              isError: true,
            };
          }

          let result;
          let responseType: string | undefined;
          let responseTopics: string[] | undefined;
          let mode: string;

          if (tagsLine !== undefined) {
            // Tag-only update: splice the first line, keep body + metadata as-is.
            // No metadata re-extraction — a tag flip must never disturb
            // type/topics/source/provenance. Embedding is regenerated because
            // content (including the tags line) is what got embedded.
            if (tagsLine.trim().length === 0 || tagsLine.includes("\n")) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: tags_line must be a non-empty single line",
                  },
                ],
                isError: true,
              };
            }

            const thought = await getThoughtById(pool, id);
            if (!thought) {
              return {
                content: [{ type: "text" as const, text: `Error: Thought not found: ${id}` }],
                isError: true,
              };
            }

            const newlineIdx = thought.content.indexOf("\n");
            const body = newlineIdx === -1 ? "" : thought.content.slice(newlineIdx);
            const newContent = tagsLine + body;

            const embedding = await embedder.generateEmbedding(newContent);
            result = await updateThought(pool, id, newContent, embedding, thought.metadata);
            responseType = thought.metadata?.type;
            responseTopics = thought.metadata?.topics;
            mode = "tags_line";
          } else {
            // Full-content update: re-generate embedding and re-extract metadata.
            // updateThought carries source + provenance over from the existing row.
            const [embedding, metadata] = await Promise.all([
              embedder.generateEmbedding(content!),
              embedder.extractMetadata(content!),
            ]);

            result = await updateThought(pool, id, content!, embedding, metadata);
            responseType = metadata.type;
            responseTopics = metadata.topics;
            mode = "content";
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "updated",
                    mode,
                    id: result.id,
                    type: responseType,
                    topics: responseTopics,
                    source: result.metadata?.source ?? null,
                    updated_at: result.created_at.toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // ── delete_thought ──
        case "delete_thought": {
          const id = args?.id as string;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          const result = await deleteThought(pool, id);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // ── capture_thoughts (batch) ──
        case "capture_thoughts": {
          let batch;
          try {
            batch = validateBatchInput(args ?? {}, { defaultSource: "mcp" });
          } catch (err) {
            if (err instanceof CaptureValidationError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          // Process each item: embed + extract metadata + merge with caller metadata
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

          const results = await batchInsertThoughts(pool, processed);

          for (const w of batch.warnings) {
            console.warn(
              `[ingest-warning] ${JSON.stringify({
                transport: "mcp",
                scope: "batch-envelope",
                field: w.field,
                reason: w.reason,
                message: w.message,
              })}`,
            );
          }
          for (const item of batch.items) {
            logWarnings(item.warnings, {
              transport: "mcp",
              source: item.source,
              project: item.project,
              created_by: item.created_by,
            });
          }

          const formatted = results.map((r, i) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            captured_at: r.created_at.toISOString(),
            warnings: batch.items[i]?.warnings ?? [],
          }));

          const totalItemWarnings = formatted.reduce((n, f) => n + f.warnings.length, 0);
          const batchContent: { type: "text"; text: string }[] = [];
          if (batch.warnings.length > 0 || totalItemWarnings > 0) {
            const lines: string[] = [];
            if (batch.warnings.length > 0) {
              lines.push(formatWarnings(batch.warnings).replace(/^\u26a0\ufe0f.*\n/, "\u26a0\ufe0f Batch envelope:\n"));
            }
            formatted.forEach((f, i) => {
              if (f.warnings.length > 0) {
                lines.push(`\u26a0\ufe0f thoughts[${i}]:\n${formatWarnings(f.warnings).split("\n").slice(1).join("\n")}`);
              }
            });
            batchContent.push({ type: "text" as const, text: lines.join("\n\n") });
          }
          batchContent.push({
            type: "text" as const,
            text: JSON.stringify(
              {
                count: formatted.length,
                envelope_warnings: batch.warnings,
                results: formatted,
              },
              null,
              2
            ),
          });

          return { content: batchContent };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcp] Tool "${name}" failed:`, message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the MCP server on stdio transport.
 * Used when running as a standalone MCP process (e.g., `npx open-brain-mcp`).
 */
export async function startMcpStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Server running on stdio transport");
}
