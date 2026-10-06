const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const databaseModulePath = require.resolve('../src/config/db');
const productServiceModulePath = require.resolve('../src/modules/products/product.service');
const tenantResolverModulePath = require.resolve('../src/middleware/tenantResolver');
const Logger = require('../src/utils/logger');
const requestLogger = require('../src/middleware/requestLogger');
const { enquirySchema } = require('../src/modules/products/product.validator');

// The product service imports the existing Supabase client for unrelated
// review administration paths. These inert values let the isolated PostgreSQL
// service tests load without contacting Supabase.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

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

test('public enquiry ignores body tenant_id and writes only the resolved tenant', async (t) => {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM PRODUCTS')) return { rows: [{ id: 'product-t1' }] };
      if (sql.includes('INSERT INTO ENQUIRIES')) return { rows: [{ id: 'enquiry-1', tenant_id: parameters[7] }] };
      if (sql.includes('FROM ENQUIRIES e')) return { rows: [{ id: 'enquiry-1', name: 'Guest', email: 'guest@example.com', phone: '9876543210', message: null, created_at: new Date().toISOString(), products: [{ id: 'product-t1', name: 'Temple Haaram' }] }] };
      if (sql.includes('FROM STAFF_USERS')) return { rows: [{ id: 'staff-1', code: 'ADMIN' }] };
      if (sql.includes('INSERT INTO NOTIFICATIONS')) return { rows: [{ id: 'notification-1' }] };
      if (sql.includes('SELECT COALESCE(MAX(version)')) return { rows: [{ version: 1 }] };
      if (sql.includes('INSERT INTO AUDIT_EVENTS')) return { rows: [{ id: 'audit-1' }] };
      return { rows: [] };
    },
    release() {},
  };
  const service = loadProductService(t, { connect: async () => client });
  const result = await service.processEnquiry('t1', null, {
    name: 'Guest', email: 'guest@example.com', phone: '9876543210',
    tenant_id: 't2', products: [{ product_id: 'product-t1', quantity: 1 }],
  });

  assert.equal(result.tenant_id, 't1');
  const productLookup = calls.find((call) => call.sql.includes('FROM PRODUCTS'));
  assert.deepEqual(productLookup.parameters, ['t1', ['product-t1']]);
  const enquiryInsert = calls.find((call) => call.sql.includes('INSERT INTO ENQUIRIES'));
  assert.equal(enquiryInsert.parameters[7], 't1');
  const itemInsert = calls.find((call) => call.sql.includes('INSERT INTO enquiry_products'));
  assert.equal(itemInsert.parameters[4], 't1');
  assert.ok(calls.some((call) => call.parameters.includes('ENQUIRY_RECEIVED')));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO NOTIFICATION_DELIVERIES')));
});

test('enquiry validation strips tenant_id and rejects invalid public product input', () => {
  const valid = enquirySchema.validate({
    body: {
      name: 'Guest', email: 'guest@example.com', phone: '9876543210', tenant_id: 't2',
      products: [{ product_id: 'product-t1', quantity: 1 }],
    }, params: {}, query: {},
  }, { stripUnknown: true, allowUnknown: false });
  assert.equal(valid.error, undefined);
  assert.equal(Object.hasOwn(valid.value.body, 'tenant_id'), false);

  const invalid = enquirySchema.validate({
    body: { name: 'Guest', email: 'guest@example.com', phone: '9876543210', products: [] }, params: {}, query: {},
  });
  assert.ok(invalid.error);
});

test('cross-tenant or unavailable enquiry products are rejected before any enquiry insert', async (t) => {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM PRODUCTS')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const service = loadProductService(t, { connect: async () => client });
  await assert.rejects(
    service.processEnquiry('tenant-a', null, {
      name: 'Guest', email: 'guest@example.com', phone: '9876543210', products: [{ product_id: 'product-tenant-b', quantity: 1 }],
    }),
    (error) => error.errorCode === 'ENQUIRY_PRODUCT_UNAVAILABLE'
  );
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO ENQUIRIES')), false);
});

test('enquiry list, count, and status update are explicitly tenant-scoped', async (t) => {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('COUNT(DISTINCT')) return { rows: [{ count: '0' }] };
      if (sql.includes('SELECT') && sql.includes('FROM enquiries')) return { rows: [] };
      if (sql.includes('UPDATE enquiries')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const service = loadProductService(t, {
    connect: async () => client,
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return { rows: [{ count: '0' }] };
    },
  });
  await service.getEnquiries('tenant-a', { page: 1, limit: 20, search: '', status: 'all' });
  await service.getEnquiryCount('tenant-a', 'new');
  await assert.rejects(service.updateEnquiryStatus('tenant-a', '00000000-0000-4000-8000-000000000001', 'closed'), (error) => error.statusCode === 404);

  const scopedQueries = calls.filter((call) => /enquiries/i.test(call.sql));
  assert.ok(scopedQueries.every((call) => call.sql.includes('tenant_id')));
  assert.ok(scopedQueries.some((call) => call.parameters[0] === 'tenant-a'));
});

