const assert = require('node:assert/strict');
const test = require('node:test');

const cartServicePath = require.resolve('../src/modules/cart/cart.service');
const addressServicePath = require.resolve('../src/modules/addresses/address.service');
const orderServicePath = require.resolve('../src/modules/orders/order.service');
const shippingServicePath = require.resolve('../src/modules/checkout/shipping.service');
const checkoutServicePath = require.resolve('../src/modules/checkout/checkout.service');
const routesPath = require.resolve('../src/modules/checkout/checkout.routes');
const { prepareCheckoutSchema } = require('../src/modules/checkout/checkout.validator');
const { authenticate } = require('../src/middleware/auth');
const validateRequest = require('../src/middleware/validateRequest');
const { ConflictError, NotFoundError } = require('../src/utils/errors');

const request = (overrides = {}) => ({
  tenantId: 't1', customerId: 'customer-1', addressId: '68d5d9a7-85b6-4f29-82cd-03a2d74b5f24',
  idempotencyKey: 'f7547f8d-1e45-4a52-8b83-555555555555', items: [{ productId: 'product-1', quantity: 2 }],
  ...overrides,
});

const addressSnapshot = {
  sourceAddressId: '68d5d9a7-85b6-4f29-82cd-03a2d74b5f24', fullName: 'Ananya Natarajan', phone: '9876543210',
  addressLine1: '12 Temple Road', addressLine2: null, landmark: null, city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'IN',
};

const validCart = (price = '100.00') => ({
  items: [{
    productId: 'product-1', quantity: 2, unitPrice: price, lineSubtotal: Number(price) * 2,
    stockStatus: 'OUT_OF_STOCK', product: { id: 'product-1', name: 'Temple Necklace', sku: 'TN-001', primaryImageUrl: 'https://cdn.example.invalid/product.jpg' },
  }],
  invalidItems: [], subtotal: Number(price) * 2,
});

const loadCheckoutService = (t, { cartResult = validCart(), addressResult = addressSnapshot, orderResult = { id: 'order-1', orderNumber: 'SGN-20260920-ORDERONE', reused: false }, shippingResult, shippingError } = {}) => {
  const originals = new Map([
    [cartServicePath, require.cache[cartServicePath]],
    [addressServicePath, require.cache[addressServicePath]],
    [orderServicePath, require.cache[orderServicePath]],
    [shippingServicePath, require.cache[shippingServicePath]],
    [checkoutServicePath, require.cache[checkoutServicePath]],
  ]);
  const calls = { cart: [], address: [], order: [], shipping: [] };
  require.cache[cartServicePath] = { exports: { validateItems: async (...args) => { calls.cart.push(args); return cartResult; } } };
  require.cache[addressServicePath] = { exports: { getOwnedActiveSnapshot: async (...args) => { calls.address.push(args); if (addressResult instanceof Error) throw addressResult; return addressResult; } } };
  require.cache[orderServicePath] = { exports: { createTrustedOrder: async (input) => { calls.order.push(input); if (orderResult instanceof Error) throw orderResult; return orderResult; } } };
  require.cache[shippingServicePath] = { exports: { requirePricedShipping: async (...args) => {
    calls.shipping.push(args);
    if (shippingError) throw shippingError;
    return shippingResult || { status: 'FLAT', amountPaise: BigInt(process.env.SHIPPING_FLAT_RATE_PAISE || '0'), zoneName: 'Test zone' };
  } } };
  delete require.cache[checkoutServicePath];
  const service = require('../src/modules/checkout/checkout.service');
  t.after(() => {
    delete require.cache[checkoutServicePath];
    for (const [path, original] of originals) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
  });
  return { service, calls };
};

const withShippingRate = async (t, value, action) => {
  const previous = process.env.SHIPPING_FLAT_RATE_PAISE;
  process.env.SHIPPING_FLAT_RATE_PAISE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SHIPPING_FLAT_RATE_PAISE;
    else process.env.SHIPPING_FLAT_RATE_PAISE = previous;
  });
  return action();
};

test('Checkout prepares an authenticated customer order from fresh Cart and Address facts only', async (t) => withShippingRate(t, '250', async () => {
  const { service, calls } = loadCheckoutService(t, { cartResult: validCart('100.00') });
  const result = await service.prepare({ ...request(), total: 1, gst: 0, price: 1 });
  assert.deepEqual(calls.cart[0], ['t1', request().items]);
  assert.deepEqual(calls.address[0], ['t1', 'customer-1', request().addressId]);
  assert.equal(calls.order.length, 1);
  assert.deepEqual(calls.order[0].monetary, { subtotal: '200.00', discountAmount: '0.00', taxAmount: '6.00', shippingAmount: '2.50', total: '208.50' });
  assert.equal(calls.order[0].items[0].unitPrice, '100.00');
  assert.equal(calls.order[0].items[0].lineSubtotal, '200.00');
  assert.deepEqual(calls.order[0].shippingAddressSnapshot, addressSnapshot);
  assert.equal(result.orderReference, 'SGN-20260920-ORDERONE');
  assert.equal(result.gstRatePercent, 3);
  assert.equal(result.gstAmount, 6);
  assert.equal(result.shippingAmount, 2.5);
  assert.equal(result.totalAmount, 208.5);
  assert.equal(result.paymentStatus, 'PENDING');
  assert.equal(result.nextAction, 'PAYMENT_REQUIRED');
}));

