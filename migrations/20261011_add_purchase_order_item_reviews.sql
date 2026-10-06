-- Purchase reviews are tied to immutable delivered ORDER_ITEMS. Existing
-- enquiry-invitation reviews remain valid and retain their current links.
ALTER TABLE product_reviews
  ALTER COLUMN enquiry_id DROP NOT NULL,
  ALTER COLUMN review_invitation_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS order_item_id text REFERENCES ORDER_ITEMS(id) ON DELETE RESTRICT;

-- An order item is the purchase entitlement. This is the final concurrency
-- boundary for customer review submission; invitation-origin rows stay NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_reviews_purchase_order_item
  ON product_reviews (tenant_id, order_item_id)
  WHERE order_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_reviews_purchase_order_item
  ON product_reviews (tenant_id, order_item_id, created_at DESC)
  WHERE order_item_id IS NOT NULL;

-- Rollback only after purchase-review code is no longer deployed:
-- DROP INDEX IF EXISTS idx_product_reviews_purchase_order_item;
-- DROP INDEX IF EXISTS uq_product_reviews_purchase_order_item;
-- ALTER TABLE product_reviews DROP COLUMN IF EXISTS order_item_id;
