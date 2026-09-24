-- Down-migration for 006.
--
-- *** THIS DESTROYS THE BACKFILL. *** Dropping these columns discards the 980
-- rows M1 parsed out of the tag lines at S278, including six values [HOFFA]
-- hand-ruled from evidence. Re-running the backfill would recover most of it
-- from the tag lines, which survive by ruling — but NOT the hand-rules, which
-- were judgment calls made against the live docs, not derivations.
--
-- Take a dump first. The S278 procedure is the standard: pg_dump -Fc, then
-- RESTORE it into a throwaway container and run a vector search against the
-- restored copy. `pg_restore` exiting 0 is not evidence a corpus is recoverable.

BEGIN;

DROP INDEX IF EXISTS thoughts_class_idx;
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_duplicate_of_fkey;
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_lesson_check;

ALTER TABLE thoughts
  DROP COLUMN IF EXISTS class,
  DROP COLUMN IF EXISTS lesson,
  DROP COLUMN IF EXISTS session,
  DROP COLUMN IF EXISTS incorporated_into,
  DROP COLUMN IF EXISTS duplicate_of;

COMMIT;
