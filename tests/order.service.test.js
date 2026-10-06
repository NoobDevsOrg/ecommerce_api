const assert = require('node:assert/strict');
const test = require('node:test');

const databaseModulePath = require.resolve('../src/config/db');
const serviceModulePath = require.resolve('../src/modules/orders/order.service');
const routesPath = require.resolve('../src/modules/orders/order.routes');
const { paginationSchema, orderIdSchema } = require('../src/modules/orders/order.validator');
const { transitionSchema } = require('../src/modules/orders/adminOrder.validator');
const validateRequest = require('../src/middleware/validateRequest');
const { authenticate } = require('../src/middleware/auth');

const clone = (value) => JSON.parse(JSON.stringify(value));

const trustedOrder = (overrides = {}) => ({
  tenantId: 't1',
  customerId: 'customer-1',
  idempotencyKey: 'checkout-attempt-1',
  items: [{
    productId: 'product-1', productName: 'Temple Necklace', productSku: 'TN-001',
    imageUrl: 'https://cdn.example.invalid/necklace.jpg', unitPrice: 1250, quantity: 2, lineSubtotal: 2500,
  }],
  shippingAddressSnapshot: {
    sourceAddressId: 'address-1', fullName: 'Ananya Natarajan', phone: '9876543210',
    addressLine1: '12 Temple Road', addressLine2: null, landmark: 'Near the hall', city: 'Chennai',
    state: 'Tamil Nadu', pincode: '600001', country: 'IN',
  },
  monetary: { subtotal: 2500, discountAmount: 0, taxAmount: 75, shippingAmount: 0, total: 2575 },
  ...overrides,
});

