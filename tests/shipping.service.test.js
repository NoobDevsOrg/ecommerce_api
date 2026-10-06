const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateShipping, requirePricedShipping } = require('../src/modules/checkout/shipping.service');
const { createZoneSchema, updatePolicySchema } = require('../src/modules/shipping/shippingSettings.validator');

const address = (overrides = {}) => ({ country: 'IN', state: 'Tamil Nadu', ...overrides });
const database = (...responses) => ({ query: async () => ({ rows: responses.shift() || [] }) });

test('Shipping applies the tenant free-shipping threshold before resolving a zone', async () => {
  const db = database([{ free_shipping_enabled: true, free_shipping_threshold_paise: '300000' }]);
  const result = await calculateShipping({ tenantId: 't1', subtotalPaise: 300000n, shippingAddressSnapshot: address(), database: db });
  assert.deepEqual(result, { status: 'FREE', amountPaise: 0n, zoneId: null, zoneName: 'Free shipping' });
});

test('Shipping deterministically prefers an exact Tamil Nadu zone over the India fallback', async () => {
  const db = database(
    [{ free_shipping_enabled: false, free_shipping_threshold_paise: null }],
    [
      { id: 'tn', name: 'Tamil Nadu', country_code: 'IN', state_name: 'TAMIL NADU', fulfillment_mode: 'FLAT', flat_rate_paise: '15000' },
      { id: 'rest', name: 'Rest of India', country_code: 'IN', state_name: null, fulfillment_mode: 'FLAT', flat_rate_paise: '25000' },
    ]
  );
  const result = await calculateShipping({ tenantId: 't1', subtotalPaise: 100n, shippingAddressSnapshot: address({ state: ' tamil   nadu ' }), database: db });
  assert.deepEqual(result, { status: 'FLAT', amountPaise: 15000n, zoneId: 'tn', zoneName: 'Tamil Nadu' });
});

test('Tamil Nadu state names, compact spellings, and TN resolve to one canonical shipping match key', async () => {
  const zone = { id: 'tn', name: 'Tamil Nadu', country_code: 'IN', state_name: 'TN', fulfillment_mode: 'FLAT', flat_rate_paise: '15000' };
  for (const state of ['Tamil Nadu', 'tamilnadu', 'Tamilnadu', ' tn ', 'TAMIL   NADU']) {
    const db = database(
      [{ free_shipping_enabled: false, free_shipping_threshold_paise: null }],
      [
        { id: 'rest', name: 'Rest of India', country_code: 'IN', state_name: null, fulfillment_mode: 'FLAT', flat_rate_paise: '25000' },
        zone,
      ]
    );
    const result = await calculateShipping({ tenantId: 't1', subtotalPaise: 100n, shippingAddressSnapshot: address({ state }), database: db });
    assert.equal(result.zoneId, 'tn', `${state} should resolve to Tamil Nadu`);
    assert.equal(result.amountPaise, 15000n);
  }
});

test('Shipping uses the India fallback, and never silently treats an unconfigured destination as free', async () => {
  const restDb = database(
    [{ free_shipping_enabled: false, free_shipping_threshold_paise: null }],
    [{ id: 'rest', name: 'Rest of India', country_code: 'IN', state_name: null, fulfillment_mode: 'FLAT', flat_rate_paise: '25000' }]
  );
  const rest = await calculateShipping({ tenantId: 't1', subtotalPaise: 100n, shippingAddressSnapshot: address({ state: 'Kerala' }), database: restDb });
  assert.equal(rest.amountPaise, 25000n);

  const unconfiguredDb = database([{ free_shipping_enabled: false, free_shipping_threshold_paise: null }], []);
  const unconfigured = await calculateShipping({ tenantId: 't1', subtotalPaise: 100n, shippingAddressSnapshot: address({ country: 'US', state: 'California' }), database: unconfiguredDb });
  assert.equal(unconfigured.status, 'CONTACT_US');
  assert.equal(unconfigured.amountPaise, null);
});

test('Contact-us shipping is a structured checkout stop, not an order total', async () => {
  const databaseWithInternationalFallback = database(
    [{ free_shipping_enabled: false, free_shipping_threshold_paise: null }],
    [{ id: 'international', name: 'International', country_code: '*', state_name: null, fulfillment_mode: 'CONTACT_US', flat_rate_paise: null }]
  );
  await assert.rejects(
    requirePricedShipping({ tenantId: 't1', subtotalPaise: 100n, shippingAddressSnapshot: address({ country: 'US' }), database: databaseWithInternationalFallback }),
    (error) => error.statusCode === 422 && error.errorCode === 'SHIPPING_CONTACT_US' && error.details.shipping.status === 'CONTACT_US'
  );
});

test('Shipping settings validation permits only explicit supported matching and modes', () => {
  assert.equal(createZoneSchema.validate({ params: {}, query: {}, body: { name: 'Tamil Nadu', countryCode: 'IN', stateName: 'Tamil Nadu', fulfillmentMode: 'FLAT', flatRatePaise: 15000, isEnabled: true, priority: 10 } }).error, undefined);
  assert.ok(createZoneSchema.validate({ params: {}, query: {}, body: { name: 'Bad', countryCode: 'US', fulfillmentMode: 'FLAT', flatRatePaise: 1 } }).error);
  assert.ok(createZoneSchema.validate({ params: {}, query: {}, body: { name: 'Contact', countryCode: '*', fulfillmentMode: 'CONTACT_US', flatRatePaise: 1 } }).error);
  assert.ok(updatePolicySchema.validate({ params: {}, query: {}, body: { freeShippingEnabled: true, freeShippingThresholdPaise: null, internationalFallbackMode: 'CONTACT_US' } }).error);
});

test('Shipping settings exposes only the protected admin configuration surface', () => {
  const router = require('../src/modules/shipping/shippingSettings.routes');
  const methodsByPath = new Map();
  router.stack.filter((layer) => layer.route).forEach((layer) => {
    const methods = methodsByPath.get(layer.route.path) || [];
    methods.push(...Object.keys(layer.route.methods));
    methodsByPath.set(layer.route.path, methods.sort());
  });
  assert.deepEqual(methodsByPath.get('/settings'), ['get', 'put']);
  assert.deepEqual(methodsByPath.get('/zones'), ['get', 'post']);
  assert.deepEqual(methodsByPath.get('/zones/:zoneId'), ['patch']);
  assert.equal(router.stack.filter((layer) => !layer.route).length >= 2, true, 'authentication and role authorization precede routes');
});