const createReviewPool = () => {
  const state = { status: 'pending', reviews: [], locked: false, waiters: [] };
  const acquire = async () => {
    if (state.locked) await new Promise((resolve) => state.waiters.push(resolve));
    state.locked = true;
  };
  const release = () => {
    state.locked = false;
    state.waiters.shift()?.();
  };
  return {
    state,
    async connect() {
      let holdsLock = false;
      return {
        async query(sql, parameters = []) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql.includes('FROM review_invitations') && sql.includes('FOR UPDATE')) {
            await acquire();
            holdsLock = true;
            return { rows: [{ id: 'invite-1', tenant_id: parameters[1], enquiry_id: 'enquiry-1', product_id: 'product-1', status: state.status, expires_at: null }] };
          }
          if (sql.includes('SELECT id, name FROM enquiries')) return { rows: [{ id: 'enquiry-1', name: 'Guest' }] };
          if (sql.includes('SELECT id FROM products')) return { rows: [{ id: 'product-1' }] };
          if (sql.includes('INSERT INTO product_reviews')) {
            state.reviews.push({ invitationId: parameters[3], rating: parameters[5] });
            return { rows: [{ id: `review-${state.reviews.length}`, rating: parameters[5], review: parameters[6] }] };
          }
          if (sql.includes('UPDATE review_invitations')) {
            state.status = 'submitted';
            return { rows: [] };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (holdsLock) release();
            holdsLock = false;
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
};

test('concurrent review submissions create exactly one review and the loser is deterministic', async (t) => {
  const pool = createReviewPool();
  const service = loadProductService(t, pool);
  const results = await Promise.allSettled([
    service.submitProductReview('t1', 'invite-code', 5, 'Beautiful'),
    service.submitProductReview('t1', 'invite-code', 5, 'Beautiful'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409);
  assert.equal(pool.state.reviews.length, 1);
  assert.equal(pool.state.status, 'submitted');
});

test('an already-used review invitation returns a stable conflict', async (t) => {
  const pool = createReviewPool();
  pool.state.status = 'submitted';
  const service = loadProductService(t, pool);
  await assert.rejects(
    service.submitProductReview('t1', 'invite-code', 5, 'Beautiful'),
    (error) => error.statusCode === 409 && error.message === 'This review invitation has already been used'
  );
  assert.equal(pool.state.reviews.length, 0);
});

test('tenant resolution is deployment-controlled and ignores browser tenant input', () => {
  const originalDefault = process.env.DEFAULT_TENANT_ID;
  const originalMap = process.env.TENANT_HOST_MAP_JSON;
  try {
    process.env.DEFAULT_TENANT_ID = 't1';
    process.env.TENANT_HOST_MAP_JSON = JSON.stringify({ 'tenant-b.example.test': 'tenant-b' });
    delete require.cache[tenantResolverModulePath];
    const { resolveTenantId } = require('../src/middleware/tenantResolver');
    assert.equal(resolveTenantId({ hostname: 'tenant-b.example.test', headers: { 'x-tenant-id': 'tenant-a' } }), 'tenant-b');
    assert.throws(() => resolveTenantId({ hostname: 'attacker.example.test' }), (error) => error.statusCode === 404);
  } finally {
    if (originalDefault === undefined) delete process.env.DEFAULT_TENANT_ID;
    else process.env.DEFAULT_TENANT_ID = originalDefault;
    if (originalMap === undefined) delete process.env.TENANT_HOST_MAP_JSON;
    else process.env.TENANT_HOST_MAP_JSON = originalMap;
    delete require.cache[tenantResolverModulePath];
  }
});

test('touched logging paths mask sensitive data and omit headers and request bodies', () => {
  assert.deepEqual(Logger.maskSensitive({ email: 'guest@example.test', phone: '9876543210', headers: { authorization: 'token' }, body: { password: 'secret' } }), {
    email: '***', phone: '***', headers: '***', body: '***',
  });

  const messages = [];
  const originalInfo = Logger.info;
  Logger.info = (message, data) => messages.push({ message, data });
  try {
    const response = new EventEmitter();
    response.statusCode = 201;
    requestLogger({ method: 'POST', baseUrl: '/products', route: { path: '/enquiry' }, tenantId: 't1', user: null }, response, () => {});
    response.emit('finish');
  } finally {
    Logger.info = originalInfo;
  }
  assert.deepEqual(messages[0].data, {
    method: 'POST', route: '/products/enquiry', statusCode: 201,
    durationMs: messages[0].data.durationMs, tenantId: 't1', actorType: 'anonymous',
  });
});