const createOrderPool = ({ failAt = null, synchronizeIdempotencyReads = false, products = null } = {}) => {
  const state = { orders: [], items: [], history: [], audits: [], queries: [], idempotencyReads: 0, releaseIdempotencyReads: null,
    products: products || [{ id: 'product-1', tenant_id: 't1', name: 'Temple Necklace', sku: 'TN-001', price: '1250.00', stock_qty: 20, is_published: true, is_deleted: false, is_purchasable: true, primary_image_url: 'https://cdn.example.invalid/necklace.jpg' }] };
  const active = (client) => client.work || state;
  const query = async (client, sql, params = []) => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    state.queries.push({ statement, params });
    if (statement === 'BEGIN') { client.work = clone(state); return { rows: [] }; }
    if (statement === 'COMMIT') {
      const newOrders = client.work.orders.filter((order) => !state.orders.some((existing) => existing.id === order.id));
      const duplicate = newOrders.find((order) => state.orders.some((existing) => (
        existing.tenant_id === order.tenant_id
        && existing.customer_id === order.customer_id
        && existing.idempotency_key === order.idempotency_key
      )));
      if (duplicate) {
        const error = new Error('duplicate idempotency key');
        error.code = '23505';
        error.constraint = 'uq_orders_tenant_customer_idempotency_key';
        throw error;
      }
      state.orders = client.work.orders; state.items = client.work.items; state.history = client.work.history;
      client.work = null;
      return { rows: [] };
    }
    if (statement === 'ROLLBACK') { client.work = null; return { rows: [] }; }

    const db = active(client);
    if (statement.startsWith('SELECT p.id,p.name,p.sku,p.price,p.stock_qty')) {
      const [tenantId, productIds] = params;
      return { rows: clone(db.products.filter((product) => product.tenant_id === tenantId && productIds.includes(product.id)).sort((left, right) => left.id.localeCompare(right.id))) };
    }
    if (statement.startsWith('SELECT free_shipping_enabled')) {
      return { rows: [{ free_shipping_enabled: true, free_shipping_threshold_paise: '0', international_fallback_mode: 'CONTACT_US' }] };
    }
    if (statement.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (statement.startsWith('SELECT COALESCE(MAX(version)')) return { rows: [{ version: 1 }] };
    if (statement.startsWith('INSERT INTO AUDIT_EVENTS')) { db.audits.push({ action: params[4] }); return { rows: [] }; }
    if (statement.startsWith('SELECT id, order_number, idempotency_fingerprint FROM ORDERS')) {
      const [tenantId, customerId, key] = params;
      if (synchronizeIdempotencyReads && client.work) {
        state.idempotencyReads += 1;
        if (state.idempotencyReads === 1) {
          await new Promise((resolve) => { state.releaseIdempotencyReads = resolve; });
        } else if (state.idempotencyReads === 2) {
          state.releaseIdempotencyReads();
        }
      }
      const row = db.orders.find((order) => order.tenant_id === tenantId && order.customer_id === customerId && order.idempotency_key === key);
      return { rows: row ? [{ id: row.id, order_number: row.order_number, idempotency_fingerprint: row.idempotency_fingerprint }] : [] };
    }
    if (statement.startsWith('INSERT INTO ORDERS')) {
      if (failAt === 'header') throw new Error('header insert failed');
      const [id, tenantId, customerId, addressId, snapshot, orderNumber, subtotal, discount, gst, shipping, total, key, fingerprint] = params;
      if (db.orders.some((order) => order.tenant_id === tenantId && order.customer_id === customerId && order.idempotency_key === key)) {
        const error = new Error('duplicate idempotency key'); error.code = '23505'; error.constraint = 'uq_orders_tenant_customer_idempotency_key'; throw error;
      }
      db.orders.push({ id, tenant_id: tenantId, customer_id: customerId, shipping_address_id: addressId, shipping_address_snapshot: snapshot,
        order_number: orderNumber, status: 'CONFIRMED', payment_status: 'PENDING', subtotal, discount_amount: discount,
        gst_amount: gst, shipping_amount: shipping, total_amount: total, currency: 'INR', idempotency_key: key,
        idempotency_fingerprint: fingerprint, is_deleted: false, created_at: `2026-09-24T00:00:0${db.orders.length}.000Z` });
      return { rows: [] };
    }
    if (statement.startsWith('INSERT INTO ORDER_ITEMS')) {
      if (failAt === 'items') throw new Error('item insert failed');
      for (let index = 0; index < params.length; index += 11) {
        const [id, tenantId, orderId, productId, productName, productSku, unitPrice, quantity, lineSubtotal, imageUrl] = params.slice(index, index + 10);
        db.items.push({ id, tenant_id: tenantId, order_id: orderId, product_id: productId, product_name: productName,
          product_sku: productSku, unit_price: unitPrice, quantity, line_subtotal: lineSubtotal, image_url: imageUrl,
          is_deleted: false, created_at: `2026-09-24T00:00:0${db.items.length}.000Z` });
      }
      return { rows: [] };
    }
    if (statement.startsWith('INSERT INTO ORDER_STATUS_HISTORY')) {
      if (failAt === 'history') throw new Error('history insert failed');
      const [id, tenantId, orderId, fromStatus, toStatus, notes] = params;
      const isInitialHistory = params.length === 4;
      db.history.push({ id, tenant_id: tenantId, order_id: orderId,
        from_status: isInitialHistory ? null : fromStatus,
        to_status: isInitialHistory ? 'CONFIRMED' : toStatus,
        notes: isInitialHistory ? 'Order confirmed' : (notes || null),
        created_at: `2026-09-24T00:00:0${db.history.length}.000Z` });
      return { rows: [] };
    }
    if (statement.startsWith('SELECT COUNT(*)::int AS total FROM ORDERS')) {
      const [tenantId, customerId] = params;
      return { rows: [{ total: db.orders.filter((order) => order.tenant_id === tenantId && order.customer_id === customerId && !order.is_deleted).length }] };
    }
    if (statement.startsWith('SELECT o.id, o.order_number, o.status, o.payment_status') && statement.includes('item_summary')) {
      const [tenantId, customerId, limit, offset] = params;
      const rows = db.orders.filter((order) => order.tenant_id === tenantId && order.customer_id === customerId && !order.is_deleted)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(offset, offset + limit)
        .map((order) => {
          const items = db.items.filter((item) => item.order_id === order.id && item.tenant_id === order.tenant_id && !item.is_deleted);
          return { ...order, item_count: items.length, item_previews: items.slice(0, 3).map((item) => ({ productId: item.product_id, productName: item.product_name, quantity: item.quantity, imageUrl: item.image_url })) };
        });
      return { rows: clone(rows) };
    }
    if (statement.startsWith('SELECT id, order_number, status, payment_status') && statement.includes('WHERE id = $1')) {
      const [orderId, tenantId, customerId] = params;
      const row = db.orders.find((order) => order.id === orderId && order.tenant_id === tenantId && order.customer_id === customerId && !order.is_deleted);
      return { rows: row ? [clone(row)] : [] };
    }
    if (statement.startsWith('SELECT id, product_id, product_name')) {
      const [orderId, tenantId] = params;
      return { rows: clone(db.items.filter((item) => item.order_id === orderId && item.tenant_id === tenantId && !item.is_deleted)) };
    }
    if (statement.startsWith('SELECT from_status, to_status')) {
      const [orderId, tenantId] = params;
      return { rows: clone(db.history.filter((entry) => entry.order_id === orderId && entry.tenant_id === tenantId)) };
    }
    if (statement.startsWith('SELECT status FROM ORDERS')) {
      const [orderId, tenantId] = params;
      const row = db.orders.find((order) => order.id === orderId && order.tenant_id === tenantId && !order.is_deleted);
      return { rows: row ? [{ status: row.status }] : [] };
    }
    if (statement.startsWith('UPDATE ORDERS SET status')) {
      const [orderId, tenantId, status] = params;
      const row = db.orders.find((order) => order.id === orderId && order.tenant_id === tenantId);
      if (row) row.status = status;
      return { rows: [] };
    }
    throw new Error(`Unexpected order query: ${statement}`);
  };
  return {
    state,
    async query(sql, params) { return query({}, sql, params); },
    async connect() {
      const client = { work: null, query(sql, params) { return query(client, sql, params); }, release() {} };
      return client;
    },
  };
};