test('Checkout uses current backend product prices and rounds GST in paise, half up', async (t) => withShippingRate(t, '0', async () => {
  const { service } = loadCheckoutService(t, { cartResult: validCart('199.99') });
  const result = await service.prepare(request());
  assert.equal(result.subtotal, 399.98);
  assert.equal(result.gstAmount, 12);
  assert.equal(result.totalAmount, 411.98);
  assert.equal(service.calculateGstPaise(17n), 1n, '0.51 paise rounds up');
  assert.equal(service.calculateGstPaise(50n), 2n, '1.50 paise rounds up');
  assert.equal(service.decimalToPaise('1.005'), 101n, 'line values round to paise before GST');
}));

test('Checkout rejects invalid and non-purchasable cart entries before address or Order Core access', async (t) => withShippingRate(t, '0', async () => {
  const { service, calls } = loadCheckoutService(t, { cartResult: { items: [], invalidItems: [{ productId: 'product-1', code: 'PRODUCT_NOT_PURCHASABLE', message: 'This item is no longer available to add to your bag.' }], subtotal: 0 } });
  await assert.rejects(service.prepare(request()), /bag has changed/);
  assert.equal(calls.address.length, 0);
  assert.equal(calls.order.length, 0);
}));

test('Checkout preserves tenant/customer address ownership and does not create an order for deleted or other-customer addresses', async (t) => withShippingRate(t, '0', async () => {
  const { service, calls } = loadCheckoutService(t, { addressResult: new NotFoundError('Address') });
  await assert.rejects(service.prepare(request()), /Address not found/);
  assert.equal(calls.order.length, 0);
  assert.deepEqual(calls.address[0], ['t1', 'customer-1', request().addressId]);
}));

test('Checkout delegates retries and conflicting keys to Order Core without a second idempotency system', async (t) => withShippingRate(t, '0', async () => {
  const reusedOrder = { id: 'order-1', orderNumber: 'SGN-20260920-ORDERONE', reused: true };
  const { service, calls } = loadCheckoutService(t, { orderResult: reusedOrder });
  const result = await service.prepare(request());
  assert.equal(result.reused, true);
  assert.equal(calls.order[0].idempotencyKey, request().idempotencyKey);
}));

test('Checkout safely propagates a conflicting retry from Order Core', async (t) => withShippingRate(t, '0', async () => {
  const { service } = loadCheckoutService(t, { orderResult: new ConflictError('This request identity was already used for a different order') });
  await assert.rejects(service.prepare(request()), (error) => error.statusCode === 409 && error.errorCode === 'RESOURCE_CONFLICT');
}));

test('Checkout safely stops before Order Core when a destination needs shipping assistance', async (t) => {
  const { AppError } = require('../src/utils/errors');
  const { service, calls } = loadCheckoutService(t, { shippingError: new AppError('Shipping for this destination requires assistance', 422, 'SHIPPING_CONTACT_US') });
  await assert.rejects(service.prepare(request()), (error) => error.errorCode === 'SHIPPING_CONTACT_US');
  assert.equal(calls.order.length, 0);
});

test('Checkout API validates bounded identifiers, ignores browser totals, and rejects unauthenticated or staff identities', async () => {
  const valid = prepareCheckoutSchema.validate({ body: { ...request(), subtotal: 1, total: 1 }, params: {}, query: {} }, { stripUnknown: true });
  assert.equal(valid.error, undefined);
  assert.equal('total' in valid.value.body, false);
  assert.ok(prepareCheckoutSchema.validate({ body: { ...request(), items: [] }, params: {}, query: {} }).error);
  assert.ok(prepareCheckoutSchema.validate({ body: { ...request(), addressId: 'bad-id' }, params: {}, query: {} }).error);
  const middleware = validateRequest(prepareCheckoutSchema);
  assert.equal(middleware({ body: { ...request(), items: [] }, params: {}, query: {} }, {}, (error) => error).statusCode, 400);
  const unauthenticated = await new Promise((resolve) => authenticate({ headers: {}, tenantId: 't1', path: '/checkout/prepare' }, {}, resolve));
  assert.equal(unauthenticated.statusCode, 401);
  delete require.cache[routesPath];
  const routes = require('../src/modules/checkout/checkout.routes');
  assert.equal(routes.requireCustomer({ user: { staff_user_id: 'staff-1', customer_id: null } }, {}, (error) => error).statusCode, 403);
  const methodsByPath = new Map(routes.stack.filter((layer) => layer.route)
    .map((layer) => [layer.route.path, Object.keys(layer.route.methods).sort()]));
  assert.deepEqual(methodsByPath.get('/prepare'), ['post']);
  assert.deepEqual(methodsByPath.get('/sessions'), ['post']);
  assert.deepEqual(methodsByPath.get('/sessions/resume'), ['get']);
  assert.deepEqual(methodsByPath.get('/sessions/draft'), ['patch']);
  assert.deepEqual(methodsByPath.get('/sessions/identity/password'), ['post']);
  assert.deepEqual(methodsByPath.get('/sessions/identity/current'), ['post']);
  assert.deepEqual(methodsByPath.get('/sessions/identity/register'), ['post']);
  assert.deepEqual(methodsByPath.get('/sessions/identity/google'), ['post']);
});
