\set ON_ERROR_STOP on

-- Read-only production preflight. Run immediately before the migration runner.
-- It deliberately validates the clone-rehearsed starting state. A mismatch means
-- stop and rebuild the manifest; do not selectively rerun migrations.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
BEGIN
  -- Migrations represented before this rollout must still be represented.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'auth' AND column_name = 'google_subject')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_auth_tenant_google_subject')
     OR to_regclass('public.integration_configurations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_purchasable')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_enquiry_enabled')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'shipping_address_snapshot')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'line_subtotal')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'provider_event_id')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_payments_razorpay_order_id')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_payments_razorpay_payment_id')
  THEN
    RAISE EXCEPTION 'Manifest mismatch: a migration marked as already represented is not present';
  END IF;

  -- The runner must only be used from the rehearsed pre-migration state.
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
       'idx_addresses_tenant_customer_active', 'idx_customers_tenant_created_at',
       'uq_product_reviews_review_invitation', 'uq_auth_customer_id',
       'uq_enquiries_tenant_reference'
     ))
     OR to_regclass('public.checkout_sessions') IS NOT NULL
     OR to_regclass('public.shipping_policies') IS NOT NULL
     OR to_regclass('public.inventory_transactions') IS NOT NULL
     OR to_regclass('public.notifications') IS NOT NULL
     OR to_regclass('public.payment_webhook_events') IS NOT NULL
     OR to_regclass('public.payment_reconciliations') IS NOT NULL
     OR to_regclass('public.payment_attempt_events') IS NOT NULL
     OR to_regclass('public.homepage_testimonials') IS NOT NULL
     OR to_regclass('public.notification_delivery_attempts') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'enquiries' AND column_name = 'reference')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_status_history' AND column_name IN ('actor_type', 'metadata'))
  THEN
    RAISE EXCEPTION 'Manifest mismatch: one or more apply-list migration effects already exist; stop and rebuild the manifest';
  END IF;

  -- Data preconditions for UNIQUE, FK, NOT NULL, CHECK, and backfill migrations.
  IF EXISTS (SELECT 1 FROM (SELECT customer_id FROM auth WHERE customer_id IS NOT NULL GROUP BY customer_id HAVING count(*) > 1) duplicates) THEN
    RAISE EXCEPTION 'Preflight failed: duplicate AUTH.customer_id values';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT tenant_id, customer_id, idempotency_key FROM orders WHERE customer_id IS NOT NULL AND idempotency_key IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1) duplicates) THEN
    RAISE EXCEPTION 'Preflight failed: duplicate order idempotency keys';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT review_invitation_id FROM product_reviews WHERE review_invitation_id IS NOT NULL GROUP BY review_invitation_id HAVING count(*) > 1) duplicates) THEN
    RAISE EXCEPTION 'Preflight failed: duplicate product-review invitation submissions';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE stock_qty IS NULL OR stock_qty < 0) THEN
    RAISE EXCEPTION 'Preflight failed: PRODUCTS.stock_qty contains NULL or negative values';
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE shipping_address_snapshot IS NOT NULL AND jsonb_typeof(shipping_address_snapshot) <> 'object') THEN
    RAISE EXCEPTION 'Preflight failed: invalid shipping-address snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT 'ENQ-' || upper(substr(md5(id::text), 1, 12)) AS reference FROM enquiries GROUP BY 1 HAVING count(*) > 1) duplicates) THEN
    RAISE EXCEPTION 'Preflight failed: generated enquiry-reference collision';
  END IF;
END
$preflight$;

-- Record these values in the change ticket. They are execution-time baselines,
-- not expected clone values. The runner captures the same values automatically.
SELECT
  (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM customers) AS customers,
  (SELECT count(*) FROM orders) AS orders,
  (SELECT count(*) FROM order_items) AS order_items,
  (SELECT count(*) FROM payments) AS payments,
  (SELECT count(*) FROM enquiries) AS enquiries,
  (SELECT count(*) FROM orders WHERE payment_status = 'PENDING' AND status = 'CONFIRMED') AS pending_confirmed_orders,
  (SELECT count(*) FROM products WHERE stock_qty IS NULL) AS null_stock,
  (SELECT count(*) FROM products WHERE stock_qty < 0) AS negative_stock,
  (SELECT count(*) FROM (SELECT razorpay_order_id FROM payments WHERE razorpay_order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) duplicate_razorpay_order_ids) AS duplicate_razorpay_order_ids,
  (SELECT count(*) FROM (SELECT razorpay_payment_id FROM payments WHERE razorpay_payment_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) duplicate_razorpay_payment_ids);

COMMIT;
