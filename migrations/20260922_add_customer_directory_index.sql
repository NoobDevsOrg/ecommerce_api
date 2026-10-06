-- Supports tenant-scoped newest-first customer-directory pages.
-- Apply through the approved migration process; rollback is DROP INDEX
-- idx_customers_tenant_created_at only after confirming no active release uses it.
CREATE INDEX IF NOT EXISTS idx_customers_tenant_created_at
ON CUSTOMERS(tenant_id, created_at DESC, id DESC);