const loadOrderService = (t, options) => {
  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalServiceModule = require.cache[serviceModulePath];
  const pool = createOrderPool(options);
  delete require.cache[serviceModulePath];
  require.cache[databaseModulePath] = { exports: pool };
  const service = require('../src/modules/orders/order.service');
  t.after(() => {
    delete require.cache[serviceModulePath];
    if (originalServiceModule) require.cache[serviceModulePath] = originalServiceModule;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
  });
  return { service, pool };
};

test('Order Core atomically creates a confirmed header, immutable item snapshots, and initial history', async (t) => {
  const { service, pool } = loadOrderService(t);
  const created = await service.createTrustedOrder(trustedOrder());
  assert.equal(created.reused, false);
  assert.match(created.orderNumber, /^SGN-\d{8}-[A-F0-9]{12}$/);
  assert.equal(pool.state.orders.length, 1);
  assert.equal(pool.state.items.length, 1);
  assert.equal(pool.state.history.length, 1);
  assert.equal(pool.state.orders[0].status, 'CONFIRMED');
  assert.equal(pool.state.orders[0].payment_status, 'PENDING', 'payment state is separate from fulfillment');
  assert.equal(pool.state.history[0].to_status, 'CONFIRMED');
  assert.equal(pool.state.items[0].line_subtotal, '2500.00');
});

test('item or initial-history failures rollback the entire order transaction', async (t) => {
  for (const failAt of ['items', 'history']) {
    const { service, pool } = loadOrderService(t, { failAt });
    await assert.rejects(service.createTrustedOrder(trustedOrder({ idempotencyKey: `fail-${failAt}` })), /insert failed/);
    assert.equal(pool.state.orders.length, 0, `${failAt} failure rolls back header`);
    assert.equal(pool.state.items.length, 0, `${failAt} failure rolls back items`);
    assert.equal(pool.state.history.length, 0, `${failAt} failure rolls back history`);
  }
});

test('idempotency returns the same order on a retry and safely rejects conflicting content', async (t) => {
  const { service, pool } = loadOrderService(t);
  const first = await service.createTrustedOrder(trustedOrder());
  const retry = await service.createTrustedOrder(trustedOrder());
  assert.equal(retry.reused, true);
  assert.equal(retry.id, first.id);
  assert.equal(pool.state.orders.length, 1);
  await assert.rejects(
    service.createTrustedOrder(trustedOrder({ monetary: { subtotal: 2500, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total: 2499 } })),
    /inconsistent/
  );
  await assert.rejects(
    service.createTrustedOrder(trustedOrder({ items: [{ ...trustedOrder().items[0], quantity: 1, lineSubtotal: 1250 }], monetary: { subtotal: 1250, total: 1250 } })),
    /different order/
  );
});

test('concurrent retries use the database uniqueness boundary so exactly one order is created', async (t) => {
  const { service, pool } = loadOrderService(t, { synchronizeIdempotencyReads: true });
  const [first, second] = await Promise.all([
    service.createTrustedOrder(trustedOrder({ idempotencyKey: 'concurrent-checkout-attempt' })),
    service.createTrustedOrder(trustedOrder({ idempotencyKey: 'concurrent-checkout-attempt' })),
  ]);
  assert.equal(pool.state.orders.length, 1);
  assert.equal(first.id, second.id);
  assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
});

