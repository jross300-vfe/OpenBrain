-- 006 — tag-line pseudo-fields promoted to real columns.
--
-- [HOFFA] ruled the scope (b), the full five, at S278 (2026-08-24) — see
-- claude-workshop Research/ob1-migration/schema-promotion-scope.md.
--
-- WHY: sessions were writing structured data INSIDE a string because the schema
-- had nowhere to put it — `landed:`, `incorporated:`, `session:`, and
-- `duplicate-of:`, which had already forked into two spellings. Four invented
-- fields, unsearchable except by substring, parsed by nothing. Renaming one
-- class meant a content-mode rewrite across every thought carrying it; with
-- `class` as a column it is one UPDATE.
--
-- *** THIS FILE IS THE DECLARATION OF A MIGRATION ALREADY APPLIED BY HAND ***
-- to ob1-postgres-phase1 at S278 (E1), and backfilled the same session (M1,
-- 980 rows). It is written here so the schema is reproducible from the repo —
-- the same "the data was safe, the runtime was undeclared" gap that
-- Tools/ob1-phase1/ closes for the containers. Every statement is guarded, so
-- running it against the already-migrated database is a no-op.

BEGIN;

ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS class             text,
  ADD COLUMN IF NOT EXISTS lesson            text,
  ADD COLUMN IF NOT EXISTS session           integer,
  ADD COLUMN IF NOT EXISTS incorporated_into text,
  ADD COLUMN IF NOT EXISTS duplicate_of      uuid;

-- SIX values. Not the five originally proposed, and not the "seven" the scope
-- document miscounted — the fourth miscount of this enum in 74 sessions, made
-- inside the document arguing the enum keeps being miscounted. Prose cannot
-- validate a value set; this constraint can.
--
-- A CHECK rather than a pg ENUM is deliberate: adding a value to an ENUM is a
-- DDL migration, and this vocabulary has moved four times. `obsolete` is NOT a
-- value — it maps to `retired` (ruled S278, 7 rows folded). NULL passes, because
-- 113 historical rows carry no tag line at all and NULL is the honest answer.
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_lesson_check;
ALTER TABLE thoughts
  ADD CONSTRAINT thoughts_lesson_check CHECK (
    lesson IS NULL OR lesson IN
      ('open','incorporated','duplicate','retired','converted','n/a')
  );

-- Self-referential. ON DELETE stays at NO ACTION on purpose: deleting a thought
-- that others cite as canonical must FAIL LOUDLY rather than silently orphan the
-- duplicates. S181 ruled duplicates are KEPT so the duplicate-rate signal stays
-- measurable, and ON DELETE SET NULL would quietly destroy exactly that signal.
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_duplicate_of_fkey;
ALTER TABLE thoughts
  ADD CONSTRAINT thoughts_duplicate_of_fkey
  FOREIGN KEY (duplicate_of) REFERENCES thoughts(id);

-- The reflection miner's query is `WHERE lesson='open' GROUP BY class`.
CREATE INDEX IF NOT EXISTS thoughts_class_idx ON thoughts(class);

COMMIT;
