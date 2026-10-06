-- Durable provider-event idempotency. A claim and its business mutation share
-- the payment transaction, so transient failures roll the claim back for retry.
CREATE TABLE IF NOT EXISTS PAYMENT_WEBHOOK_EVENTS (
  id text PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  provider_payment_id text,
  provider_order_id text,
  payment_id text REFERENCES PAYMENTS(id) ON DELETE SET NULL,
  order_id text REFERENCES ORDERS(id) ON DELETE SET NULL,
  processing_status text NOT NULL DEFAULT 'PROCESSED' CHECK (processing_status IN ('PROCESSED','IGNORED')),
  request_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT uq_payment_webhook_event UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_provider_created ON PAYMENT_WEBHOOK_EVENTS(provider, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_payment ON PAYMENT_WEBHOOK_EVENTS(payment_id, received_at DESC) WHERE payment_id IS NOT NULL;
