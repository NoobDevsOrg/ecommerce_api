-- Immutable local evidence for provider/payment attempts. This deliberately
-- does not replace PAYMENTS or alter public payment APIs.
CREATE TABLE IF NOT EXISTS PAYMENT_ATTEMPT_EVENTS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  payment_id text NOT NULL REFERENCES PAYMENTS(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES ORDERS(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'PROVIDER_ORDER_ATTACHED',
    'VERIFY_PROVIDER_LOOKUP_FAILED',
    'PAYMENT_CAPTURED',
    'PAYMENT_FAILED'
  )),
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','UNKNOWN')),
  provider_order_id text,
  provider_payment_id text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_attempt_events_payment_created
  ON PAYMENT_ATTEMPT_EVENTS(tenant_id, payment_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payment_attempt_events_order_created
  ON PAYMENT_ATTEMPT_EVENTS(tenant_id, order_id, created_at DESC, id DESC);

-- Existing delivery fields are sufficient for bounded backoff and stale claim
-- recovery; this index covers the newly retryable PROCESSING state.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_retryable
  ON NOTIFICATION_DELIVERIES(tenant_id, status, updated_at, created_at)
  WHERE status IN ('PENDING','FAILED','PROCESSING');
