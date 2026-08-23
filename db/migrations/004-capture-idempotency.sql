-- Migration 004: Capture idempotency — content_hash + windowed dedup lookup.
--
-- WHY: a client timeout on capture does NOT cancel the server write. The row is
-- committed, the client sees MCP -32001, and a retry writes a SECOND copy. Measured
-- on the live corpus at S275: all five uncontaminated exact-duplicate groups are
-- pairs written 39-98 SECONDS apart, byte-identical, three of them sharing one
-- first-write timestamp (a capture_thoughts batch retried wholesale).
--
-- The duplicate is not merely wasted disk. It competes for a TOP-N RETRIEVAL SLOT
-- at the SAME similarity as its canonical twin, so every pair silently halves the
-- diversity available to any query they both match -- and the reader cannot see it:
-- two near-identical hits read as corroboration rather than one hit counted twice.
--
-- DELIBERATELY NOT A UNIQUE CONSTRAINT ON content_hash. Permanent uniqueness would
-- forbid ever legitimately re-capturing the same text, which is a different and
-- worse failure. The WINDOW is what separates "retry" from "deliberate"; it lives in
-- application code (DEDUP_WINDOW_MINUTES), not in the schema, because it is a policy
-- judgement and not an invariant.

BEGIN;

-- A. Generated column. GENERATED rather than app-populated on purpose: it is correct
--    for all pre-existing rows the moment it lands, and it CANNOT drift from content.
ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS content_hash TEXT
    GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED;

-- B. Lookup index for the dedup probe. Composite on the scope the probe filters by,
--    created_at DESC so the window scan hits the newest candidate first.
CREATE INDEX IF NOT EXISTS idx_thoughts_content_hash_scope
  ON thoughts (content_hash, project, created_by, created_at DESC);

-- C. Optional client-supplied idempotency key. Belt to the content-hash braces: a
--    caller that CAN reuse a key across a retry gets exact semantics regardless of
--    the window. Nullable + partial unique, so rows without a key are unconstrained.
ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_idempotency_key
  ON thoughts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
