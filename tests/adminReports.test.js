const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { assertDateRange, addInclusiveDateRange, csv } = require('../src/utils/adminList');
const { authorize } = require('../src/middleware/auth');

const source = (path) => readFileSync(require.resolve(path), 'utf8');

test('admin report date ranges are ISO-only, inclusive, and reject inverted ranges', () => {
  assert.throws(() => assertDateRange({ from: '2026-09-26', to: '2026-09-25' }), /cannot be before/);
  assert.throws(() => assertDateRange({ from: '26-09-2026' }), /YYYY-MM-DD/);
  const where = ['tenant_id = $1']; const values = ['tenant-a'];
  addInclusiveDateRange(where, values, 'created_at', { from: '2026-09-26', to: '2026-09-26' });
  assert.deepEqual(values, ['tenant-a', '2026-09-26', '2026-09-26']);
  assert.match(where[1], /created_at >= \(\$2::date::timestamp AT TIME ZONE 'Asia\/Kolkata'\)/);
  assert.match(where[2], /created_at < \(\(\$3::date \+ interval '1 day'\)::timestamp AT TIME ZONE 'Asia\/Kolkata'\)/);
});

test('CSV reports use stable safe headers and escape commas, quotes, and newlines', () => {
  const output = csv([{ label: 'Customer Name', value: (row) => row.name }, { label: 'Created At', value: (row) => row.created }], [{ name: 'A, "quoted"\nname', created: '2026-09-26T14:12:00.000Z' }]);
  assert.equal(output, 'Customer Name,Created At\r\n"A, ""quoted""\nname","2026-09-26T14:12:00.000Z"');
  assert.doesNotMatch(output, /password_hash|razorpay_signature|provider_payload/);
});

test('orders, customers, and payments reports reuse their list query filters and ignore UI pagination', () => {
  const orderController = source('../src/modules/orders/adminOrder.controller');
  const customerController = source('../src/modules/customers/customerDirectory.controller');
  const paymentController = source('../src/modules/payments/adminPayment.controller');
  const paymentService = source('../src/modules/payments/adminPayment.service');
  assert.match(orderController, /service\.list\(req\.tenantId, \{ \.\.\.req\.query, page: 1, limit: 5000 \}\)/);
  assert.match(customerController, /service\.list\(req\.tenantId, \{ \.\.\.req\.query, page: 1, limit: 5000 \}\)/);
  assert.match(paymentController, /service\.query\(req\.tenantId, \{ \.\.\.req\.query, exportAll: true \}\)/);
  assert.match(paymentService, /const boundedLimit = exportAll \? 5000 : limit/);
  assert.match(paymentService, /addInclusiveDateRange\(where, values, 'p\.created_at'/);
  assert.doesNotMatch(paymentController, /signature|payload|password/i);
});

test('all report routes remain ADMIN/SUPPORT-only', () => {
  const middleware = authorize({ roles: ['ADMIN', 'SUPPORT'] });
  assert.equal(middleware({ user: { role_code: 'ADMIN' } }, {}, (error) => error), undefined);
  assert.equal(middleware({ user: { role_code: 'SUPPORT' } }, {}, (error) => error), undefined);
  assert.equal(middleware({ user: { role_code: null, customer_id: 'customer-1' } }, {}, (error) => error).statusCode, 403);
  for (const route of ['../src/modules/orders/adminOrder.routes', '../src/modules/customers/customerDirectory.routes', '../src/modules/payments/adminPayment.routes']) {
    assert.match(source(route), /authorize\(\{ roles: \['ADMIN', 'SUPPORT'\] \}\)/);
    assert.match(source(route), /\/report/);
  }
});
