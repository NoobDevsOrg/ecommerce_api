-- E-Commerce Multi-Tenant Database Schema
-- PostgreSQL 12+

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- TENANTS Table
CREATE TABLE TENANTS (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    brand_name      text,
    slug            text UNIQUE NOT NULL,
    domain          text UNIQUE,
    description     text,
    logo_url        text,
    currency        text DEFAULT 'INR',
    settings        jsonb DEFAULT '{}'::jsonb,
    is_active       boolean DEFAULT true,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

-- ROLES Table
CREATE TABLE ROLES (
    id            text PRIMARY KEY,
    tenant_id     text REFERENCES TENANTS(id) ON DELETE CASCADE,
    code          text NOT NULL,
    label         text,
    permissions   jsonb DEFAULT '[]'::jsonb,
    is_system     boolean DEFAULT false,
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now(),
    
    UNIQUE (tenant_id, code)
);

-- STAFF_USERS Table
CREATE TABLE STAFF_USERS (
    id                text PRIMARY KEY,
    tenant_id         text REFERENCES TENANTS(id) ON DELETE CASCADE,
    role_id           text REFERENCES ROLES(id),
    email             text NOT NULL,
    password_hash     text,
    full_name         text,
    phone             text,
    profile_image_url text,
    is_active         boolean DEFAULT true,
    last_login_at     timestamptz,
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now(),

    UNIQUE (tenant_id, email)
);

-- CUSTOMERS Table
CREATE TABLE CUSTOMERS (
    id              text PRIMARY KEY,
    tenant_id       text REFERENCES TENANTS(id) ON DELETE CASCADE,
    email           text NOT NULL,
    full_name       text,
    phone           text,
    avatar_url      text,
    date_of_birth   date,
    gender          text CHECK (gender IN ('male','female','other')),
    is_verified     boolean DEFAULT false,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),

    UNIQUE (tenant_id, email)
);

CREATE INDEX idx_customers_tenant_created_at
ON CUSTOMERS(tenant_id, created_at DESC, id DESC);

-- MASTER_OPTIONS Table
CREATE TABLE MASTER_OPTIONS (
    id            text PRIMARY KEY,
    type          text NOT NULL,
    code          text NOT NULL,
    label         text,
    parent_code   text,
    sort_order    int DEFAULT 0,
    is_active     boolean DEFAULT true,
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now(),

    UNIQUE (type, code)
);

CREATE INDEX idx_options_type_parent 
ON MASTER_OPTIONS(type, parent_code);

-- CATEGORIES Table
CREATE TABLE CATEGORIES (
    id            text PRIMARY KEY,
    tenant_id     text REFERENCES TENANTS(id) ON DELETE CASCADE,
    parent_id     text REFERENCES CATEGORIES(id),
    name          text NOT NULL,
    slug          text NOT NULL,
    description   text,
    image_url     text,
    banner_url    text,
    meta_title    text,
    meta_desc     text,
    sort_order    int DEFAULT 0,
    is_active     boolean DEFAULT true,
    created_at    timestamptz DEFAULT now(),
    created_by    text DEFAULT 'system',
    updated_at    timestamptz DEFAULT now(),
    updated_by    text DEFAULT 'system',

    UNIQUE (tenant_id, slug)
);