test('customer lists and details are tenant/customer scoped, paginated, newest-first, and constant-query', async (t) => {
  const { service, pool } = loadOrderService(t);
  pool.state.products.push({ ...pool.state.products[0], tenant_id: 't2' });
  const first = await service.createTrustedOrder(trustedOrder({ idempotencyKey: 'one' }));
  const second = await service.createTrustedOrder(trustedOrder({ idempotencyKey: 'two' }));
  await service.createTrustedOrder(trustedOrder({ tenantId: 't2', idempotencyKey: 'three' }));
  pool.state.queries.length = 0;
  const listed = await service.list('t1', 'customer-1', { page: 1, limit: 1 });
  assert.equal(pool.state.queries.length, 2, 'list does not issue one query per order');
  assert.equal(listed.orders.length, 1);
  assert.equal(listed.orders[0].id, second.id, 'newest record appears first');
  assert.equal(listed.orders[0].itemPreviews[0].productName, 'Temple Necklace');
  assert.equal(listed.pagination.hasNext, true);
  pool.state.queries.length = 0;
  const detail = await service.getById('t1', 'customer-1', first.id);
  assert.equal(pool.state.queries.length, 3, 'detail uses fixed header/items/history queries');
  assert.equal(detail.items.length, 1);
  assert.equal(detail.statusHistory.length, 1);
  await assert.rejects(service.getById('t1', 'customer-2', first.id), /Order not found/);
  await assert.rejects(service.getById('t2', 'customer-1', first.id), /Order not found/);
});

test('product and address data are snapshots and survive later source mutation or removal', async (t) => {
  const { service } = loadOrderService(t);
  const created = await service.createTrustedOrder(trustedOrder());
  const productSource = { name: 'Edited product', isPublished: false };
  const addressSource = { addressLine1: 'Changed saved address', isDeleted: true };
  productSource.name = 'Deleted product';
  addressSource.addressLine1 = 'No longer present';
  const detail = await service.getById('t1', 'customer-1', created.id);
  assert.equal(detail.items[0].productName, 'Temple Necklace');
  assert.equal(detail.items[0].productSku, 'TN-001');
  assert.equal(detail.deliveryAddress.addressLine1, '12 Temple Road');
  assert.equal(detail.deliveryAddress.sourceAddressId, 'address-1');
});

test('Order Core validates trusted inputs and only permits the legacy-compatible status transition set', async (t) => {
  const { service } = loadOrderService(t);
  await assert.rejects(service.createTrustedOrder(trustedOrder({ items: [] })), /items are required/);
  await assert.rejects(service.createTrustedOrder(trustedOrder({ shippingAddressSnapshot: { fullName: 'Missing fields' } })), /address snapshot is invalid/);
  await assert.rejects(service.createTrustedOrder(trustedOrder({ items: [{ ...trustedOrder().items[0], quantity: 2, lineSubtotal: 1 }]})), /does not match/);
  await assert.rejects(service.transitionStatus({ tenantId: 't1', orderId: 'order-1', toStatus: 'CANCELLED', actorId: 'staff-1' }), /invalid/);
  await assert.rejects(service.transitionStatus({ tenantId: 't1', orderId: 'order-1', toStatus: 'PACKED', actorId: 'staff-1' }), /invalid/);
});

test('final locked product revalidation rejects stale price, stock, and capability without writing an order', async (t) => {
  const base = { id: 'product-1', tenant_id: 't1', name: 'Temple Necklace', sku: 'TN-001', price: '1250.00', stock_qty: 20, is_published: true, is_deleted: false, is_purchasable: true, primary_image_url: 'https://cdn.example.invalid/necklace.jpg' };
  for (const [change, expectedCode] of [[{ price: '1300.00' }, 'PRICE_CHANGED'], [{ stock_qty: 1 }, 'INSUFFICIENT_STOCK'], [{ is_published: false }, 'PRODUCT_UNAVAILABLE'], [{ is_purchasable: false }, 'PRODUCT_NOT_PURCHASABLE']]) {
    const { service, pool } = loadOrderService(t, { products: [{ ...base, ...change }] });
    await assert.rejects(service.createTrustedOrder(trustedOrder({ idempotencyKey: `changed-${expectedCode}` })), (error) => error.errorCode === 'CHECKOUT_DETAILS_CHANGED' && error.details.some((detail) => detail.code === expectedCode));
    assert.equal(pool.state.orders.length, 0);
    assert.equal(pool.state.items.length, 0);
  }
});

