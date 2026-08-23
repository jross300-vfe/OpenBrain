-- Migration 005: refuse a NULL embedding at the DB level.
--
-- Companion to assertUsableEmbedding() in src/embedder/types.ts (S275,
-- task_1787400000011). The application guard is the primary defence and gives the
-- legible error; this is the belt to its braces, and it covers paths the guard
-- cannot see -- a raw insertThought(), a bulk import, a future code path.
--
-- WHAT WAS ALREADY COVERED, so this migration stays narrow: the column is
-- VECTOR(768), and pgvector REJECTS a wrong-dimension insert on its own. The
-- dimension half of the task's "NOT NULL + dimension constraint" therefore
-- already exists and is not re-declared here.
--
-- WHAT NEITHER LAYER COVERS, recorded rather than assumed away: a vector of NaN
-- is a perfectly valid VECTOR(768) and inserts happily, then poisons every cosine
-- comparison it takes part in. Postgres cannot see it. Only the application guard
-- can, which is why that guard checks finiteness and why this constraint is not a
-- substitute for it.
--
-- SAFE ON THE LIVE CORPUS: verified 986/986 rows non-null immediately before
-- applying. The scan is trivial at this size. Reversible via the .down.

BEGIN;

ALTER TABLE thoughts
  ALTER COLUMN embedding SET NOT NULL;

COMMIT;
