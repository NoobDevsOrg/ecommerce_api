-- Passwordless checkout email verification. This is scoped to the temporary
-- checkout workflow and does not replace normal customer authentication.
CREATE TABLE IF NOT EXISTS CHECKOUT_EMAIL_VERIFICATIONS (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES TENANTS(id),
  checkout_session_id uuid NOT NULL REFERENCES CHECKOUT_SESSIONS(id) ON DELETE CASCADE,
  email_normalized    text NOT NULL,
  code_hash           text NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  send_count          integer NOT NULL DEFAULT 1,
  attempt_count       integer NOT NULL DEFAULT 0,
  next_resend_at      timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_checkout_email_verifications_session UNIQUE (checkout_session_id),
  CONSTRAINT chk_checkout_email_verifications_hash CHECK (char_length(code_hash) = 64),
  CONSTRAINT chk_checkout_email_verifications_send_count CHECK (send_count BETWEEN 1 AND 5),
  CONSTRAINT chk_checkout_email_verifications_attempt_count CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT chk_checkout_email_verifications_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_checkout_email_verifications_tenant_email_recent
  ON CHECKOUT_EMAIL_VERIFICATIONS(tenant_id, email_normalized, updated_at DESC);

-- Rollback (only after application code no longer references this table):
-- DROP INDEX IF EXISTS idx_checkout_email_verifications_tenant_email_recent;
-- DROP TABLE IF EXISTS CHECKOUT_EMAIL_VERIFICATIONS;