test('final revalidation locks product rows in stable product-id order and rejects a changed multi-item checkout atomically', async (t) => {
  const products = [
    { id: 'a-product', tenant_id: 't1', name: 'A', sku: 'A', price: '100.00', stock_qty: 4, is_published: true, is_deleted: false, is_purchasable: true, primary_image_url: null },
    { id: 'z-product', tenant_id: 't1', name: 'Z', sku: 'Z', price: '200.00', stock_qty: 1, is_published: true, is_deleted: false, is_purchasable: true, primary_image_url: null },
  ];
  const { service, pool } = loadOrderService(t, { products });
  const request = trustedOrder({
    idempotencyKey: 'multi-product-change',
    items: [
      { productId: 'z-product', productName: 'Z', productSku: 'Z', imageUrl: null, unitPrice: 200, quantity: 2, lineSubtotal: 400 },
      { productId: 'a-product', productName: 'A', productSku: 'A', imageUrl: null, unitPrice: 100, quantity: 1, lineSubtotal: 100 },
    ],
    monetary: { subtotal: 500, discountAmount: 0, taxAmount: 15, shippingAmount: 0, total: 515 },
  });
  await assert.rejects(service.createTrustedOrder(request), (error) => error.errorCode === 'CHECKOUT_DETAILS_CHANGED' && error.details.some((detail) => detail.productId === 'z-product' && detail.code === 'INSUFFICIENT_STOCK'));
  const lock = pool.state.queries.find((entry) => entry.statement.startsWith('SELECT p.id,p.name,p.sku,p.price,p.stock_qty'));
  assert.deepEqual(lock.params[1], ['a-product', 'z-product']);
  assert.equal(pool.state.orders.length, 0);
});

test('customer order routes reject unauthenticated/staff identities and request validators return safe 400 errors', async () => {
  delete require.cache[routesPath];
  const routes = require('../src/modules/orders/order.routes');
  const unauthenticatedError = await new Promise((resolve) => authenticate(
    { headers: {}, tenantId: 't1', path: '/orders' }, {}, resolve
  ));
  assert.equal(unauthenticatedError.statusCode, 401);
  const staffError = routes.requireCustomer({ user: { staff_user_id: 'staff-1', customer_id: null } }, {}, (error) => error);
  const customerError = routes.requireCustomer({ user: { staff_user_id: 'staff-1', customer_id: 'customer-1' } }, {}, (error) => error);
  assert.equal(staffError.statusCode, 403);
  assert.equal(customerError.statusCode, 403);
  const customerMutationRoutes = routes.stack
    .filter((layer) => layer.route && !layer.route.methods.get)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
  assert.deepEqual(customerMutationRoutes, [{
    path: '/me/:orderReference/items/:orderItemId/reviews',
    methods: ['post'],
  }], 'only delivered order-item review submission may mutate customer order data');
  assert.ok(paginationSchema.validate({ body: {}, params: {}, query: { page: 0 } }).error);
  assert.ok(paginationSchema.validate({ body: {}, params: {}, query: { limit: 101 } }).error);
  assert.ok(orderIdSchema.validate({ body: {}, params: { orderId: 'not-an-order-id' }, query: {} }).error);
  const middleware = validateRequest(paginationSchema);
  const validationError = middleware({ body: {}, params: {}, query: { page: '0' } }, {}, (error) => error);
  assert.equal(validationError.statusCode, 400);
});

test('admin fulfillment validator accepts status-only transitions and rejects an empty optional date', () => {
  const request = (body) => ({ params: { orderReference: 'SGN-20260926-ABC123' }, query: {}, body });
  assert.equal(transitionSchema.validate(request({ toStatus: 'PROCESSING' })).error, undefined);
  assert.equal(transitionSchema.validate(request({ toStatus: 'DELIVERED' })).error, undefined);
  assert.equal(transitionSchema.validate(request({
    toStatus: 'SHIPPED', courierName: 'DTDC', trackingNumber: 'D123456', expectedDeliveryDate: '2026-09-30',
  })).error, undefined);
  assert.ok(transitionSchema.validate(request({ toStatus: 'PROCESSING', expectedDeliveryDate: '' })).error);
});
