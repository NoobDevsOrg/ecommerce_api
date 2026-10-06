\set ON_ERROR_STOP on
\if :{?baseline_products}
\else
  \echo 'Missing baseline_products. Run through run-production-migrations.ps1.'
  \quit 3
\endif
\if :{?baseline_customers}
\else
  \echo 'Missing baseline_customers. Run through run-production-migrations.ps1.'
  \quit 3
\endif
\if :{?baseline_orders}
\else
  \echo 'Missing baseline_orders. Run through run-production-migrations.ps1.'
  \quit 3
\endif
\if :{?baseline_order_items}
\else
  \echo 'Missing baseline_order_items. Run through run-production-migrations.ps1.'
  \quit 3
\endif
\if :{?baseline_payments}
\else
  \echo 'Missing baseline_payments. Run through run-production-migrations.ps1.'
  \quit 3
\endif
\if :{?baseline_enquiries}
\else
  \echo 'Missing baseline_enquiries. Run through run-production-migrations.ps1.'
  \quit 3
\endif
\if :{?baseline_pending_confirmed_orders}
\else
  \echo 'Missing baseline_pending_confirmed_orders. Run through run-production-migrations.ps1.'
  \quit 3
\endif

DO $postverify$
DECLARE
  missing_tables text;
  missing_indexes integer;
  missing_constraints integer;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO missing_tables
  FROM (VALUES
    ('checkout_sessions'), ('checkout_email_verifications'), ('shipping_policies'), ('shipping_zones'), ('shipping_audit_events'),
    ('order_notification_deliveries'), ('customer_auth_verifications'), ('inventory_transactions'), ('notifications'), ('notification_deliveries'),
    ('audit_events'), ('http_request_logs'), ('payment_webhook_events'), ('payment_reconciliations'), ('payment_attempt_events'),
    ('homepage_testimonial_settings'), ('homepage_testimonials'), ('notification_delivery_attempts')
  ) required(name)
  WHERE to_regclass('public.' || name) IS NULL;
  IF missing_tables IS NOT NULL THEN RAISE EXCEPTION 'Postcheck failed: missing tables: %', missing_tables; END IF;

  SELECT count(*) INTO missing_indexes
  FROM (VALUES
    ('idx_addresses_tenant_customer_active'), ('idx_customers_tenant_created_at'), ('uq_product_reviews_review_invitation'), ('idx_enquiries_tenant_customer_created_at'), ('uq_auth_customer_id'),
    ('uq_checkout_sessions_resume_token_hash'), ('uq_checkout_sessions_tenant_start_idempotency'), ('idx_checkout_sessions_tenant_expiry'), ('idx_checkout_sessions_tenant_customer_active'), ('idx_checkout_email_verifications_tenant_email_recent'),
    ('idx_shipping_zones_match'), ('idx_shipping_audit_events_tenant_created'), ('idx_orders_tenant_created_id'), ('idx_order_notification_deliveries_pending'),
    ('uq_customer_auth_verifications_active'), ('idx_customer_auth_verifications_lookup'), ('uq_inventory_sale_order_item'), ('uq_inventory_idempotency'), ('idx_inventory_tenant_product_created'),
    ('idx_notifications_recipient_created'), ('idx_notifications_unread'), ('idx_notification_deliveries_pending'), ('idx_order_items_tenant_order_active'), ('idx_enquiries_tenant_status_created'), ('idx_product_reviews_tenant_created'),
    ('idx_audit_events_tenant_created'), ('idx_audit_events_entity'), ('idx_audit_events_request'), ('idx_audit_events_actor'), ('idx_http_logs_tenant_created'), ('idx_http_logs_request'), ('idx_http_logs_status_created'),
    ('idx_payment_webhook_events_provider_created'), ('idx_payment_webhook_events_payment'), ('idx_payment_reconciliations_tenant_status_created'), ('idx_payment_attempt_events_payment_created'), ('idx_payment_attempt_events_order_created'), ('idx_notification_deliveries_retryable'),
    ('uq_product_reviews_purchase_order_item'), ('idx_product_reviews_purchase_order_item'), ('idx_homepage_testimonials_tenant_active_order'), ('idx_notification_delivery_attempts_delivery'), ('uq_enquiries_tenant_reference')
  ) expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = expected.name);
  IF missing_indexes <> 0 THEN RAISE EXCEPTION 'Postcheck failed: % expected indexes are missing', missing_indexes; END IF;

  SELECT count(*) INTO missing_constraints
  FROM (VALUES
    ('fk_enquiries_customer_id'), ('chk_order_status_history_actor_type'), ('products_stock_qty_nonnegative'), ('payments_status_check'), ('orders_payment_status_check'),
    ('uq_payment_webhook_event'), ('uq_payment_reconciliation_payment'), ('uq_notification_delivery_attempt'), ('uq_notifications_event_recipient'), ('uq_notification_delivery_channel')
  ) expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = expected.name);
  IF missing_constraints <> 0 THEN RAISE EXCEPTION 'Postcheck failed: % expected constraints are missing', missing_constraints; END IF;

  IF EXISTS (SELECT 1 FROM products WHERE stock_qty IS NULL OR stock_qty < 0) THEN RAISE EXCEPTION 'Postcheck failed: NULL or negative stock'; END IF;
  IF EXISTS (SELECT 1 FROM (SELECT tenant_id, reference FROM enquiries GROUP BY 1,2 HAVING count(*) > 1) duplicates) THEN RAISE EXCEPTION 'Postcheck failed: duplicate enquiry references'; END IF;
  IF EXISTS (SELECT 1 FROM (SELECT razorpay_order_id FROM payments WHERE razorpay_order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) duplicates)
     OR EXISTS (SELECT 1 FROM (SELECT razorpay_payment_id FROM payments WHERE razorpay_payment_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) duplicates) THEN
    RAISE EXCEPTION 'Postcheck failed: duplicate Razorpay provider IDs';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT order_item_id FROM inventory_transactions WHERE transaction_type = 'SALE' GROUP BY order_item_id HAVING count(*) > 1) duplicates) THEN
    RAISE EXCEPTION 'Postcheck failed: duplicate SALE rows for an order item';
  END IF;
