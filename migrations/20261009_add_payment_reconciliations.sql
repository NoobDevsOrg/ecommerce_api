-- Durable, tenant-scoped operational cases for trusted payments that cannot
-- safely enter the normal PAID path. Do not retain raw provider payloads.
CREATE TABLE IF NOT EXISTS PAYMENT_RECONCILIATIONS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  payment_id text NOT NULL REFERENCES PAYMENTS(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES ORDERS(id) ON DELETE CASCADE,
  reason_code text NOT NULL CHECK (reason_code IN (
    'INSUFFICIENT_STOCK', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH',
    'PROVIDER_MAPPING_MISMATCH', 'UNKNOWN'
  )),
  reason_message_sanitized text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'ESCALATED')),
  resolution_type text CHECK (resolution_type IN ('RESOLVE_AFTER_RESTOCK', 'MANUAL_RESOLUTION', 'ESCALATE')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_reconciliation_payment UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_reconciliations_tenant_status_created
  ON PAYMENT_RECONCILIATIONS(tenant_id, status, created_at DESC, id DESC);
