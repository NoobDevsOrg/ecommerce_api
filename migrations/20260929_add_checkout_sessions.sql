-- Progressive Checkout foundation. CHECKOUT_SESSIONS is temporary workflow
-- state, not a permanent customer/contact identity model. Resume and start
-- idempotency credentials are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS CHECKOUT_SESSIONS (
  id                      uuid PRIMARY KEY,
  tenant_id               text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  resume_token_hash       text NOT NULL,
  start_idempotency_hash  text NOT NULL,
  state                   text NOT NULL DEFAULT 'STARTED',
  email_normalized        text,
  customer_id             text REFERENCES CUSTOMERS(id) ON DELETE SET NULL,
  cart_draft              jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_draft           jsonb NOT NULL DEFAULT '{}'::jsonb,
  address_draft           jsonb,
  expires_at              timestamptz NOT NULL,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_checkout_sessions_state
    CHECK (state IN ('STARTED', 'CONTACT_CAPTURED', 'DETAILS_CAPTURED', 'IDENTITY_REQUIRED', 'IDENTITY_VERIFIED', 'COMPLETED', 'EXPIRED')),
  CONSTRAINT chk_checkout_sessions_cart_draft_array
    CHECK (jsonb_typeof(cart_draft) = 'array'),
  CONSTRAINT chk_checkout_sessions_contact_draft_object
    CHECK (jsonb_typeof(contact_draft) = 'object'),
  CONSTRAINT chk_checkout_sessions_address_draft_object
    CHECK (address_draft IS NULL OR jsonb_typeof(address_draft) = 'object'),
  CONSTRAINT chk_checkout_sessions_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT chk_checkout_sessions_completed_at
    CHECK (
      (state = 'COMPLETED' AND completed_at IS NOT NULL)
      OR (state <> 'COMPLETED' AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_sessions_resume_token_hash
  ON CHECKOUT_SESSIONS(resume_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_sessions_tenant_start_idempotency
  ON CHECKOUT_SESSIONS(tenant_id, start_idempotency_hash);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_tenant_expiry
  ON CHECKOUT_SESSIONS(tenant_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_tenant_customer_active
  ON CHECKOUT_SESSIONS(tenant_id, customer_id, updated_at DESC)
  WHERE customer_id IS NOT NULL AND completed_at IS NULL AND state <> 'EXPIRED';

-- Rollback (only after dependent application code is removed):
-- DROP INDEX IF EXISTS idx_checkout_sessions_tenant_customer_active;
-- DROP INDEX IF EXISTS idx_checkout_sessions_tenant_expiry;
-- DROP INDEX IF EXISTS uq_checkout_sessions_tenant_start_idempotency;
-- DROP INDEX IF EXISTS uq_checkout_sessions_resume_token_hash;
-- DROP TABLE IF EXISTS CHECKOUT_SESSIONS;