END
$postverify$;

-- psql substitutes the execution-time baseline variables in this ordinary SQL
-- statement (not within the dollar-quoted DO block above), then \if enforces
-- the invariant without relying on clone snapshot counts.
WITH baseline AS (
  SELECT
    :'baseline_products'::bigint AS products,
    :'baseline_customers'::bigint AS customers,
    :'baseline_orders'::bigint AS orders,
    :'baseline_order_items'::bigint AS order_items,
    :'baseline_payments'::bigint AS payments,
    :'baseline_enquiries'::bigint AS enquiries,
    :'baseline_pending_confirmed_orders'::bigint AS pending_confirmed_orders
), actual AS (
  SELECT
    (SELECT count(*) FROM products) AS products,
    (SELECT count(*) FROM customers) AS customers,
    (SELECT count(*) FROM orders) AS orders,
    (SELECT count(*) FROM order_items) AS order_items,
    (SELECT count(*) FROM payments) AS payments,
    (SELECT count(*) FROM enquiries) AS enquiries,
    (SELECT count(*) FROM orders WHERE payment_status = 'PENDING' AND status = 'CONFIRMED') AS pending_confirmed_orders
)
SELECT (actual.products = baseline.products
        AND actual.customers = baseline.customers
        AND actual.orders = baseline.orders
        AND actual.order_items = baseline.order_items
        AND actual.payments = baseline.payments
        AND actual.enquiries = baseline.enquiries
        AND actual.pending_confirmed_orders = baseline.pending_confirmed_orders)::text AS baseline_counts_match
FROM baseline CROSS JOIN actual
\gset
\if :baseline_counts_match
\else
  \echo 'Postcheck failed: baseline counts changed during the migration window.'
  \quit 3
\endif

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
  (SELECT count(*) FROM (SELECT tenant_id, reference FROM enquiries GROUP BY 1,2 HAVING count(*) > 1) duplicates) AS duplicate_enquiry_references,
  (SELECT count(*) FROM (SELECT order_item_id FROM inventory_transactions WHERE transaction_type = 'SALE' GROUP BY 1 HAVING count(*) > 1) duplicates) AS duplicate_sale_order_items;
