-- Audit Trail + Request/Response Observability V1. These tables are deliberately
-- separate: immutable business history has different retention and access needs
-- from short-lived operational diagnostics.
CREATE TABLE IF NOT EXISTS AUDIT_EVENTS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_type text NOT NULL,
  actor_id text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_id text,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_audit_event_version UNIQUE (tenant_id, entity_type, entity_id, version)
);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created ON AUDIT_EVENTS(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON AUDIT_EVENTS(tenant_id, entity_type, entity_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_request ON AUDIT_EVENTS(tenant_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON AUDIT_EVENTS(tenant_id, actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUDIT_EVENTS are immutable'; END; $$;
DROP TRIGGER IF EXISTS audit_events_immutable ON AUDIT_EVENTS;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON AUDIT_EVENTS
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE TABLE IF NOT EXISTS HTTP_REQUEST_LOGS (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  tenant_id text REFERENCES TENANTS(id) ON DELETE SET NULL,
  actor_type text,
  actor_id text,
  method text NOT NULL,
  route text NOT NULL,
  status_code integer NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  request_body_sanitized jsonb,
  response_body_sanitized jsonb,
  error_code text,
  ip_address text,
  user_agent text,
  storage_mode text NOT NULL DEFAULT 'INLINE' CHECK (storage_mode IN ('INLINE','ARCHIVED','OFFLOAD_FAILED')),
  storage_object_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_http_logs_tenant_created ON HTTP_REQUEST_LOGS(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_http_logs_request ON HTTP_REQUEST_LOGS(request_id);
CREATE INDEX IF NOT EXISTS idx_http_logs_status_created ON HTTP_REQUEST_LOGS(status_code, created_at DESC);

-- Provision a private `system-logs` Supabase Storage bucket through deployment.
-- The application never creates public URLs for archived observability data.
