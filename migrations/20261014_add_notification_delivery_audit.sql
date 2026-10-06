ALTER TABLE NOTIFICATIONS
  ADD COLUMN IF NOT EXISTS content_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS NOTIFICATION_DELIVERY_ATTEMPTS (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES NOTIFICATION_DELIVERIES(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('PROCESSING','SENT','FAILED')),
  safe_error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_delivery_attempt UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_delivery
  ON NOTIFICATION_DELIVERY_ATTEMPTS(delivery_id, attempt_number ASC);
