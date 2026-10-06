const assert = require('node:assert/strict');
const test = require('node:test');

const databaseModulePath = require.resolve('../src/config/db');
const serviceModulePath = require.resolve('../src/modules/orders/order.service');

const loadService = (t, pool) => {
  const originalDatabase = require.cache[databaseModulePath];
  const originalService = require.cache[serviceModulePath];
  delete require.cache[serviceModulePath];
  require.cache[databaseModulePath] = { exports: pool };
  const service = require('../src/modules/orders/order.service');
  t.after(() => {
    delete require.cache[serviceModulePath];
    if (originalService) require.cache[serviceModulePath] = originalService;
    if (originalDatabase) require.cache[databaseModulePath] = originalDatabase;
    else delete require.cache[databaseModulePath];
  });
  return service;
};

const reviewPool = ({ status = 'DELIVERED', owner = 'customer-a', existingReview = false, itemExists = true } = {}) => {
  const state = { reviews: existingReview ? [{ id: 'review-existing', orderItemId: 'item-a' }] : [], calls: [] };
  const query = async (sql, parameters = []) => {
    state.calls.push({ sql, parameters });
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT COALESCE(MAX(version)')) return { rows: [{ version: 1 }] };
    if (sql.includes('FROM ORDERS o') && sql.includes('JOIN CUSTOMERS c')) return { rows: parameters[2] === owner ? [{ id: 'order-a', order_number: 'SGN-TEST-001', status, full_name: 'Ananya' }] : [] };
    if (sql.includes('FROM ORDER_ITEMS') && sql.includes('FOR UPDATE')) return { rows: itemExists ? [{ id: 'item-a', product_id: 'product-deleted-now', product_name: 'Historical Necklace' }] : [] };
    if (sql.includes('LEFT JOIN product_reviews')) return { rows: [{ id: 'item-a', product_id: 'product-deleted-now', product_name: 'Historical Necklace', product_sku: 'HIST-1', image_url: 'https://cdn.example.test/historical.jpg', quantity: 1, review_id: state.reviews[0]?.id || null, rating: state.reviews[0]?.rating || null, review: state.reviews[0]?.review || null, reviewed_at: null }] };
    if (sql.includes('SELECT id FROM product_reviews')) return { rows: state.reviews.map((review) => ({ id: review.id })) };
    if (sql.includes('INSERT INTO product_reviews')) {
      const review = { id: `review-${state.reviews.length + 1}`, orderItemId: parameters[2], rating: parameters[4], review: parameters[5] };
      state.reviews.push(review);
      return { rows: [{ id: review.id, rating: review.rating, review: review.review, created_at: '2026-10-03T00:00:00.000Z' }] };
    }
    if (sql.includes('INSERT INTO AUDIT_EVENTS')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { state, query, connect: async () => ({ query, release() {} }) };
};

test('delivered owner receives item-specific review eligibility from immutable order items', async (t) => {
  const pool = reviewPool();
  const service = loadService(t, pool);
  const result = await service.getReviewItems('tenant-a', 'customer-a', 'SGN-TEST-001');
  assert.equal(result.items[0].orderItemId, 'item-a');
  assert.equal(result.items[0].productId, 'product-deleted-now');
  assert.equal(result.items[0].review, null);
  assert.equal(pool.state.calls.some((call) => /FROM PRODUCTS/i.test(call.sql)), false);
});

test('purchase review requires a delivered order owned by the current customer', async (t) => {
  const notDelivered = loadService(t, reviewPool({ status: 'SHIPPED' }));
  await assert.rejects(() => notDelivered.getReviewItems('tenant-a', 'customer-a', 'SGN-TEST-001'), (error) => error.errorCode === 'ORDER_REVIEW_NOT_ELIGIBLE');
  const wrongOwner = loadService(t, reviewPool({ owner: 'customer-a' }));
  await assert.rejects(() => wrongOwner.getReviewItems('tenant-a', 'customer-b', 'SGN-TEST-001'), (error) => error.statusCode === 404);
});

test('purchase review rejects products not bought and permits one submitted review only', async (t) => {
  const missingItem = loadService(t, reviewPool({ itemExists: false }));
  await assert.rejects(() => missingItem.submitItemReview({ tenantId: 'tenant-a', customerId: 'customer-a', orderReference: 'SGN-TEST-001', orderItemId: 'other-item', rating: 5, review: 'Lovely' }), (error) => error.statusCode === 404);
  const pool = reviewPool();
  const service = loadService(t, pool);
  const created = await service.submitItemReview({ tenantId: 'tenant-a', customerId: 'customer-a', orderReference: 'SGN-TEST-001', orderItemId: 'item-a', rating: 5, review: 'Lovely' });
  assert.equal(created.rating, 5);
  await assert.rejects(() => service.submitItemReview({ tenantId: 'tenant-a', customerId: 'customer-a', orderReference: 'SGN-TEST-001', orderItemId: 'item-a', rating: 5, review: 'Again' }), (error) => error.statusCode === 409);
});

test('review notifications use the actionable delivered-order review anchor', () => {
  const { actionFor } = require('../src/modules/orders/orderNotification.service');
  assert.equal(actionFor({ eventType: 'REVIEW_ELIGIBLE', audience: 'CUSTOMER', orderNumber: 'SGN-TEST-001' }), '/account/orders/SGN-TEST-001#review');
});
