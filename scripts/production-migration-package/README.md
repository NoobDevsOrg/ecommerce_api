# Production migration execution package

This package was derived from the successful `sagunthala_prod_clone` rehearsal. It does not contain database credentials and does not connect to a database until an operator provides `PRODUCTION_DATABASE_URL` to the PowerShell process.

## Apply list, in order

1. `20260921_add_address_tenant_customer_index.sql`
2. `20260922_add_customer_directory_index.sql`
3. `20260926_add_review_invitation_submission_uniqueness.sql`
4. `20260927_add_enquiry_customer_ownership.sql`
5. `20260928_add_auth_customer_uniqueness.sql`
6. `20260929_add_checkout_sessions.sql`
7. `20260930_add_checkout_email_verifications.sql`
8. `20261001_add_shipping_settings.sql`
9. `20261002_add_order_operations.sql`
10. `20261003_add_customer_auth_verifications.sql`
11. `20261004_add_inventory_transactions.sql`
12. `20261005_add_unified_notifications.sql`
13. `20261006_add_dashboard_aggregate_indexes.sql`
14. `20261007_add_audit_and_http_observability.sql`
15. `20261008_add_razorpay_webhook_events.sql`
16. `20261009_add_payment_reconciliations.sql`
17. `20261010_add_payment_attempt_events.sql`
18. `20261011_add_purchase_order_item_reviews.sql`
19. `20261012_add_homepage_testimonials.sql`
20. `20261013_refine_homepage_testimonials.sql`
21. `20261014_add_notification_delivery_audit.sql`
22. `20261015_add_enquiry_references.sql`

## Skip list: already represented in the rehearsed production snapshot

1. `20260830_allow_three_default_heroes.sql`
2. `20260919_add_customer_google_identity.sql`
3. `20260920_add_integration_configurations.sql`
4. `20260922_add_product_purchase_capabilities.sql`
5. `20260924_add_order_core_snapshots.sql`
6. `20260925_add_razorpay_payment_reconciliation.sql`

Do not add a skipped migration to the runner. The preflight checks that its schema effects are present and stops if the production state differs from the rehearsed manifest.

## Production procedure

1. Schedule a maintenance window and quiesce storefront checkout, payment callback processing, Razorpay webhook delivery/processing, background jobs, and admin writes. Do not allow legitimate new orders, payments, enquiries, or stock changes during baseline capture through postcheck.
2. Take and verify a fresh, restorable production database backup. Record its location in the change ticket.
3. On the approved deployment host, set `PRODUCTION_DATABASE_URL` only in that process environment. Do not commit it, put it in this package, or print it.
4. From this directory, run the read-only preflight for review:

   ```powershell
   & $env:PSQL_PATH -X -v ON_ERROR_STOP=1 -d $env:PRODUCTION_DATABASE_URL -f .\preflight.sql
   ```

   Or use the absolute `psql.exe` path. A preflight failure is a hard stop.
5. Run the runner only after the backup is confirmed:

   ```powershell
   .\run-production-migrations.ps1 -BackupConfirmed YES -PsqlPath 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
   ```

   The runner repeats preflight, captures production-current baselines, prints every filename, invokes `psql` with `ON_ERROR_STOP=1`, stops on the first failure, and runs postchecks automatically.
6. Attach the generated `production-baseline-*.json`, console output, backup reference, and postcheck output to the change record. The JSON contains counts only, not credentials.

## Stop and rollback conditions

Stop immediately; do not continue to a later migration when any of these occurs:

- backup is missing, unverified, or not known restorable;
- preflight reports a schema manifest mismatch or a data-precondition failure;
- any `psql` migration command exits non-zero;
- postcheck reports a missing table/index/constraint, baseline-count drift, malformed stock, duplicate enquiry reference, duplicate Razorpay ID, or duplicate SALE per order item;
- database lock/timeout, replication/connection issue, or unexpected application error occurs.

There is deliberately no automated schema rollback command. These migrations include data backfill, seeds, and constraint changes; blindly reversing them can lose or invalidate production data. Keep traffic quiesced, preserve the error output, and decide recovery using the verified backup and an approved restoration plan. Application rollback may return to the previously deployed compatible backend only after confirming the database changes remain backward-compatible.

## Backend and frontend deployment sequence

1. Keep the write paths and payment/webhook workers paused after a successful migration and postcheck.
2. Deploy the tested backend revision that contains the migrations' code paths. Wait for every backend instance to pass its health check.
3. Smoke-test backend read paths and protected admin health/authorization paths. Do not create a live payment.
4. Deploy the matching frontend revision only after backend health and smoke checks pass.
5. Smoke-test the storefront, product listing/detail, customer authentication, checkout start/resume, admin orders/payments/inventory, and homepage CMS content. Do not submit a live order.
6. Resume background jobs and Razorpay webhook processing, then re-enable storefront checkout and admin writes.
7. Monitor application errors, webhook processing, notification delivery, order creation, and inventory transactions through the first normal payment cycle. Re-run read-only postchecks if any migration-related alert appears.

