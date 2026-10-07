const crypto = require('crypto');
const pool = require('../../config/db');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../utils/errors');
const notifications = require('./orderNotification.service');
const audit = require('../../services/audit.service');
const { requirePricedShipping } = require('../checkout/shipping.service');

// This is intentionally an explicit, small fulfillment model. The current
// database CHECK constraints do not permit PACKED or OUT_FOR_DELIVERY, so those
// states are not persisted until that legacy constraint has an approved change.
const ORDER_STATUSES = Object.freeze(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']);
const STATUS_TRANSITIONS = Object.freeze({
  CONFIRMED: ['PROCESSING'],
  PROCESSING: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
});

const toCents = (value, field) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new ValidationError(`Trusted ${field} is invalid`);
  }
  return Math.round(numeric * 100);
};

const centsToDecimal = (cents) => (cents / 100).toFixed(2);
const toPublicMoney = (value) => Number(value || 0);
const GST_RATE_BASIS_POINTS = 300;
const calculateGstCents = (subtotalCents) => Math.floor((subtotalCents * GST_RATE_BASIS_POINTS + 5000) / 10000);

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const makeFingerprint = (payload) => crypto
  .createHash('sha256')
  .update(stableStringify(payload))
  .digest('hex');

const generateOrderNumber = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const entropy = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  return `SGN-${date}-${entropy}`;
};

const normalizeAddressSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ValidationError('Trusted delivery address snapshot is required');
  }

  const fields = ['fullName', 'phone', 'addressLine1', 'city', 'state', 'pincode', 'country'];
  for (const field of fields) {
    if (typeof snapshot[field] !== 'string' || !snapshot[field].trim()) {
      throw new ValidationError('Trusted delivery address snapshot is invalid');
    }
  }

  return {
    sourceAddressId: typeof snapshot.sourceAddressId === 'string' ? snapshot.sourceAddressId : null,
    fullName: snapshot.fullName.trim(),
    phone: snapshot.phone.trim(),
    addressLine1: snapshot.addressLine1.trim(),
    addressLine2: typeof snapshot.addressLine2 === 'string' && snapshot.addressLine2.trim() ? snapshot.addressLine2.trim() : null,
    landmark: typeof snapshot.landmark === 'string' && snapshot.landmark.trim() ? snapshot.landmark.trim() : null,
    city: snapshot.city.trim(),
    state: snapshot.state.trim(),
    pincode: snapshot.pincode.trim(),
    country: snapshot.country.trim().toUpperCase(),
  };
};

const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new ValidationError('Trusted order items are required');
  }

  const productIds = new Set();
  return items.map((item) => {
    if (!item || typeof item.productId !== 'string' || !item.productId
      || typeof item.productName !== 'string' || !item.productName.trim()
      || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0) {
      throw new ValidationError('Trusted order item is invalid');
    }
    if (productIds.has(item.productId)) {
      throw new ValidationError('Trusted order contains duplicate products');
    }
    productIds.add(item.productId);

    const unitPriceCents = toCents(item.unitPrice, 'item price');
    const lineSubtotalCents = toCents(item.lineSubtotal, 'item subtotal');
    if (lineSubtotalCents !== unitPriceCents * Number(item.quantity)) {
      throw new ValidationError('Trusted item subtotal does not match its price and quantity');
    }
    return {
      productId: item.productId,
      productName: item.productName.trim(),
      productSku: typeof item.productSku === 'string' && item.productSku.trim() ? item.productSku.trim() : null,
      imageUrl: typeof item.imageUrl === 'string' && item.imageUrl.trim() ? item.imageUrl.trim() : null,
      quantity: Number(item.quantity),
      unitPriceCents,
      lineSubtotalCents,
    };
  });
};

