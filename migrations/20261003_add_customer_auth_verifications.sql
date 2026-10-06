CREATE TABLE IF NOT EXISTS CUSTOMER_AUTH_VERIFICATIONS (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id),
  purpose text NOT NULL,
  normalized_email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  send_count integer NOT NULL DEFAULT 1,
  attempt_count integer NOT NULL DEFAULT 0,
  resend_available_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_customer_auth_verification_purpose CHECK (purpose IN ('CUSTOMER_LOGIN', 'PASSWORD_RESET')),
  CONSTRAINT chk_customer_auth_verification_hash CHECK (char_length(code_hash) = 64),
  CONSTRAINT chk_customer_auth_verification_sends CHECK (send_count BETWEEN 1 AND 5),
  CONSTRAINT chk_customer_auth_verification_attempts CHECK (attempt_count BETWEEN 0 AND 5)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_auth_verifications_active
  ON CUSTOMER_AUTH_VERIFICATIONS(tenant_id, purpose, normalized_email) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customer_auth_verifications_lookup
  ON CUSTOMER_AUTH_VERIFICATIONS(tenant_id, purpose, normalized_email, updated_at DESC);
