-- Rollback Migration 004: remove capture-idempotency columns and indexes.
-- Safe: content_hash is GENERATED (derivable at any time) and idempotency_key is
-- advisory. Dropping them loses no information that content itself does not carry.

BEGIN;
DROP INDEX IF EXISTS idx_thoughts_idempotency_key;
DROP INDEX IF EXISTS idx_thoughts_content_hash_scope;
ALTER TABLE thoughts DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE thoughts DROP COLUMN IF EXISTS content_hash;
COMMIT;