-- COLLECTIONS Table
CREATE TABLE COLLECTIONS (
    id            text PRIMARY KEY,
    tenant_id     text REFERENCES TENANTS(id) ON DELETE CASCADE,
    name          text NOT NULL,
    slug          text NOT NULL,
    description   text,
    image_url     text,
    banner_url    text,
    meta_title    text,
    meta_desc     text,
    is_active     boolean DEFAULT true,
    is_deleted    boolean DEFAULT false,
    is_featured   boolean DEFAULT false,
    sort_order    int DEFAULT 0,
    start_date    date,
    end_date      date,
    created_at    timestamptz DEFAULT now(),
    created_by    text DEFAULT 'system',
    updated_at    timestamptz DEFAULT now(),
    updated_by    text DEFAULT 'system',

    UNIQUE (tenant_id, slug),

    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX idx_collections_active 
ON COLLECTIONS(tenant_id, is_active, is_deleted, start_date, end_date);

-- PRODUCTS Table
CREATE TABLE PRODUCTS (
    id              text PRIMARY KEY,
    tenant_id       text REFERENCES TENANTS(id) ON DELETE CASCADE,
    category_id     text REFERENCES CATEGORIES(id),
    collection_id   text REFERENCES COLLECTIONS(id),
    name            text NOT NULL,
    slug            text NOT NULL,
    sku             text NOT NULL,
    description     text,
    price           numeric,
    compare_price   numeric,
    stock_qty       int NOT NULL DEFAULT 0,
    is_published    boolean DEFAULT false,
    is_featured     boolean DEFAULT false,
    is_purchasable  boolean NOT NULL DEFAULT true,
    is_enquiry_enabled boolean NOT NULL DEFAULT true,
    is_deleted      boolean DEFAULT false,
    sort_order      int DEFAULT 0,
    tags            text[],
    attributes      jsonb DEFAULT '{}'::jsonb,
    meta_title      text,
    meta_desc       text,
    created_at      timestamptz DEFAULT now(),
    created_by      text DEFAULT 'system',
    updated_at      timestamptz DEFAULT now(),
    updated_by      text DEFAULT 'system',

    UNIQUE (tenant_id, slug),
    UNIQUE (tenant_id, sku),
    CHECK (stock_qty >= 0)
);

CREATE INDEX idx_products_main 
ON PRODUCTS(tenant_id, is_deleted, is_published);

-- PRODUCT_IMAGES Table
CREATE TABLE PRODUCT_IMAGES (
    id            text PRIMARY KEY,
    tenant_id     text REFERENCES TENANTS(id) ON DELETE CASCADE,
    product_id    text REFERENCES PRODUCTS(id) ON DELETE CASCADE,
    public_id     text,
    base_url      text,
    alt_text      text,
    is_primary    boolean DEFAULT false,
    sort_order    int DEFAULT 0,
    created_at    timestamptz DEFAULT now(),
    created_by    text DEFAULT 'system',
    updated_at    timestamptz DEFAULT now(),
    updated_by    text DEFAULT 'system'
);

CREATE INDEX idx_product_images_product 
ON PRODUCT_IMAGES(product_id, sort_order);

CREATE UNIQUE INDEX uq_product_primary_image 
ON PRODUCT_IMAGES(product_id) 
WHERE is_primary = true;

-- ADDRESSES Table
CREATE TABLE ADDRESSES (
    id              text PRIMARY KEY,
    tenant_id       text REFERENCES TENANTS(id) ON DELETE CASCADE,
    customer_id     text REFERENCES CUSTOMERS(id) ON DELETE CASCADE,
    full_name       text,
    phone           text,
    line1           text NOT NULL,
    line2           text,
    landmark        text,
    city            text,
    state_code      text,
    country_code    text DEFAULT 'IN',
    pincode         text,
    address_type    text DEFAULT 'HOME',
    is_default      boolean DEFAULT false,
    is_deleted      boolean DEFAULT false,
    created_at      timestamptz DEFAULT now(),
    created_by      text DEFAULT 'system',
    updated_at      timestamptz DEFAULT now(),
    updated_by      text DEFAULT 'system',

    CHECK (address_type IN ('HOME','WORK','OTHER'))
);

CREATE INDEX idx_addresses_customer 
ON ADDRESSES(customer_id, is_deleted);

CREATE INDEX idx_addresses_tenant_customer_active
ON ADDRESSES(tenant_id, customer_id, is_deleted, is_default DESC, updated_at DESC);

CREATE UNIQUE INDEX uq_customer_default_address
ON ADDRESSES(customer_id)
WHERE is_default = true AND is_deleted = false;

-- ORDERS Table
CREATE TABLE ORDERS (
    id                      text PRIMARY KEY,
    tenant_id               text REFERENCES TENANTS(id) ON DELETE CASCADE,
    customer_id             text REFERENCES CUSTOMERS(id),
    shipping_address_id     text REFERENCES ADDRESSES(id),
    -- New order records store an immutable copy, rather than rendering later
    -- from the mutable saved-address record.
    shipping_address_snapshot jsonb,
    billing_address_id      text REFERENCES ADDRESSES(id),
    coupon_id               text,
    order_number            text NOT NULL,
    status                  text DEFAULT 'PENDING',
    payment_method          text,
    payment_status          text DEFAULT 'PENDING',
    subtotal                numeric DEFAULT 0,
    discount_amount         numeric DEFAULT 0,
    gst_amount              numeric DEFAULT 0,
    shipping_amount         numeric DEFAULT 0,
    total_amount            numeric NOT NULL,
    idempotency_key         text,
    idempotency_fingerprint text,
    currency                text DEFAULT 'INR',
    expected_delivery_date  date,
    notes                   text,
    cancelled_at            timestamptz,
    cancelled_reason        text,
    is_deleted              boolean DEFAULT false,
    created_at              timestamptz DEFAULT now(),
    created_by              text DEFAULT 'system',
    updated_at              timestamptz DEFAULT now(),
    updated_by              text DEFAULT 'system',

    UNIQUE (tenant_id, order_number),

    CHECK (status IN ('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED')),
    CHECK (payment_method IN ('UPI','CARD','NETBANKING','COD')),
    CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED','REQUIRES_RECONCILIATION')),
    CHECK (shipping_address_snapshot IS NULL OR jsonb_typeof(shipping_address_snapshot) = 'object')
);

CREATE INDEX idx_orders_main 
ON ORDERS(tenant_id, status, payment_status, created_at);

CREATE INDEX idx_orders_customer 
ON ORDERS(customer_id, created_at DESC);

CREATE UNIQUE INDEX uq_orders_tenant_customer_idempotency_key
ON ORDERS(tenant_id, customer_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_orders_tenant_customer_created_id
ON ORDERS(tenant_id, customer_id, created_at DESC, id DESC)
WHERE is_deleted = false;

-- ORDER_ITEMS Table
CREATE TABLE ORDER_ITEMS (
    id              text PRIMARY KEY,
    tenant_id       text REFERENCES TENANTS(id) ON DELETE CASCADE,
    order_id        text REFERENCES ORDERS(id) ON DELETE CASCADE,
    product_id      text REFERENCES PRODUCTS(id),
    product_name    text,
    product_sku     text,
    unit_price      numeric NOT NULL,
    quantity        int NOT NULL,
    line_subtotal   numeric,
    discount_amount numeric DEFAULT 0,
    image_url       text,
    notes           text,
    is_deleted      boolean DEFAULT false,
    created_at      timestamptz DEFAULT now(),
    created_by      text DEFAULT 'system',
    updated_at      timestamptz DEFAULT now(),
    updated_by      text DEFAULT 'system',

    CHECK (quantity > 0),
    CHECK (unit_price >= 0)
);

CREATE INDEX idx_order_items_order 
ON ORDER_ITEMS(order_id);

-- PAYMENTS Table
CREATE TABLE PAYMENTS (
    id                    text PRIMARY KEY,
    tenant_id             text REFERENCES TENANTS(id) ON DELETE CASCADE,
    order_id              text REFERENCES ORDERS(id) ON DELETE CASCADE,
    gateway               text DEFAULT 'RAZORPAY',
    razorpay_order_id     text,
    razorpay_payment_id   text,
    razorpay_signature    text,
    method                text,
    status                text DEFAULT 'CREATED',
    amount                numeric NOT NULL,
    currency              text DEFAULT 'INR',
    failure_reason        text,
    refund_id             text,
    refund_amount         numeric,
    refunded_at           timestamptz,
    paid_at               timestamptz,
    verified_at           timestamptz,
    provider_event_id     text,
    notes                 text,
    is_deleted            boolean DEFAULT false,
    created_at            timestamptz DEFAULT now(),
    created_by            text DEFAULT 'system',
    updated_at            timestamptz DEFAULT now(),
    updated_by            text DEFAULT 'system',

    CHECK (method IN ('UPI','CARD','NETBANKING','COD')),
    CHECK (status IN ('CREATED','PAID','FAILED','REFUNDED','REQUIRES_RECONCILIATION')),
    CHECK (amount >= 0)
);

CREATE INDEX idx_payments_order 
ON PAYMENTS(order_id);

CREATE INDEX idx_payments_status 
ON PAYMENTS(tenant_id, status, created_at);

-- Immutable local attempt evidence; PAYMENTS remains the current settlement
-- record for compatibility with existing payment APIs.
CREATE TABLE PAYMENT_ATTEMPT_EVENTS (
    id                    text PRIMARY KEY,
    tenant_id             text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
    payment_id            text NOT NULL REFERENCES PAYMENTS(id) ON DELETE CASCADE,
    order_id              text NOT NULL REFERENCES ORDERS(id) ON DELETE CASCADE,
    event_type            text NOT NULL CHECK (event_type IN ('PROVIDER_ORDER_ATTACHED','VERIFY_PROVIDER_LOOKUP_FAILED','PAYMENT_CAPTURED','PAYMENT_FAILED')),
    outcome               text NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','UNKNOWN')),
    provider_order_id     text,
    provider_payment_id   text,
    request_id            text,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_attempt_events_payment_created
ON PAYMENT_ATTEMPT_EVENTS(tenant_id, payment_id, created_at DESC, id DESC);
CREATE INDEX idx_payment_attempt_events_order_created
ON PAYMENT_ATTEMPT_EVENTS(tenant_id, order_id, created_at DESC, id DESC);

-- Durable in-app notification records and their channel-specific delivery outbox.
CREATE TABLE NOTIFICATIONS (
    id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
    audience_type text NOT NULL, customer_id text REFERENCES CUSTOMERS(id) ON DELETE CASCADE,
    staff_id text REFERENCES STAFF_USERS(id) ON DELETE CASCADE, recipient_key text NOT NULL,
    event_type text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
    title text NOT NULL, message text NOT NULL, action_url text, read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (audience_type IN ('CUSTOMER','ADMIN','SUPPORT')),
    CHECK ((audience_type = 'CUSTOMER' AND customer_id IS NOT NULL AND staff_id IS NULL) OR
      (audience_type IN ('ADMIN','SUPPORT') AND staff_id IS NOT NULL AND customer_id IS NULL)),
    UNIQUE (tenant_id, event_type, entity_type, entity_id, recipient_key)
);
CREATE INDEX idx_notifications_recipient_created ON NOTIFICATIONS(tenant_id, audience_type, customer_id, staff_id, created_at DESC, id DESC);
CREATE INDEX idx_notifications_unread ON NOTIFICATIONS(tenant_id, audience_type, customer_id, staff_id, created_at DESC) WHERE read_at IS NULL;
CREATE TABLE NOTIFICATION_DELIVERIES (
    id text PRIMARY KEY, notification_id text NOT NULL REFERENCES NOTIFICATIONS(id) ON DELETE CASCADE,
    tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE, channel text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0, last_error_code text,
    sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (channel IN ('EMAIL','WHATSAPP')), CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED')),
    UNIQUE (notification_id, channel)
);
CREATE INDEX idx_notification_deliveries_pending ON NOTIFICATION_DELIVERIES(tenant_id, status, created_at) WHERE status IN ('PENDING','FAILED');
CREATE INDEX idx_notification_deliveries_retryable ON NOTIFICATION_DELIVERIES(tenant_id, status, updated_at, created_at) WHERE status IN ('PENDING','FAILED','PROCESSING');

-- INVENTORY_TRANSACTIONS is the immutable source of stock movement history.
CREATE TABLE INVENTORY_TRANSACTIONS (
    id                text PRIMARY KEY,
    tenant_id         text REFERENCES TENANTS(id) ON DELETE CASCADE,
    product_id        text REFERENCES PRODUCTS(id),
    order_id          text REFERENCES ORDERS(id) ON DELETE SET NULL,
    order_item_id     text REFERENCES ORDER_ITEMS(id) ON DELETE SET NULL,
    transaction_type  text NOT NULL,
    quantity_delta    int NOT NULL,
    before_quantity   int NOT NULL,
    after_quantity    int NOT NULL,
    reason            text NOT NULL,
    actor_type        text NOT NULL,
    actor_id          text,
    idempotency_key   text,
    created_at        timestamptz DEFAULT now(),
    CHECK (transaction_type IN ('SALE','ADMIN_RESTOCK','ADMIN_ADJUSTMENT')),
    CHECK (quantity_delta <> 0),
    CHECK (after_quantity >= 0),
    CHECK ((transaction_type = 'SALE' AND quantity_delta < 0) OR transaction_type <> 'SALE'),
    CHECK ((transaction_type = 'ADMIN_RESTOCK' AND quantity_delta > 0) OR transaction_type <> 'ADMIN_RESTOCK')
);
CREATE UNIQUE INDEX uq_inventory_sale_order_item ON INVENTORY_TRANSACTIONS(order_item_id) WHERE transaction_type = 'SALE';
CREATE UNIQUE INDEX uq_inventory_idempotency ON INVENTORY_TRANSACTIONS(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_inventory_tenant_product_created ON INVENTORY_TRANSACTIONS(tenant_id, product_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX uq_paid_payment_per_order
ON PAYMENTS(order_id)
WHERE status = 'PAID';

CREATE UNIQUE INDEX uq_payments_razorpay_order_id
ON PAYMENTS(razorpay_order_id)
WHERE razorpay_order_id IS NOT NULL AND is_deleted = false;

CREATE UNIQUE INDEX uq_payments_razorpay_payment_id
ON PAYMENTS(razorpay_payment_id)
WHERE razorpay_payment_id IS NOT NULL AND is_deleted = false;

-- Operational cases for trusted payments that require a human decision before
-- they can enter the normal paid/fulfillment path. Provider payloads are not
-- stored here.
CREATE TABLE PAYMENT_RECONCILIATIONS (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
    payment_id text NOT NULL REFERENCES PAYMENTS(id) ON DELETE CASCADE,
    order_id text NOT NULL REFERENCES ORDERS(id) ON DELETE CASCADE,
    reason_code text NOT NULL CHECK (reason_code IN ('INSUFFICIENT_STOCK','AMOUNT_MISMATCH','CURRENCY_MISMATCH','PROVIDER_MAPPING_MISMATCH','UNKNOWN')),
    reason_message_sanitized text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','ESCALATED')),
    resolution_type text CHECK (resolution_type IN ('RESOLVE_AFTER_RESTOCK','MANUAL_RESOLUTION','ESCALATE')),
    resolution_note text,
    resolved_by text,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (payment_id)
);
CREATE INDEX idx_payment_reconciliations_tenant_status_created
ON PAYMENT_RECONCILIATIONS(tenant_id, status, created_at DESC, id DESC);


-- COUPONS Table
CREATE TABLE COUPONS (
    id                      text PRIMARY KEY,
    tenant_id               text REFERENCES TENANTS(id) ON DELETE CASCADE,
    code                    text NOT NULL,
    description             text,
    discount_type           text NOT NULL,
    discount_value          numeric NOT NULL,
    min_order_value         numeric DEFAULT 0,
    max_discount            numeric,
    max_uses                int,
    max_uses_per_user       int,
    used_count              int DEFAULT 0,
    applicable_category_id  text REFERENCES CATEGORIES(id),
    applicable_product_id   text REFERENCES PRODUCTS(id),
    is_active               boolean DEFAULT true,
    is_deleted              boolean DEFAULT false,
    starts_at               timestamptz,
    expires_at              timestamptz,
    created_at              timestamptz DEFAULT now(),
    created_by              text DEFAULT 'system',
    updated_at              timestamptz DEFAULT now(),
    updated_by              text DEFAULT 'system',

    UNIQUE (tenant_id, code),

    CHECK (discount_type IN ('FLAT','PERCENT')),
    CHECK (discount_value >= 0),
    CHECK (min_order_value >= 0),
    CHECK (max_discount IS NULL OR max_discount >= 0),
    CHECK (used_count >= 0),
    CHECK (
        expires_at IS NULL OR 
        starts_at IS NULL OR 
        expires_at >= starts_at
    )
);

CREATE INDEX idx_coupons_lookup 
ON COUPONS(tenant_id, code, is_active, is_deleted);

CREATE INDEX idx_coupons_active_window
ON COUPONS(tenant_id, starts_at, expires_at);

-- AUTH Table
CREATE TABLE AUTH (
    id                text PRIMARY KEY,
    tenant_id         text REFERENCES TENANTS(id) ON DELETE CASCADE,

    customer_id       text REFERENCES CUSTOMERS(id) ON DELETE CASCADE,
    staff_user_id     text REFERENCES STAFF_USERS(id) ON DELETE CASCADE,

    email             text NOT NULL,
    password_hash     text NOT NULL,
    google_subject    text,

    reset_token       text,
    reset_token_exp   timestamptz,

    last_login_at     timestamptz,
    failed_attempts   int DEFAULT 0,
    locked_until      timestamptz,

    is_active         boolean DEFAULT true,
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now(),

    -- Ensure only ONE type is linked
    CHECK (
        (customer_id IS NOT NULL AND staff_user_id IS NULL) OR
        (customer_id IS NULL AND staff_user_id IS NOT NULL)
    ),

    UNIQUE (tenant_id, email)
);

CREATE INDEX idx_auth_email 
ON AUTH(tenant_id, email);

CREATE INDEX idx_auth_lock 
ON AUTH(locked_until);

CREATE UNIQUE INDEX uq_auth_tenant_google_subject
ON AUTH(tenant_id, google_subject)
WHERE google_subject IS NOT NULL;

-- Runtime configuration for code-registered integrations. This table stores
-- only safe, non-secret settings; secrets remain in deployment secret storage.
CREATE TABLE INTEGRATION_CONFIGURATIONS (
    id            text PRIMARY KEY,
    tenant_id     text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
    provider_code text NOT NULL,
    is_enabled    boolean NOT NULL DEFAULT false,
    mode          text NOT NULL,
    safe_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text,
    UNIQUE (tenant_id, provider_code),
    CHECK (jsonb_typeof(safe_config) = 'object')
);

-- ORDER_STATUS_HISTORY Table
CREATE TABLE ORDER_STATUS_HISTORY (
    id              text PRIMARY KEY,
    tenant_id       text REFERENCES TENANTS(id) ON DELETE CASCADE,
    order_id        text REFERENCES ORDERS(id) ON DELETE CASCADE,
    from_status     text,
    to_status       text NOT NULL,
    notes           text,
    created_at      timestamptz DEFAULT now(),
    created_by      text DEFAULT 'system',

    CHECK (to_status IN ('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED'))
);

CREATE INDEX idx_order_status_history 
ON ORDER_STATUS_HISTORY(order_id, created_at);

-- Seed data (optional)
-- Insert test tenant
INSERT INTO TENANTS (id, name, slug, currency, is_active)
VALUES ('tenant-test', 'Test Store', 'teststore', 'INR', true)
ON CONFLICT DO NOTHING;
