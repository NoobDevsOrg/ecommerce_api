-- Inventory V1: product stock is a durable, tenant-scoped ledger balance.
UPDATE PRODUCTS SET stock_qty = 0 WHERE stock_qty IS NULL;
ALTER TABLE PRODUCTS ALTER COLUMN stock_qty SET DEFAULT 0;
ALTER TABLE PRODUCTS ALTER COLUMN stock_qty SET NOT NULL;
ALTER TABLE PRODUCTS DROP CONSTRAINT IF EXISTS products_stock_qty_nonnegative;
ALTER TABLE PRODUCTS ADD CONSTRAINT products_stock_qty_nonnegative CHECK (stock_qty >= 0);

CREATE TABLE IF NOT EXISTS INVENTORY_TRANSACTIONS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES PRODUCTS(id),
  order_id text REFERENCES ORDERS(id) ON DELETE SET NULL,
  order_item_id text REFERENCES ORDER_ITEMS(id) ON DELETE SET NULL,
  transaction_type text NOT NULL,
  quantity_delta integer NOT NULL,
  before_quantity integer NOT NULL,
  after_quantity integer NOT NULL,
  reason text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (transaction_type IN ('SALE', 'ADMIN_RESTOCK', 'ADMIN_ADJUSTMENT')),
  CHECK (quantity_delta <> 0),
  CHECK (after_quantity >= 0),
  CHECK ((transaction_type = 'SALE' AND quantity_delta < 0) OR transaction_type <> 'SALE'),
  CHECK ((transaction_type = 'ADMIN_RESTOCK' AND quantity_delta > 0) OR transaction_type <> 'ADMIN_RESTOCK')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_sale_order_item
  ON INVENTORY_TRANSACTIONS(order_item_id)
  WHERE transaction_type = 'SALE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_idempotency
  ON INVENTORY_TRANSACTIONS(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_tenant_product_created
  ON INVENTORY_TRANSACTIONS(tenant_id, product_id, created_at DESC, id DESC);

-- A provider can be captured while stock has been exhausted. Keep that fact
-- explicit for staff rather than recording a false PAID sale or negative stock.
ALTER TABLE PAYMENTS DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE PAYMENTS ADD CONSTRAINT payments_status_check
  CHECK (status IN ('CREATED', 'PAID', 'FAILED', 'REFUNDED', 'REQUIRES_RECONCILIATION'));
ALTER TABLE ORDERS DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE ORDERS ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'REQUIRES_RECONCILIATION'));
