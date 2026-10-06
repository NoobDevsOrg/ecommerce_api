const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const databaseModulePath = require.resolve('../src/config/db');
const productServiceModulePath = require.resolve('../src/modules/products/product.service');
const productControllerModulePath = require.resolve('../src/modules/products/product.controller');

const loadProductService = (t, pool) => {
  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalServiceModule = require.cache[productServiceModulePath];
  delete require.cache[productServiceModulePath];
  require.cache[databaseModulePath] = { exports: pool };
  const service = require('../src/modules/products/product.service');
  t.after(() => {
    delete require.cache[productServiceModulePath];
    if (originalServiceModule) require.cache[productServiceModulePath] = originalServiceModule;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
  });
  return service;
};

const loadProductController = (t, productService) => {
  const originalController = require.cache[productControllerModulePath];
  const originalService = require.cache[productServiceModulePath];
  delete require.cache[productControllerModulePath];
  require.cache[productServiceModulePath] = { exports: productService };
  const controller = require('../src/modules/products/product.controller');
  t.after(() => {
    delete require.cache[productControllerModulePath];
    if (originalController) require.cache[productControllerModulePath] = originalController;
    if (originalService) require.cache[productServiceModulePath] = originalService;
    else delete require.cache[productServiceModulePath];
  });
  return controller;
};

const responseRecorder = () => {
  const response = { statusCode: null, body: null };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};

test('guest enquiry is persisted with a NULL customer ownership value', async (t) => {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM PRODUCTS')) return { rows: [{ id: 'product-1' }] };
      if (sql.includes('INSERT INTO ENQUIRIES')) {
        return { rows: [{ id: 'enquiry-1', tenant_id: parameters[7], customer_id: parameters[8] }] };
      }
      if (sql.includes('FROM ENQUIRIES e')) return { rows: [{ id: 'enquiry-1', name: 'Guest', email: 'guest@example.test', phone: '9876543210', message: null, created_at: new Date().toISOString(), products: [{ id: 'product-1', name: 'Temple Haaram' }] }] };
      if (sql.includes('FROM STAFF_USERS')) return { rows: [{ id: 'staff-1', code: 'ADMIN' }] };
      if (sql.includes('INSERT INTO NOTIFICATIONS')) return { rows: [{ id: 'notification-1' }] };
      if (sql.includes('SELECT COALESCE(MAX(version)')) return { rows: [{ version: 1 }] };
      if (sql.includes('INSERT INTO AUDIT_EVENTS')) return { rows: [{ id: 'audit-1' }] };
      return { rows: [] };
    },
    release() {},
  };
  const service = loadProductService(t, { connect: async () => client });
  const enquiry = await service.processEnquiry('t1', null, {
    name: 'Guest', email: 'guest@example.test', phone: '9876543210',
    products: [{ product_id: 'product-1', quantity: 1 }],
  });

  assert.equal(enquiry.customer_id, null);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO ENQUIRIES'));
  assert.equal(insert.parameters[7], 't1');
  assert.equal(insert.parameters[8], null);
});

test('a valid customer session is the sole source of enquiry ownership', async (t) => {
  const received = [];
  const controller = loadProductController(t, {
    async processEnquiry(...args) {
      received.push(args);
      return { id: 'enquiry-1' };
    },
  });
  const res = responseRecorder();
  await controller.handleEnquiry({
    tenantId: 't1',
    user: { customer_id: 'customer-session', staff_user_id: null },
    body: { customer_id: 'customer-from-body', name: 'Customer' },
  }, res);

  assert.deepEqual(received[0], [
    't1',
    'customer-session',
    { customer_id: 'customer-from-body', name: 'Customer' },
  ]);
  assert.equal(res.statusCode, 201);
});

