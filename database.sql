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
    stock_qty       int DEFAULT 0,
    is_published    boolean DEFAULT false,
    is_featured     boolean DEFAULT false,
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
    UNIQUE (tenant_id, sku)
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

CREATE UNIQUE INDEX uq_customer_default_address
ON ADDRESSES(customer_id)
WHERE is_default = true AND is_deleted = false;

-- ORDERS Table
CREATE TABLE ORDERS (
    id                      text PRIMARY KEY,
    tenant_id               text REFERENCES TENANTS(id) ON DELETE CASCADE,
    customer_id             text REFERENCES CUSTOMERS(id),
    shipping_address_id     text REFERENCES ADDRESSES(id),
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
    CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED'))
);

CREATE INDEX idx_orders_main 
ON ORDERS(tenant_id, status, payment_status, created_at);

CREATE INDEX idx_orders_customer 
ON ORDERS(customer_id, created_at DESC);

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
    notes                 text,
    is_deleted            boolean DEFAULT false,
    created_at            timestamptz DEFAULT now(),
    created_by            text DEFAULT 'system',
    updated_at            timestamptz DEFAULT now(),
    updated_by            text DEFAULT 'system',

    CHECK (method IN ('UPI','CARD','NETBANKING','COD')),
    CHECK (status IN ('CREATED','PAID','FAILED','REFUNDED')),
    CHECK (amount >= 0)
);

CREATE INDEX idx_payments_order 
ON PAYMENTS(order_id);

CREATE INDEX idx_payments_status 
ON PAYMENTS(tenant_id, status, created_at);

CREATE UNIQUE INDEX uq_paid_payment_per_order
ON PAYMENTS(order_id)
WHERE status = 'PAID';

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
