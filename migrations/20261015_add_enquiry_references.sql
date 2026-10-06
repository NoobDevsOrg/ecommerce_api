ALTER TABLE ENQUIRIES ADD COLUMN IF NOT EXISTS reference text;

UPDATE ENQUIRIES
SET reference = 'ENQ-' || upper(substr(md5(id::text), 1, 12))
WHERE reference IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ENQUIRIES WHERE reference IS NULL) THEN
    RAISE EXCEPTION 'Cannot set ENQUIRIES.reference NOT NULL while NULL references remain';
  END IF;
END $$;

ALTER TABLE ENQUIRIES ALTER COLUMN reference SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_enquiries_tenant_reference
  ON ENQUIRIES(tenant_id, reference);