test('staff sessions are never recorded as customer enquiry ownership', async (t) => {
  const received = [];
  const controller = loadProductController(t, {
    async processEnquiry(...args) {
      received.push(args);
      return { id: 'enquiry-1' };
    },
  });
  const res = responseRecorder();
  await controller.handleEnquiry({
    tenantId: 't1',
    user: { staff_user_id: 'staff-1', customer_id: null },
    body: { name: 'Staff-submitted enquiry' },
  }, res);

  assert.equal(received[0][1], null);
});

test('a customer cannot be associated with an enquiry in another tenant', async (t) => {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM CUSTOMERS')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const service = loadProductService(t, { connect: async () => client });
  await assert.rejects(
    service.processEnquiry('tenant-a', 'customer-from-tenant-b', {
      name: 'Customer', email: 'customer@example.test', phone: '9876543210',
      products: [{ product_id: 'product-a', quantity: 1 }],
    }),
    (error) => error.statusCode === 403
  );
  assert.deepEqual(calls[1].parameters, ['customer-from-tenant-b', 'tenant-a']);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO ENQUIRIES')), false);
});

test('customer_id cannot be supplied through the public enquiry body', () => {
  const { enquirySchema } = require('../src/modules/products/product.validator');
  const result = enquirySchema.validate({
    body: {
      name: 'Guest', email: 'guest@example.com', phone: '9876543210',
      customer_id: 'another-customer',
      products: [{ product_id: 'product-1', quantity: 1 }],
    },
    params: {}, query: {},
  }, { stripUnknown: true, allowUnknown: false });
  assert.equal(result.error, undefined);
  assert.equal(Object.hasOwn(result.value.body, 'customer_id'), false);
});

test('customer enquiry history is tenant/customer scoped and paginated in two queries', async (t) => {
  const calls = [];
  const service = loadProductService(t, {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('COUNT(*)::int')) return { rows: [{ total: 3 }] };
      return { rows: [{ id: 'enquiry-a', products: [] }] };
    },
  });
  const result = await service.getCustomerEnquiries('tenant-a', 'customer-a', { page: 2, limit: 2 });

  assert.equal(result.pagination.total, 3);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.totalPages, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.sql.includes('e.tenant_id = $1') && call.sql.includes('e.customer_id = $2')));
  assert.deepEqual(calls[0].parameters, ['tenant-a', 'customer-a']);
  assert.deepEqual(calls[1].parameters, ['tenant-a', 'customer-a', 2, 2]);
});

test('the customer history controller rejects a staff identity and does not expose an alternate selector', async (t) => {
  const controller = loadProductController(t, {
    async getCustomerEnquiries() {
      throw new Error('must not be called for staff');
    },
  });
  await assert.rejects(
    controller.getMyEnquiries({
      tenantId: 't1', user: { staff_user_id: 'staff-1', customer_id: null }, query: { page: 1, limit: 20 },
    }, responseRecorder()),
    (error) => error.statusCode === 403
  );
});

test('the customer history controller uses only the authenticated customer identity', async (t) => {
  const received = [];
  const controller = loadProductController(t, {
    async getCustomerEnquiries(...args) {
      received.push(args);
      return { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } };
    },
  });
  const res = responseRecorder();
  await controller.getMyEnquiries({
    tenantId: 'tenant-a',
    user: { customer_id: 'customer-a', staff_user_id: null },
    query: { page: 1, limit: 20, customer_id: 'customer-b' },
  }, res);
  assert.deepEqual(received, [['tenant-a', 'customer-a', { page: 1, limit: 20, customer_id: 'customer-b' }]]);
  assert.equal(res.statusCode, 200);
});

test('optional authentication preserves anonymous guests but rejects a malformed supplied credential', () => {
  const { optionalAuthenticate } = require('../src/middleware/auth');
  let guestNext = false;
  optionalAuthenticate({ headers: {} }, {}, (error) => {
    assert.equal(error, undefined);
    guestNext = true;
  });
  assert.equal(guestNext, true);

  let invalidError;
  optionalAuthenticate({ headers: { authorization: 'invalid' }, path: '/enquiry' }, {}, (error) => {
    invalidError = error;
  });
  assert.equal(invalidError.statusCode, 401);
});
