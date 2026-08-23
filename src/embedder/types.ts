/**
 * Shared types and interface for embedding providers.
 */

export type ThoughtType =
  | "observation"
  | "task"
  | "idea"
  | "reference"
  | "person_note"
  | "decision"
  | "meeting"
  | "architecture"
  | "pattern"
  | "postmortem"
  | "requirement"
  | "bug"
  | "convention";

export interface ThoughtMetadataExtracted {
  type: ThoughtType;
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
}

export const DEFAULT_METADATA: ThoughtMetadataExtracted = {
  type: "observation",
  topics: [],
  people: [],
  action_items: [],
  dates: [],
};

/**
 * Result of a cheap dependency liveness probe. `reachable: null` means NOT
 * PROBED -- never conflate it with `false`, which is a measured failure.
 */
export interface EmbedderPing {
  provider: string;
  reachable: boolean | null;
  ms: number | null;
  detail?: string;
}

export interface Embedder {
  /** Convert text to a vector embedding. */
  generateEmbedding(text: string): Promise<number[]>;

  /** Use an LLM to extract structured metadata from content. */
  extractMetadata(content: string): Promise<ThoughtMetadataExtracted>;

  /**
   * OPTIONAL cheap liveness probe of the backing service, for healthchecks.
   *
   * *** MUST NOT PERFORM INFERENCE AND MUST NOT COST MONEY. *** It runs every 30s
   * from a container HEALTHCHECK; a probe that bills per call, or that loads a
   * model, is a probe someone disables -- and a disabled healthcheck is worse
   * than a shallow one because it looks deliberate.
   *
   * A provider that has no free liveness endpoint returns reachable: null rather
   * than inventing one. NOT PROBED is an honest answer; a fabricated pass is not.
   */
  ping?(): Promise<EmbedderPing>;
}



export const METADATA_PROMPT = `Extract metadata from the following thought. Return JSON with:
- type: one of the following:
  - "observation" — General observations, notes, or musings
  - "task" — Action items, things to do
  - "idea" — Creative ideas, proposals, brainstorms
  - "reference" — Links, resources, documentation pointers
  - "person_note" — Notes about or from a specific person
  - "decision" — Choices made, options evaluated
  - "meeting" — Meeting notes, agendas, outcomes
  - "architecture" — System design decisions, layer choices, technology selection
  - "pattern" — Reusable code patterns, conventions, approaches
  - "postmortem" — Lessons learned, what went wrong, what to repeat
  - "requirement" — Functional or non-functional requirements
  - "bug" — Bug discoveries, root causes, fixes
  - "convention" — Naming, formatting, workflow conventions
- topics: array of 1-3 topic tags (lowercase, hyphenated)
- people: array of people mentioned (proper names)
- action_items: array of implied action items
- dates: array of dates mentioned (YYYY-MM-DD format)
Return ONLY valid JSON, no explanation.`;

// ─── Embedding validation (S275, task_1787400000011) ────────────────────────

/**
 * The dimensionality the corpus is built on. The `thoughts.embedding` column is
 * VECTOR(768), so a vector of any other length is rejected by Postgres anyway --
 * this exists to fail EARLIER and more legibly, and to catch the cases Postgres
 * cannot see (see below).
 */
export const EXPECTED_EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS ?? 768);

/**
 * Refuse an embedding that cannot do its job.
 *
 * *** WHY THIS EXISTS: A SUCCESS CARRYING NO EMBEDDING IS SILENT GARBAGE. ***
 * Measured live at S269:
 *   POST /api/embed {"model":"nomic-embed-text","prompt":"test"}
 *     -> 200 in 43ms, body {"model":"nomic-embed-text","embeddings":[]}
 * `prompt` is the OLD /api/embeddings field name; /api/embed wants `input`.
 * Sending the wrong one does NOT 400 -- it returns a cheerful 200 with an EMPTY
 * array. A 200 is what every client checks. A thought stored on the back of one
 * is PERMANENTLY UNFINDABLE BY SEARCH while appearing perfectly healthy in the
 * corpus, in the count, and in ops/ob1-graph. It would not reduce the corpus
 * count, would not fail a heartbeat, and would not trip ops-ob1.capability --
 * which probes that search WORKS, not that what was stored is searchable.
 *
 * *** TWO OF THE THREE EMBEDDERS COULD NOT CATCH IT. *** azure-openai and
 * openrouter both guarded with `if (!embedding)`, and an EMPTY ARRAY IS TRUTHY --
 * so `[]` sailed straight through. Only the ollama path checked length. That is
 * why this is one shared function rather than three hand-written checks.
 *
 * Checks, in order of how silently each fails:
 *   1. present and an array          -- a malformed body
 *   2. non-empty                     -- the S269 shape
 *   3. expected dimensionality       -- a model swap returning a different
 *      length. Postgres rejects it too, but AFTER the extraction round-trip, and
 *      with an error that names the column rather than the model.
 *   4. all entries finite numbers    -- *** THE ONE POSTGRES CANNOT SEE. *** A
 *      vector of NaN is a valid VECTOR(768) and inserts happily, then poisons
 *      every cosine comparison it takes part in. Nothing downstream would error.
 */
export function assertUsableEmbedding(
  embedding: unknown,
  context: { model: string; contentBytes: number; expectedDims?: number }
): number[] {
  const dims = context.expectedDims ?? EXPECTED_EMBEDDING_DIMS;
  const where = `model=${context.model}, content_bytes=${context.contentBytes}`;

  if (!Array.isArray(embedding)) {
    throw new Error(
      `Embedding provider returned no vector array (${where}) — refusing to store an unsearchable thought`
    );
  }
  if (embedding.length === 0) {
    throw new Error(
      `Embedding provider returned an EMPTY vector (${where}) — a 200 carrying no embedding; ` +
        `refusing to store a thought that would be permanently unfindable by search`
    );
  }
  if (embedding.length !== dims) {
    throw new Error(
      `Embedding has ${embedding.length} dimensions, expected ${dims} (${where}) — ` +
        `refusing to store; a dimensionality change corrupts vector comparisons rather than erroring`
    );
  }
  const badIndex = embedding.findIndex((v) => typeof v !== "number" || !Number.isFinite(v));
  if (badIndex !== -1) {
    throw new Error(
      `Embedding contains a non-finite value at index ${badIndex} (${where}) — ` +
        `refusing to store; NaN/Infinity is a valid VECTOR(${dims}) to Postgres and silently poisons every comparison`
    );
  }

  return embedding as number[];
}
