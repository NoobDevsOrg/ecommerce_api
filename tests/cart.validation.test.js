const assert = require('node:assert/strict');
const test = require('node:test');

const databaseModulePath = require.resolve('../src/config/db');
const serviceModulePath = require.resolve('../src/modules/cart/cart.service');
const { validateCartSchema, MAX_CART_ITEM_QUANTITY } = require('../src/modules/cart/cart.validator');

const loadCartService = (t, products) => {
  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalServiceModule = require.cache[serviceModulePath];
  const calls = [];
  const pool = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      const [tenantId, productIds] = parameters;
      return { rows: products.filter((product) => product.tenant_id === tenantId && productIds.includes(product.id)) };
    },
  };

  delete require.cache[serviceModulePath];
  require.cache[databaseModulePath] = { exports: pool };
  const service = require('../src/modules/cart/cart.service');
  t.after(() => {
    delete require.cache[serviceModulePath];
    if (originalServiceModule) require.cache[serviceModulePath] = originalServiceModule;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
  });
  return { service, calls };
};

const product = (overrides = {}) => ({
  id: 'product-1', tenant_id: 't1', name: 'Temple Necklace', slug: 'temple-necklace', price: '1250.50',
  compare_price: null, stock_qty: 3, is_published: true, is_deleted: false,
  is_purchasable: true, is_enquiry_enabled: true, category_name: 'Necklaces', primary_image_url: 'https://cdn.example/image.jpg',
  ...overrides,
});

test('cart validation batch-fetches authoritative prices and calculates fresh totals', async (t) => {
  const { service, calls } = loadCartService(t, [product(), product({ id: 'product-2', price: '500' })]);
  const result = await service.validateItems('t1', [{ productId: 'product-1', quantity: 2 }, { productId: 'product-2', quantity: 1 }]);

  assert.equal(calls.length, 1, 'cart product validation is a single batch query');
  assert.equal(result.items[0].unitPrice, 1250.5);
  assert.equal(result.items[0].lineSubtotal, 2501);
  assert.equal(result.subtotal, 3001);
  assert.equal(result.items[0].stockStatus, 'IN_STOCK');
});

test('cart rejects enquiry-only, invalid-price, unpublished, deleted, missing, and other-tenant products', async (t) => {
  const { service } = loadCartService(t, [
    product({ id: 'enquiry-only', is_purchasable: false }),
    product({ id: 'bad-price', price: '0' }),
    product({ id: 'unpublished', is_published: false }),
    product({ id: 'deleted', is_deleted: true }),
    product({ id: 'other-tenant', tenant_id: 't2' }),
  ]);
  const result = await service.validateItems('t1', [
    { productId: 'enquiry-only', quantity: 1 }, { productId: 'bad-price', quantity: 1 },
    { productId: 'unpublished', quantity: 1 }, { productId: 'deleted', quantity: 1 },
    { productId: 'missing', quantity: 1 }, { productId: 'other-tenant', quantity: 1 },
  ]);

  assert.equal(result.items.length, 0);
  assert.deepEqual(result.invalidItems.map((item) => item.code), [
    'PRODUCT_NOT_PURCHASABLE', 'PRODUCT_NOT_PURCHASABLE', 'PRODUCT_UNAVAILABLE',
    'PRODUCT_UNAVAILABLE', 'PRODUCT_UNAVAILABLE', 'PRODUCT_UNAVAILABLE',
  ]);
});

test('cart rejects out-of-stock and over-stock quantities from current authoritative product stock', async (t) => {
  const { service } = loadCartService(t, [product({ id: 'empty', stock_qty: 0 }), product({ id: 'one-left', stock_qty: 1 })]);
  const result = await service.validateItems('t1', [{ productId: 'empty', quantity: 1 }, { productId: 'one-left', quantity: 2 }]);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.invalidItems.map((item) => item.code), ['PRODUCT_NOT_PURCHASABLE', 'INSUFFICIENT_STOCK']);
});

test('cart request validation rejects invalid quantities, duplicate identities, and untrusted fields', () => {
  const valid = validateCartSchema.validate({ body: { items: [{ productId: 'product-1', quantity: 1, price: 1 }] }, params: {}, query: {} }, { stripUnknown: true });
  assert.equal(valid.error, undefined);
  assert.deepEqual(valid.value.body.items[0], { productId: 'product-1', quantity: 1 });

  const invalidQuantity = validateCartSchema.validate({ body: { items: [{ productId: 'product-1', quantity: MAX_CART_ITEM_QUANTITY + 1 }] }, params: {}, query: {} });
  assert.ok(invalidQuantity.error);
  const duplicate = validateCartSchema.validate({ body: { items: [{ productId: 'product-1', quantity: 1 }, { productId: 'product-1', quantity: 1 }] }, params: {}, query: {} });
  assert.ok(duplicate.error);
});
