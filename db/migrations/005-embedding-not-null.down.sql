-- Rollback Migration 005: allow a NULL embedding again.
-- Note this restores the ability to store an unsearchable thought; it exists for
-- reversibility, not because a NULL embedding is ever desirable.

BEGIN;
ALTER TABLE thoughts
  ALTER COLUMN embedding DROP NOT NULL;
COMMIT;
