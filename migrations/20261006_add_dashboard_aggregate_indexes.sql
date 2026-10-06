-- Dashboard V1 reads tenant-scoped, date-bounded aggregates. ORDERS,
-- PAYMENTS, and CUSTOMERS already have matching tenant/date indexes; these
-- indexes cover the remaining aggregate joins without changing data shape.
CREATE INDEX IF NOT EXISTS idx_order_items_tenant_order_active
  ON ORDER_ITEMS (tenant_id, order_id)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_status_created
  ON ENQUIRIES (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_reviews_tenant_created
  ON product_reviews (tenant_id, created_at DESC);

-- Rollback only after confirming Dashboard V1 is no longer deployed:
-- DROP INDEX IF EXISTS idx_order_items_tenant_order_active;
-- DROP INDEX IF EXISTS idx_enquiries_tenant_status_created;
-- DROP INDEX IF EXISTS idx_product_reviews_tenant_created;
