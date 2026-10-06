const assert = require('node:assert/strict');
const test = require('node:test');

const databaseModulePath = require.resolve('../src/config/db');
const serviceModulePath = require.resolve('../src/modules/customers/customerDirectory.service');
const { listCustomersSchema, customerIdSchema, customerOrdersSchema } = require('../src/modules/customers/customerDirectory.validator');
const { authorize } = require('../src/middleware/auth');
const validateRequest = require('../src/middleware/validateRequest');

const customerRow = {
  id: 'customer-1', full_name: 'Ananya Natarajan', email: 'ananya@example.invalid', phone: '9876543210',
  created_at: '2026-09-20T00:00:00.000Z', auth_id: 'auth-customer-1', auth_is_active: true,
  google_subject_present: false, address_count: 2, order_count: 3, total_paid_order_value: '4500.00', latest_order_date: '2026-09-22T00:00:00.000Z',
};

const loadService = (t) => {
  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalServiceModule = require.cache[serviceModulePath];
  const calls = [];
  const pool = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
      if (sql.includes('SELECT id FROM CUSTOMERS')) return { rows: parameters[0] === 't1' && parameters[1] === 'customer-1' ? [{ id: 'customer-1' }] : [] };
      if (sql.includes('SELECT order_number, created_at, payment_status')) return { rows: [{ order_number: 'SGN-ORDER-1', created_at: '2026-09-22T00:00:00.000Z', payment_status: 'PAID', status: 'PROCESSING', total_amount: '4500.00', currency: 'INR' }] };
      if (sql.includes('SELECT c.id') && sql.includes('WHERE c.tenant_id = $1 AND c.id = $2')) {
        return { rows: parameters[0] === 't1' && parameters[1] === 'customer-1' ? [customerRow] : [] };
      }
      if (sql.includes('SELECT c.id')) return { rows: [customerRow] };
      if (sql.includes('FROM ADDRESSES')) {
        return { rows: [{ id: 'address-1', full_name: 'Ananya Natarajan', phone: '9876543210', line1: '12 Temple Road', line2: null, landmark: null, city: 'Chennai', state_code: 'TN', country_code: 'IN', pincode: '600001', is_default: true }] };
      }
      throw new Error(`Unexpected directory query: ${sql}`);
    },
  };
  delete require.cache[serviceModulePath];
  require.cache[databaseModulePath] = { exports: pool };
  const service = require('../src/modules/customers/customerDirectory.service');
  t.after(() => {
    delete require.cache[serviceModulePath];
    if (originalServiceModule) require.cache[serviceModulePath] = originalServiceModule;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
  });
  return { service, calls };
};

test('customer directory validates pagination, search, and customer identifiers', () => {
  const list = listCustomersSchema.validate({ body: {}, params: {}, query: { page: 2, limit: 25, search: 'Ananya' } });
  assert.equal(list.error, undefined);
  assert.equal(list.value.query.search, 'Ananya');
  assert.ok(customerIdSchema.validate({ body: {}, params: { customerId: '../customer-1' }, query: {} }).error);
  assert.ok(listCustomersSchema.validate({ body: {}, params: {}, query: { page: 0 } }).error);
  assert.ok(listCustomersSchema.validate({ body: {}, params: {}, query: { limit: 101 } }).error);
  assert.ok(customerOrdersSchema.validate({ body: {}, params: { customerId: 'customer-1' }, query: { page: 1, limit: 20 } }).error === undefined);
  assert.ok(customerOrdersSchema.validate({ body: {}, params: { customerId: 'customer-1' }, query: { limit: 101 } }).error);
});

test('customer-directory request validation returns safe errors before the service runs', () => {
  const middleware = validateRequest(listCustomersSchema);
  const nextError = middleware({ body: {}, params: {}, query: { page: '0' } }, {}, (error) => error);
  assert.equal(nextError?.statusCode, 400);
  assert.equal(nextError?.errorCode, 'VALIDATION_ERROR');
});

test('ADMIN and SUPPORT may access the directory while customers are rejected', () => {
  const middleware = authorize({ roles: ['ADMIN', 'SUPPORT'] });
  const allow = (roleCode, customerId = null) => middleware({ user: { role_code: roleCode, customer_id: customerId } }, {}, (error) => error);
  assert.equal(allow('ADMIN'), undefined);
  assert.equal(allow('SUPPORT'), undefined);
  assert.equal(allow(null, 'customer-1')?.statusCode, 403);
});

test('directory list is tenant-scoped, paginated, searchable, and returns no sensitive auth fields', async (t) => {
  const { service, calls } = loadService(t);
  const result = await service.list('t1', { page: 2, limit: 20, search: 'Ananya' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parameters[0], 't1');
  assert.equal(calls[0].parameters[1], '%Ananya%');
  assert.deepEqual(result.pagination, { page: 2, limit: 20, total: 1, totalPages: 1, hasNext: false, hasPrevious: true });
  assert.deepEqual(result.customers[0], {
    id: 'customer-1', fullName: 'Ananya Natarajan', email: 'ananya@example.invalid', phone: '9876543210',
    createdAt: '2026-09-20T00:00:00.000Z', status: 'ACTIVE', addressCount: 2, orderCount: 3,
    totalPaidOrderValue: 4500, authMethod: 'PASSWORD',
  });
  assert.equal('password_hash' in result.customers[0], false);
  assert.equal('google_subject' in result.customers[0], false);
});

test('customer detail is tenant-scoped and returns only the customer saved addresses', async (t) => {
  const { service, calls } = loadService(t);
  const detail = await service.getById('t1', 'customer-1');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].parameters, ['t1', 'customer-1']);
  assert.deepEqual(calls[1].parameters, ['t1', 'customer-1']);
  assert.equal(detail.addresses.length, 1);
  assert.equal(detail.orderCount, 3);
  assert.equal(detail.totalPaidOrderValue, 4500);
  assert.equal(detail.latestOrderDate, '2026-09-22T00:00:00.000Z');
  await assert.rejects(service.getById('t2', 'customer-1'), /Customer not found/);
});

test('customer orders are tenant/customer scoped, paginated, and expose only order-safe fields', async (t) => {
  const { service, calls } = loadService(t);
  const result = await service.listOrders('t1', 'customer-1', { page: 1, limit: 20 });
  assert.deepEqual(calls[0].parameters, ['t1', 'customer-1']);
  assert.equal(result.orders.length, 1);
  assert.deepEqual(result.orders[0], {
    orderReference: 'SGN-ORDER-1', orderDate: '2026-09-22T00:00:00.000Z', paymentStatus: 'PAID',
    status: 'PROCESSING', totalAmount: 4500, currency: 'INR',
  });
  assert.deepEqual(result.pagination, { page: 1, limit: 20, total: 1, totalPages: 1, hasNext: false, hasPrevious: false });
  await assert.rejects(service.listOrders('t2', 'customer-1', { page: 1, limit: 20 }), /Customer not found/);
});
