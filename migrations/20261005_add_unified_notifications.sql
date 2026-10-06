-- Unified notifications: durable, tenant-scoped in-app records plus a channel-ready outbox.
-- ORDER_NOTIFICATION_DELIVERIES remains only for historical records created before this migration.
CREATE TABLE IF NOT EXISTS NOTIFICATIONS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  audience_type text NOT NULL,
  customer_id text REFERENCES CUSTOMERS(id) ON DELETE CASCADE,
  staff_id text REFERENCES STAFF_USERS(id) ON DELETE CASCADE,
  recipient_key text NOT NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  action_url text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notifications_audience CHECK (audience_type IN ('CUSTOMER','ADMIN','SUPPORT')),
  CONSTRAINT chk_notifications_recipient CHECK (
    (audience_type = 'CUSTOMER' AND customer_id IS NOT NULL AND staff_id IS NULL) OR
    (audience_type IN ('ADMIN','SUPPORT') AND staff_id IS NOT NULL AND customer_id IS NULL)
  ),
  CONSTRAINT uq_notifications_event_recipient UNIQUE (tenant_id, event_type, entity_type, entity_id, recipient_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
  ON NOTIFICATIONS(tenant_id, audience_type, customer_id, staff_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON NOTIFICATIONS(tenant_id, audience_type, customer_id, staff_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS NOTIFICATION_DELIVERIES (
  id text PRIMARY KEY,
  notification_id text NOT NULL REFERENCES NOTIFICATIONS(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_delivery_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_notification_delivery_status CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED')),
  CONSTRAINT uq_notification_delivery_channel UNIQUE (notification_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
  ON NOTIFICATION_DELIVERIES(tenant_id, status, created_at)
  WHERE status IN ('PENDING','FAILED');