const normalizeMonetaryBreakdown = (breakdown, items) => {
  if (!breakdown || typeof breakdown !== 'object') {
    throw new ValidationError('Trusted monetary breakdown is required');
  }
  const subtotalCents = toCents(breakdown.subtotal, 'subtotal');
  const discountCents = toCents(breakdown.discountAmount || 0, 'discount amount');
  const taxCents = toCents(breakdown.taxAmount || 0, 'tax amount');
  const shippingCents = toCents(breakdown.shippingAmount || 0, 'shipping amount');
  const totalCents = toCents(breakdown.total, 'total');
  const itemSubtotalCents = items.reduce((sum, item) => sum + item.lineSubtotalCents, 0);

  if (subtotalCents !== itemSubtotalCents || totalCents !== subtotalCents - discountCents + taxCents + shippingCents) {
    throw new ValidationError('Trusted monetary breakdown is inconsistent');
  }

  return { subtotalCents, discountCents, taxCents, shippingCents, totalCents };
};

const normalizeTrustedOrder = (input) => {
  if (!input || typeof input !== 'object'
    || typeof input.tenantId !== 'string' || !input.tenantId
    || typeof input.customerId !== 'string' || !input.customerId
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()
    || input.idempotencyKey.trim().length > 128) {
    throw new ValidationError('Trusted order request is invalid');
  }

  const items = normalizeItems(input.items);
  const shippingAddressSnapshot = normalizeAddressSnapshot(input.shippingAddressSnapshot);
  const monetary = normalizeMonetaryBreakdown(input.monetary, items);
  const idempotencyKey = input.idempotencyKey.trim();
  const fingerprint = makeFingerprint({ items, shippingAddressSnapshot, monetary });
  return {
    tenantId: input.tenantId,
    customerId: input.customerId,
    requestId: typeof input.requestId === 'string' ? input.requestId : null,
    idempotencyKey,
    fingerprint,
    items,
    shippingAddressSnapshot,
    monetary,
  };
};

const idempotencyQuery = `SELECT id, order_number, idempotency_fingerprint
  FROM ORDERS
  WHERE tenant_id = $1 AND customer_id = $2 AND idempotency_key = $3`;

const resolveExistingOrder = (row, fingerprint) => {
  if (!row) return null;
  if (row.idempotency_fingerprint !== fingerprint) {
    throw new ConflictError('This request identity was already used for a different order');
  }
  return { id: row.id, orderNumber: row.order_number, reused: true };
};

const findExistingOrder = async (client, request, lock = false) => {
  const result = await client.query(`${idempotencyQuery}${lock ? ' FOR UPDATE' : ''}`, [
    request.tenantId, request.customerId, request.idempotencyKey,
  ]);
  return resolveExistingOrder(result.rows[0], request.fingerprint);
};

