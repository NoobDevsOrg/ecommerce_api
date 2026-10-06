-- Additive index for tenant/customer-scoped address-management queries.
-- No data is changed. Rollback: DROP INDEX idx_addresses_tenant_customer_active
-- through the approved migration process.

CREATE INDEX IF NOT EXISTS idx_addresses_tenant_customer_active
ON ADDRESSES(tenant_id, customer_id, is_deleted, is_default DESC, updated_at DESC);
