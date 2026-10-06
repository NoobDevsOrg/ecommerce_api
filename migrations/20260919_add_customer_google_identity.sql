-- Additive customer-authentication migration.
-- Do not run this file manually against production outside the approved migration process.
-- Rollback requires a backend version that no longer reads or writes google_subject;
-- then drop this index before dropping the column through the approved process.

ALTER TABLE AUTH
ADD COLUMN IF NOT EXISTS google_subject text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_tenant_google_subject
ON AUTH(tenant_id, google_subject)
WHERE google_subject IS NOT NULL;
