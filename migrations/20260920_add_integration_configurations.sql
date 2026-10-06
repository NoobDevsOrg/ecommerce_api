-- Tenant-scoped runtime configuration for explicit, code-registered integrations.
-- This table must not contain OAuth client secrets, API secrets, webhook secrets,
-- private keys, arbitrary URLs, executable code, or security-policy settings.
-- Rollback only after deploying code that no longer reads this table: drop the
-- table through the approved migration process.

CREATE TABLE IF NOT EXISTS INTEGRATION_CONFIGURATIONS (
    id            text PRIMARY KEY,
    tenant_id     text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
    provider_code text NOT NULL,
    is_enabled    boolean NOT NULL DEFAULT false,
    mode          text NOT NULL,
    safe_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text,
    UNIQUE (tenant_id, provider_code),
    CHECK (jsonb_typeof(safe_config) = 'object')
);
