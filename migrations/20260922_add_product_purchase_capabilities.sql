-- Additive product commercial-capability flags. Existing products preserve
-- their current storefront actions by defaulting to both enabled. Public APIs
-- still suppress purchasable status unless price is a valid positive amount.
-- Rollback: after deploying code that no longer reads these fields, drop both
-- columns through the approved migration process.

ALTER TABLE PRODUCTS ADD COLUMN IF NOT EXISTS is_purchasable boolean NOT NULL DEFAULT true;
ALTER TABLE PRODUCTS ADD COLUMN IF NOT EXISTS is_enquiry_enabled boolean NOT NULL DEFAULT true;
