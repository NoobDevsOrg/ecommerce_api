-- P0 Order Core: additive only. Do not execute without an approved migration
-- window for the confirmed non-production environment, then production.
-- Existing orders remain readable; new Order Core records populate all fields.

ALTER TABLE ORDERS
  ADD COLUMN IF NOT EXISTS shipping_address_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

ALTER TABLE ORDER_ITEMS
  ADD COLUMN IF NOT EXISTS line_subtotal numeric;

ALTER TABLE ORDERS
  ADD CONSTRAINT chk_orders_shipping_address_snapshot_object
  CHECK (shipping_address_snapshot IS NULL OR jsonb_typeof(shipping_address_snapshot) = 'object');

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_tenant_customer_idempotency_key
  ON ORDERS(tenant_id, customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_customer_created_id
  ON ORDERS(tenant_id, customer_id, created_at DESC, id DESC)
  WHERE is_deleted = false;

-- Rollback (only if no Order Core order depends on the columns):
-- DROP INDEX IF EXISTS idx_orders_tenant_customer_created_id;
-- DROP INDEX IF EXISTS uq_orders_tenant_customer_idempotency_key;
-- ALTER TABLE ORDERS DROP CONSTRAINT IF EXISTS chk_orders_shipping_address_snapshot_object;
-- ALTER TABLE ORDER_ITEMS DROP COLUMN IF EXISTS line_subtotal;
-- ALTER TABLE ORDERS DROP COLUMN IF EXISTS idempotency_fingerprint,
--   DROP COLUMN IF EXISTS idempotency_key,
--   DROP COLUMN IF EXISTS shipping_address_snapshot;
