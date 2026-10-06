-- Preflight on the approved non-production database found zero duplicate
-- non-null AUTH.customer_id groups before this migration was authored.
-- A customer identity may have at most one AUTH identity.

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_customer_id
  ON AUTH(customer_id)
  WHERE customer_id IS NOT NULL;

-- Rollback (only after code no longer relies on this invariant):
-- DROP INDEX IF EXISTS uq_auth_customer_id;
