-- Post-purchase operations. Additive only; do not execute without an approved
-- deployment window. Existing immutable order/item/payment snapshots remain untouched.
ALTER TABLE ORDERS
  ADD COLUMN IF NOT EXISTS courier_name text,
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS tracking_url text,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

ALTER TABLE ORDER_STATUS_HISTORY
  ADD COLUMN IF NOT EXISTS actor_type text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ORDER_STATUS_HISTORY
  ADD CONSTRAINT chk_order_status_history_actor_type
  CHECK (actor_type IS NULL OR actor_type IN ('CUSTOMER', 'STAFF', 'SYSTEM'));

CREATE INDEX IF NOT EXISTS idx_orders_tenant_created_id
  ON ORDERS(tenant_id, created_at DESC, id DESC)
  WHERE is_deleted = false;

CREATE TABLE IF NOT EXISTS ORDER_NOTIFICATION_DELIVERIES (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES ORDERS(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_order_notification_delivery UNIQUE (tenant_id, order_id, event_type),
  CONSTRAINT chk_order_notification_delivery_event CHECK (event_type IN ('PAYMENT_CONFIRMED', 'SHIPPED', 'DELIVERED')),
  CONSTRAINT chk_order_notification_delivery_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_order_notification_deliveries_pending
  ON ORDER_NOTIFICATION_DELIVERIES(tenant_id, status, created_at)
  WHERE status IN ('PENDING', 'FAILED');

-- Rollback after code rollback only:
-- DROP TABLE ORDER_NOTIFICATION_DELIVERIES;
-- DROP INDEX idx_orders_tenant_created_id;
-- ALTER TABLE ORDER_STATUS_HISTORY DROP CONSTRAINT IF EXISTS chk_order_status_history_actor_type,
--   DROP COLUMN IF EXISTS metadata, DROP COLUMN IF EXISTS actor_type;
-- ALTER TABLE ORDERS DROP COLUMN IF EXISTS dispatched_at, DROP COLUMN IF EXISTS tracking_url,
--   DROP COLUMN IF EXISTS tracking_number, DROP COLUMN IF EXISTS courier_name;