// A checkout retry can arrive with a fresh browser idempotency key after a
// refresh, but still describe the exact same immutable purchase. Resume only
// an identical pending purchase; different carts, addresses, or totals have a
// different fingerprint and remain independent orders.
const findMatchingPendingPurchase = async (client, request) => {
  const result = await client.query(
    `SELECT id, order_number
     FROM ORDERS
     WHERE tenant_id = $1 AND customer_id = $2 AND idempotency_fingerprint = $3
       AND status = 'CONFIRMED' AND payment_status = 'PENDING' AND is_deleted = false
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [request.tenantId, request.customerId, request.fingerprint]
  );
  return result.rows[0] ? { id: result.rows[0].id, orderNumber: result.rows[0].order_number, reused: true } : null;
};

const checkoutChanged = (details) => new AppError('Some product details changed. Please review your cart before continuing.', 409, 'CHECKOUT_DETAILS_CHANGED', details);

const revalidateProducts = async (client, request) => {
  const productIds = request.items.map((item) => item.productId).sort();
  const result = await client.query(
    `SELECT p.id,p.name,p.sku,p.price,p.stock_qty,p.is_published,p.is_deleted,p.is_purchasable,
            image.base_url AS primary_image_url
     FROM PRODUCTS p
     LEFT JOIN LATERAL (
       SELECT base_url FROM PRODUCT_IMAGES
       WHERE product_id=p.id AND tenant_id=p.tenant_id
       ORDER BY is_primary DESC,sort_order ASC,id ASC LIMIT 1
     ) image ON true
     WHERE p.tenant_id=$1 AND p.id=ANY($2::text[])
     ORDER BY p.id ASC
     FOR UPDATE OF p`,
    [request.tenantId, productIds]
  );
  const products = new Map(result.rows.map((product) => [product.id, product]));
  const changed = [];
  const items = [];
  for (const item of request.items) {
    const product = products.get(item.productId);
    if (!product || product.is_deleted || !product.is_published) {
      changed.push({ productId: item.productId, code: 'PRODUCT_UNAVAILABLE' });
      continue;
    }
    const currentPriceCents = toCents(product.price, 'product price');
    if (!product.is_purchasable || currentPriceCents <= 0) {
      changed.push({ productId: item.productId, code: 'PRODUCT_NOT_PURCHASABLE' });
      continue;
    }
    if (item.quantity > Number(product.stock_qty)) {
      changed.push({ productId: item.productId, code: 'INSUFFICIENT_STOCK' });
      continue;
    }
    if (currentPriceCents !== item.unitPriceCents) {
      changed.push({ productId: item.productId, code: 'PRICE_CHANGED' });
      continue;
    }
    items.push({
      productId: product.id,
      productName: product.name,
      productSku: product.sku || null,
      imageUrl: product.primary_image_url || null,
      quantity: item.quantity,
      unitPriceCents: currentPriceCents,
      lineSubtotalCents: currentPriceCents * item.quantity,
    });
  }
  if (changed.length) throw checkoutChanged(changed);
  return items;
};

const revalidateMonetaryBreakdown = async (client, request, items) => {
  const subtotalCents = items.reduce((sum, item) => sum + item.lineSubtotalCents, 0);
  const taxCents = calculateGstCents(subtotalCents);
  const shipping = await requirePricedShipping({
    tenantId: request.tenantId,
    subtotalPaise: BigInt(subtotalCents),
    shippingAddressSnapshot: request.shippingAddressSnapshot,
    database: client,
  });
  const shippingCents = Number(shipping.amountPaise);
  const finalBreakdown = { subtotalCents, discountCents: 0, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents };
  const expected = request.monetary;
  if (Object.keys(finalBreakdown).some((field) => finalBreakdown[field] !== expected[field])) {
    throw checkoutChanged([{ code: 'TOTAL_CHANGED' }]);
  }
  return finalBreakdown;
};

// Internal boundary for Checkout only. It deliberately has no controller or
// browser request schema: callers must supply server-validated cart, address,
// and price snapshots before entering this transaction.
const createTrustedOrder = async (input) => {
  const request = normalizeTrustedOrder(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Different browser tabs can lose their client idempotency key while
    // describing the same pending purchase. Serialize that exact fingerprint
    // before looking it up or inserting so it cannot become two orders.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`${request.tenantId}:${request.customerId}`, `pending-purchase:${request.fingerprint}`]
    );
    const existing = await findExistingOrder(client, request, true);
    if (existing) {
      await client.query('COMMIT');
      return existing;
    }
    const matchingPendingPurchase = await findMatchingPendingPurchase(client, request);
    if (matchingPendingPurchase) {
      await client.query('COMMIT');
      return matchingPendingPurchase;
    }

    const finalItems = await revalidateProducts(client, request);
    const finalMonetary = await revalidateMonetaryBreakdown(client, request, finalItems);
    const orderId = crypto.randomUUID();
    const orderNumber = generateOrderNumber();
    await client.query(
      `INSERT INTO ORDERS
         (id, tenant_id, customer_id, shipping_address_id, shipping_address_snapshot,
          order_number, status, payment_status, subtotal, discount_amount, gst_amount,
          shipping_amount, total_amount, currency, idempotency_key, idempotency_fingerprint,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'CONFIRMED', 'PENDING', $7, $8, $9, $10, $11,
               'INR', $12, $13, $3, $3)`,
      [
        orderId, request.tenantId, request.customerId, request.shippingAddressSnapshot.sourceAddressId,
        JSON.stringify(request.shippingAddressSnapshot), orderNumber,
        centsToDecimal(finalMonetary.subtotalCents), centsToDecimal(finalMonetary.discountCents),
        centsToDecimal(finalMonetary.taxCents), centsToDecimal(finalMonetary.shippingCents),
        centsToDecimal(finalMonetary.totalCents), request.idempotencyKey, request.fingerprint,
      ]
    );

    const values = [];
    const placeholders = finalItems.map((item, index) => {
      const base = index * 11;
      values.push(
        crypto.randomUUID(), request.tenantId, orderId, item.productId, item.productName, item.productSku,
        centsToDecimal(item.unitPriceCents), item.quantity, centsToDecimal(item.lineSubtotalCents), item.imageUrl,
        request.customerId,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 11})`;
    });
    await client.query(
      `INSERT INTO ORDER_ITEMS
         (id, tenant_id, order_id, product_id, product_name, product_sku, unit_price,
          quantity, line_subtotal, image_url, created_by, updated_by)
       VALUES ${placeholders.join(', ')}`,
      values
    );
    await client.query(
      `INSERT INTO ORDER_STATUS_HISTORY (id, tenant_id, order_id, from_status, to_status, notes, created_by, actor_type)
       VALUES ($1, $2, $3, NULL, 'CONFIRMED', 'Order confirmed', $4, 'CUSTOMER')`,
      [crypto.randomUUID(), request.tenantId, orderId, request.customerId]
    );
    await audit.write(client, {
      tenantId: request.tenantId, entityType: 'ORDER', entityId: orderId, action: 'ORDER_CREATED',
      actorType: 'CUSTOMER', actorId: request.customerId, beforeSnapshot: null,
      afterSnapshot: { status: 'CONFIRMED', paymentStatus: 'PENDING', totalAmount: centsToDecimal(finalMonetary.totalCents), itemCount: finalItems.length },
      changedFields: ['status', 'paymentStatus', 'totalAmount', 'itemCount'], requestId: request.requestId,
    });
    await client.query('COMMIT');
    return { id: orderId, orderNumber, reused: false };
  } catch (error) {
    await client.query('ROLLBACK');
    // A concurrent request with the same key can win after our initial locked
    // lookup. The unique index is the cross-instance coordination point.
    if (error?.code === '23505' && error?.constraint === 'uq_orders_tenant_customer_idempotency_key') {
      const existing = await findExistingOrder(pool, request, false);
      if (existing) return existing;
    }
    throw error;
  } finally {
    client.release();
  }
};

