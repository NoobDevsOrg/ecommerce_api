CREATE TABLE IF NOT EXISTS SHIPPING_POLICIES (
  tenant_id text PRIMARY KEY REFERENCES TENANTS(id) ON DELETE CASCADE,
  free_shipping_enabled boolean NOT NULL DEFAULT false,
  free_shipping_threshold_paise bigint,
  international_fallback_mode text NOT NULL DEFAULT 'CONTACT_US',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_shipping_policy_threshold CHECK (free_shipping_threshold_paise IS NULL OR free_shipping_threshold_paise >= 0),
  CONSTRAINT chk_shipping_policy_international_mode CHECK (international_fallback_mode = 'CONTACT_US')
);

CREATE TABLE IF NOT EXISTS SHIPPING_ZONES (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  name text NOT NULL,
  country_code text NOT NULL,
  state_name text,
  fulfillment_mode text NOT NULL DEFAULT 'FLAT',
  flat_rate_paise bigint,
  is_enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_shipping_zone_country CHECK (country_code = '*' OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT chk_shipping_zone_mode CHECK (fulfillment_mode IN ('FLAT', 'CONTACT_US')),
  CONSTRAINT chk_shipping_zone_rate CHECK ((fulfillment_mode = 'FLAT' AND flat_rate_paise IS NOT NULL AND flat_rate_paise >= 0) OR (fulfillment_mode = 'CONTACT_US' AND flat_rate_paise IS NULL)),
  CONSTRAINT uq_shipping_zones_tenant_name UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_shipping_zones_match ON SHIPPING_ZONES(tenant_id, is_enabled, country_code, priority);

-- The business-approved free-shipping threshold is a safe initial tenant
-- setting. Flat rates remain disabled until Support/Admin supplies them.
INSERT INTO SHIPPING_POLICIES (tenant_id, free_shipping_enabled, free_shipping_threshold_paise, international_fallback_mode)
SELECT id, true, 300000, 'CONTACT_US' FROM TENANTS
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS SHIPPING_AUDIT_EVENTS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  actor_user_id text,
  event_type text NOT NULL,
  zone_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipping_audit_events_tenant_created ON SHIPPING_AUDIT_EVENTS(tenant_id, created_at DESC);

-- Seed only non-priced, disabled placeholders. Rates require an authorized
-- business decision; disabled zones never become a silent free-shipping rule.
INSERT INTO SHIPPING_ZONES (id, tenant_id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority)
SELECT md5(id || ':shipping:tamil-nadu'), id, 'Tamil Nadu', 'IN', 'TAMIL NADU', 'FLAT', 0, false, 10 FROM TENANTS
ON CONFLICT (tenant_id, name) DO NOTHING;
INSERT INTO SHIPPING_ZONES (id, tenant_id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority)
SELECT md5(id || ':shipping:rest-india'), id, 'Rest of India', 'IN', NULL, 'FLAT', 0, false, 100 FROM TENANTS
ON CONFLICT (tenant_id, name) DO NOTHING;
INSERT INTO SHIPPING_ZONES (id, tenant_id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority)
SELECT md5(id || ':shipping:international'), id, 'International', '*', NULL, 'CONTACT_US', NULL, true, 1000 FROM TENANTS
ON CONFLICT (tenant_id, name) DO NOTHING;

-- Rollback only after checkout code has been rolled back and no longer reads
-- these records: DROP TABLE SHIPPING_AUDIT_EVENTS; DROP TABLE SHIPPING_ZONES;
-- DROP TABLE SHIPPING_POLICIES;
