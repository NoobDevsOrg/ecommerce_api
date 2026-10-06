-- Phase B: optional authenticated-customer ownership for enquiries.
-- Existing guest and historical enquiries remain valid with customer_id NULL.
-- Apply only through the approved migration process; application code never
-- executes this migration.

ALTER TABLE ENQUIRIES
  ADD COLUMN IF NOT EXISTS customer_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'enquiries'::regclass
      AND conname = 'fk_enquiries_customer_id'
  ) THEN
    ALTER TABLE ENQUIRIES
      ADD CONSTRAINT fk_enquiries_customer_id
      FOREIGN KEY (customer_id)
      REFERENCES CUSTOMERS(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Supports tenant/customer-scoped history without indexing legacy guest rows.
CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_customer_created_at
  ON ENQUIRIES (tenant_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

-- Rollback (only after application compatibility is confirmed):
-- DROP INDEX IF EXISTS idx_enquiries_tenant_customer_created_at;
-- ALTER TABLE ENQUIRIES DROP CONSTRAINT IF EXISTS fk_enquiries_customer_id;
-- ALTER TABLE ENQUIRIES DROP COLUMN IF EXISTS customer_id;