const presentSummary = (row) => ({
  id: row.id,
  orderNumber: row.order_number,
  status: row.status,
  paymentStatus: row.payment_status,
  subtotal: toPublicMoney(row.subtotal),
  discountAmount: toPublicMoney(row.discount_amount),
  taxAmount: toPublicMoney(row.gst_amount),
  shippingAmount: toPublicMoney(row.shipping_amount),
  totalAmount: toPublicMoney(row.total_amount),
  currency: row.currency,
  courierName: row.courier_name || null,
  trackingNumber: row.tracking_number || null,
  trackingUrl: row.tracking_url || null,
  dispatchedAt: row.dispatched_at || null,
  expectedDeliveryDate: row.expected_delivery_date || null,
  createdAt: row.created_at,
  itemCount: Number(row.item_count || 0),
  itemPreviews: Array.isArray(row.item_previews) ? row.item_previews : (typeof row.item_previews === 'string' ? JSON.parse(row.item_previews || '[]') : []),
});

const parseSnapshot = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return null; }
};

const list = async (tenantId, customerId, { page, limit }) => {
  const offset = (page - 1) * limit;
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM ORDERS
     WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false`,
    [tenantId, customerId]
  );
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.subtotal, o.discount_amount, o.gst_amount,
            o.shipping_amount, o.total_amount, o.currency, o.created_at,
            COALESCE(item_summary.item_count, 0)::int AS item_count,
            COALESCE(item_summary.item_previews, '[]'::json) AS item_previews
     FROM ORDERS o
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS item_count,
              COALESCE((
                SELECT json_agg(json_build_object('productId', preview.product_id, 'productName', preview.product_name, 'quantity', preview.quantity, 'imageUrl', preview.image_url)
                  ORDER BY preview.created_at ASC, preview.id ASC)
                FROM (
                  SELECT id, product_id, product_name, quantity, image_url, created_at
                  FROM ORDER_ITEMS
                  WHERE order_id = o.id AND tenant_id = o.tenant_id AND is_deleted = false
                  ORDER BY created_at ASC, id ASC
                  LIMIT 3
                ) preview
              ), '[]'::json) AS item_previews
       FROM ORDER_ITEMS
       WHERE order_id = o.id AND tenant_id = o.tenant_id AND is_deleted = false
     ) item_summary ON true
     WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.is_deleted = false
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, customerId, limit, offset]
  );
  const total = countResult.rows[0]?.total || 0;
  return {
    orders: result.rows.map(presentSummary),
    pagination: {
      page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total, hasPrevious: page > 1,
    },
  };
};

const getDetail = async (tenantId, customerId, identifier, { byReference = false } = {}) => {
  const headerResult = await pool.query(
    `SELECT id, order_number, status, payment_status, subtotal, discount_amount, gst_amount,
            shipping_amount, total_amount, currency, shipping_address_snapshot, courier_name, tracking_number,
            tracking_url, dispatched_at, expected_delivery_date, created_at
     FROM ORDERS
     WHERE ${byReference ? 'order_number' : 'id'} = $1 AND tenant_id = $2 AND customer_id = $3 AND is_deleted = false`,
    [identifier, tenantId, customerId]
  );
  const header = headerResult.rows[0];
  if (!header) throw new NotFoundError('Order');

  const [itemsResult, historyResult] = await Promise.all([
    pool.query(
      `SELECT id, product_id, product_name, product_sku, unit_price, quantity, line_subtotal, image_url
       FROM ORDER_ITEMS
       WHERE order_id = $1 AND tenant_id = $2 AND is_deleted = false
       ORDER BY created_at ASC, id ASC`,
      [header.id, tenantId]
    ),
    pool.query(
      `SELECT from_status, to_status, notes, actor_type, created_at
       FROM ORDER_STATUS_HISTORY
       WHERE order_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC, id ASC`,
      [header.id, tenantId]
    ),
  ]);

  return {
    ...presentSummary(header),
    deliveryAddress: parseSnapshot(header.shipping_address_snapshot),
    items: itemsResult.rows.map((item) => ({
      id: item.id, productId: item.product_id, productName: item.product_name,
      productSku: item.product_sku || null, unitPrice: toPublicMoney(item.unit_price),
      quantity: Number(item.quantity), lineSubtotal: toPublicMoney(item.line_subtotal), imageUrl: item.image_url || null,
    })),
    statusHistory: historyResult.rows.map((history) => ({
      fromStatus: history.from_status || null, toStatus: history.to_status,
      notes: history.notes || null, actorType: history.actor_type || null, createdAt: history.created_at,
    })),
  };
};

const getById = (tenantId, customerId, orderId) => getDetail(tenantId, customerId, orderId);
const getByReference = (tenantId, customerId, orderReference) => getDetail(tenantId, customerId, orderReference, { byReference: true });

const reviewUnavailable = () => new AppError('Reviews are available after delivery.', 409, 'ORDER_REVIEW_NOT_ELIGIBLE');

const getDeliveredOrderForReview = async (client, tenantId, customerId, orderReference, { lock = false } = {}) => {
  const result = await client.query(
    `SELECT o.id,o.order_number,o.status,c.full_name
     FROM ORDERS o
     JOIN CUSTOMERS c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
     WHERE o.order_number=$1 AND o.tenant_id=$2 AND o.customer_id=$3 AND o.is_deleted=false${lock ? ' FOR UPDATE OF o' : ''}`,
    [orderReference, tenantId, customerId]
  );
  const order = result.rows[0];
  if (!order) throw new NotFoundError('Order');
  if (order.status !== 'DELIVERED') throw reviewUnavailable();
  return order;
};

const getReviewItems = async (tenantId, customerId, orderReference) => {
  const order = await getDeliveredOrderForReview(pool, tenantId, customerId, orderReference);
  const result = await pool.query(
    `SELECT oi.id,oi.product_id,oi.product_name,oi.product_sku,oi.image_url,oi.quantity,
            r.id AS review_id,r.rating,r.review,r.created_at AS reviewed_at
     FROM ORDER_ITEMS oi
     LEFT JOIN product_reviews r ON r.tenant_id=oi.tenant_id AND r.order_item_id=oi.id
     WHERE oi.tenant_id=$1 AND oi.order_id=$2 AND oi.is_deleted=false
     ORDER BY oi.created_at ASC,oi.id ASC`,
    [tenantId, order.id]
  );
  return {
    orderReference: order.order_number,
    items: result.rows.map((item) => ({
      orderItemId: item.id,
      productId: item.product_id,
      productName: item.product_name,
      productSku: item.product_sku || null,
      imageUrl: item.image_url || null,
      quantity: Number(item.quantity),
      review: item.review_id ? { id: item.review_id, rating: Number(item.rating), review: item.review || null, createdAt: item.reviewed_at } : null,
    })),
  };
};

const submitItemReview = async ({ tenantId, customerId, orderReference, orderItemId, rating, review, requestId = null, ipAddress = null, userAgent = null }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await getDeliveredOrderForReview(client, tenantId, customerId, orderReference, { lock: true });
    const itemResult = await client.query(
      `SELECT id,product_id,product_name FROM ORDER_ITEMS
       WHERE id=$1 AND order_id=$2 AND tenant_id=$3 AND is_deleted=false
       FOR UPDATE`,
      [orderItemId, order.id, tenantId]
    );
    const item = itemResult.rows[0];
    if (!item) throw new NotFoundError('Order item');
    const existing = await client.query(
      `SELECT id FROM product_reviews WHERE tenant_id=$1 AND order_item_id=$2 FOR UPDATE`,
      [tenantId, orderItemId]
    );
    if (existing.rows[0]) throw new ConflictError('A review has already been submitted for this item');
    const inserted = await client.query(
      `INSERT INTO product_reviews
       (tenant_id,product_id,order_item_id,customer_name,rating,review,approved,created_at,last_upd_at)
       VALUES ($1,$2,$3,$4,$5,$6,false,now(),now())
       RETURNING id,rating,review,created_at`,
      [tenantId, item.product_id, item.id, order.full_name?.trim() || 'Verified customer', rating, typeof review === 'string' && review.trim() ? review.trim() : null]
    );
    await audit.write(client, {
      tenantId,
      entityType: 'ORDER_ITEM',
      entityId: item.id,
      action: 'PURCHASE_REVIEW_SUBMITTED',
      actorType: 'CUSTOMER',
      actorId: customerId,
      afterSnapshot: { orderReference: order.order_number, productId: item.product_id, reviewId: inserted.rows[0].id },
      requestId,
      ipAddress,
      userAgent,
    });
    await client.query('COMMIT');
    return { orderItemId: item.id, reviewId: inserted.rows[0].id, rating: Number(inserted.rows[0].rating), review: inserted.rows[0].review || null, createdAt: inserted.rows[0].created_at };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505' && error?.constraint === 'uq_product_reviews_purchase_order_item') {
      throw new ConflictError('A review has already been submitted for this item');
    }
    throw error;
  } finally {
    client.release();
  }
};

const getRelatedProducts = async (tenantId, customerId, orderReference) => {
  const orderResult = await pool.query(
    `SELECT id FROM ORDERS
     WHERE order_number = $1 AND tenant_id = $2 AND customer_id = $3 AND is_deleted = false`,
    [orderReference, tenantId, customerId]
  );
  const order = orderResult.rows[0];
  if (!order) throw new NotFoundError('Order');

  const result = await pool.query(
    `WITH purchased AS (
       SELECT DISTINCT oi.product_id, p.category_id, p.collection_id
       FROM ORDER_ITEMS oi
       JOIN PRODUCTS p ON p.id = oi.product_id AND p.tenant_id = oi.tenant_id
       WHERE oi.order_id = $1 AND oi.tenant_id = $2 AND oi.is_deleted = false
     )
     SELECT p.id, p.name, p.slug, p.price, p.stock_qty,
            (p.is_purchasable = true AND p.price > 0) AS is_purchasable,
            image.base_url AS image_url
     FROM PRODUCTS p
     LEFT JOIN LATERAL (
       SELECT base_url FROM PRODUCT_IMAGES
       WHERE product_id = p.id AND tenant_id = p.tenant_id
       ORDER BY is_primary DESC, sort_order ASC, id ASC
       LIMIT 1
     ) image ON true
     WHERE p.tenant_id = $2 AND p.is_deleted = false AND p.is_published = true
       AND p.is_purchasable = true AND p.price > 0
       AND NOT EXISTS (SELECT 1 FROM purchased bought WHERE bought.product_id = p.id)
       AND EXISTS (
         SELECT 1 FROM purchased bought
         WHERE (bought.collection_id IS NOT NULL AND bought.collection_id = p.collection_id)
            OR (bought.category_id IS NOT NULL AND bought.category_id = p.category_id)
       )
     ORDER BY CASE WHEN EXISTS (
       SELECT 1 FROM purchased bought
       WHERE bought.collection_id IS NOT NULL AND bought.collection_id = p.collection_id
     ) THEN 0 ELSE 1 END, p.created_at DESC, p.id DESC
     LIMIT 6`,
    [order.id, tenantId]
  );
  return result.rows.map((product) => ({
    id: product.id, name: product.name, slug: product.slug, price: toPublicMoney(product.price),
    stockQty: Number(product.stock_qty || 0), isPurchasable: Boolean(product.is_purchasable), imageUrl: product.image_url || null,
  }));
};

// Internal, future Admin/Fulfillment boundary. There is intentionally no HTTP
// route in Order Core, so customers cannot arbitrarily mutate statuses.
const transitionStatus = async ({ tenantId, orderId, toStatus, actorId, actorType = 'STAFF', fulfillment = {}, requestId = null, ipAddress = null, userAgent = null }) => {
  if (!ORDER_STATUSES.includes(toStatus) || typeof actorId !== 'string' || !actorId) {
    throw new ValidationError('Order status transition is invalid');
  }
  if (!['STAFF', 'SYSTEM'].includes(actorType)) throw new ValidationError('Order status transition is invalid');
  if (toStatus === 'SHIPPED' && (!fulfillment.courierName?.trim() || !fulfillment.trackingNumber?.trim())) {
    throw new ValidationError('Courier name and tracking number are required when shipping an order');
  }
  let result;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT status, payment_status, courier_name, tracking_number, tracking_url, dispatched_at, expected_delivery_date
       FROM ORDERS WHERE id = $1 AND tenant_id = $2 AND is_deleted = false FOR UPDATE`,
      [orderId, tenantId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new NotFoundError('Order');
    if (current.payment_status !== 'PAID') throw new ConflictError('Only paid orders can enter fulfillment');
    if (!STATUS_TRANSITIONS[current.status]?.includes(toStatus)) {
      throw new ConflictError('Order status transition is not allowed');
    }
    const updated = await client.query(
      `UPDATE ORDERS SET status = $3,
       courier_name = CASE WHEN $3 = 'SHIPPED' THEN $5 ELSE courier_name END,
       tracking_number = CASE WHEN $3 = 'SHIPPED' THEN $6 ELSE tracking_number END,
       tracking_url = CASE WHEN $3 = 'SHIPPED' THEN $7 ELSE tracking_url END,
       dispatched_at = CASE WHEN $3 = 'SHIPPED' THEN COALESCE($8, now()) ELSE dispatched_at END,
       expected_delivery_date = CASE WHEN $3 = 'SHIPPED' THEN $9 ELSE expected_delivery_date END,
       updated_at = now(), updated_by = $4 WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [orderId, tenantId, toStatus, actorId, fulfillment.courierName?.trim() || null,
        fulfillment.trackingNumber?.trim() || null, fulfillment.trackingUrl?.trim() || null,
        fulfillment.dispatchedAt || null, fulfillment.expectedDeliveryDate || null]
    );
    await client.query(
      `INSERT INTO ORDER_STATUS_HISTORY (id, tenant_id, order_id, from_status, to_status, notes, created_by, actor_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [crypto.randomUUID(), tenantId, orderId, current.status, toStatus,
        toStatus === 'SHIPPED' ? 'Order dispatched' : null, actorId, actorType,
        JSON.stringify(toStatus === 'SHIPPED' ? { courierName: fulfillment.courierName?.trim() || null, trackingNumber: fulfillment.trackingNumber?.trim() || null } : {})]
    );
    if (toStatus === 'PROCESSING' || toStatus === 'SHIPPED' || toStatus === 'DELIVERED') {
      await notifications.enqueueInTransaction(client, { tenantId, orderId: updated.rows[0].id, eventType: toStatus });
      if (toStatus === 'DELIVERED') await notifications.enqueueInTransaction(client, { tenantId, orderId: updated.rows[0].id, eventType: 'REVIEW_ELIGIBLE' });
    }
    await audit.write(client, { tenantId, entityType: 'ORDER', entityId: orderId, action: `FULFILLMENT_${toStatus}`,
      actorType, actorId, beforeSnapshot: { status: current.status, courierName: current.courier_name, trackingNumber: current.tracking_number, trackingUrl: current.tracking_url, dispatchedAt: current.dispatched_at, expectedDeliveryDate: current.expected_delivery_date },
      afterSnapshot: { status: toStatus, courierName: toStatus === 'SHIPPED' ? fulfillment.courierName?.trim() : current.courier_name, trackingNumber: toStatus === 'SHIPPED' ? fulfillment.trackingNumber?.trim() : current.tracking_number, trackingUrl: toStatus === 'SHIPPED' ? fulfillment.trackingUrl?.trim() || null : current.tracking_url, dispatchedAt: toStatus === 'SHIPPED' ? fulfillment.dispatchedAt || null : current.dispatched_at, expectedDeliveryDate: toStatus === 'SHIPPED' ? fulfillment.expectedDeliveryDate || null : current.expected_delivery_date },
      requestId, ipAddress, userAgent });
    await client.query('COMMIT');
    result = { fromStatus: current.status, toStatus, orderId: updated.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (result && (toStatus === 'PROCESSING' || toStatus === 'SHIPPED' || toStatus === 'DELIVERED')) {
    notifications.dispatchSafely({ tenantId, orderId: result.orderId });
  }
  return result;
};

module.exports = {
  ORDER_STATUSES,
  STATUS_TRANSITIONS,
  createTrustedOrder,
  transitionStatus,
  list,
  getById,
  getByReference,
  getReviewItems,
  submitItemReview,
  getRelatedProducts,
  normalizeTrustedOrder,
};
