const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { createCheckoutSessionService, hashSecret, SESSION_STATES } = require('../src/modules/checkout/checkoutSession.service');
const { startCheckoutSessionSchema, updateCheckoutSessionSchema } = require('../src/modules/checkout/checkoutSession.validator');
const { requireCheckoutResumeToken } = require('../src/modules/checkout/checkoutSession.middleware');
const Logger = require('../src/utils/logger');

const checkoutSessionServiceModulePath = require.resolve('../src/modules/checkout/checkoutSession.service');
const checkoutSessionControllerModulePath = require.resolve('../src/modules/checkout/checkoutSession.controller');

const loadCheckoutSessionController = (t, checkoutSessionService) => {
  const originalService = require.cache[checkoutSessionServiceModulePath];
  const originalController = require.cache[checkoutSessionControllerModulePath];
  delete require.cache[checkoutSessionControllerModulePath];
  require.cache[checkoutSessionServiceModulePath] = { exports: checkoutSessionService };
  const controller = require('../src/modules/checkout/checkoutSession.controller');
  t.after(() => {
    delete require.cache[checkoutSessionControllerModulePath];
    if (originalController) require.cache[checkoutSessionControllerModulePath] = originalController;
    if (originalService) require.cache[checkoutSessionServiceModulePath] = originalService;
    else delete require.cache[checkoutSessionServiceModulePath];
  });
  return controller;
};

const responseRecorder = () => {
  const response = { statusCode: null, body: null };
  response.status = (statusCode) => { response.statusCode = statusCode; return response; };
  response.json = (body) => { response.body = body; return response; };
  return response;
};

const createPool = ({ customers = ['customer-a'], currentTime = new Date('2026-09-23T00:00:00.000Z') } = {}) => {
  const state = { rows: [], calls: [], customers: new Set(customers), now: currentTime };
  const client = {
    async query(sql, parameters = []) {
      state.calls.push({ sql, parameters });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM CUSTOMERS')) {
        return { rows: state.customers.has(parameters[0]) && parameters[1] === 't1' ? [{ id: parameters[0] }] : [] };
      }
      if (sql.includes('INSERT INTO CHECKOUT_SESSIONS')) {
        const row = {
          id: parameters[0], tenant_id: parameters[1], resume_token_hash: parameters[2], start_idempotency_hash: parameters[3],
          state: parameters[4], customer_id: parameters[5], cart_draft: JSON.parse(parameters[6]), contact_draft: {}, address_draft: null,
          email_normalized: null, expires_at: parameters[7], created_at: parameters[8], updated_at: parameters[8], completed_at: null,
        };
        state.rows.push(row);
        return { rows: [row] };
      }
      if (sql.includes('start_idempotency_hash')) {
        const existing = state.rows.find((row) => row.tenant_id === parameters[0] && row.start_idempotency_hash === parameters[1]);
        return { rows: existing ? [{ id: existing.id }] : [] };
      }
      if (sql.includes('WHERE tenant_id = $1 AND resume_token_hash = $2')) {
        const row = state.rows.find((item) => item.tenant_id === parameters[0] && item.resume_token_hash === parameters[1]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('SET state = $1, updated_at = now()')) {
        const row = state.rows.find((item) => item.id === parameters[1] && item.tenant_id === parameters[2]);
        row.state = parameters[0];
        return { rows: [] };
      }
      if (sql.includes('SET state = $1, email_normalized = $2')) {
        const row = state.rows.find((item) => item.id === parameters[5] && item.tenant_id === parameters[6]);
        row.state = parameters[0];
        row.email_normalized = parameters[1];
        row.contact_draft = JSON.parse(parameters[2]);
        row.address_draft = parameters[3] ? JSON.parse(parameters[3]) : null;
        row.cart_draft = JSON.parse(parameters[4]);
        return { rows: [row] };
      }
      if (sql.includes('SET state = $1, completed_at = now()')) {
        const row = state.rows.find((item) => item.id === parameters[1] && item.tenant_id === parameters[2]);
        row.state = parameters[0];
        row.completed_at = state.now;
        return { rows: [row] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  return { state, connect: async () => client };
};

const createCarts = () => {
  const calls = [];
  return {
    calls,
    async validateItems(tenantId, items) {
      calls.push({ tenantId, items });
      const invalidItems = items.filter((item) => item.productId === 'stale-product').map((item) => ({ productId: item.productId, code: 'PRODUCT_UNAVAILABLE' }));
      const validItems = items.filter((item) => item.productId !== 'stale-product').map((item) => ({
        ...item, unitPrice: 100, lineSubtotal: item.quantity * 100, product: { id: item.productId, name: 'Safe product' },
      }));
      return { items: validItems, invalidItems, subtotal: validItems.reduce((total, item) => total + item.lineSubtotal, 0) };
    },
  };
};

const createService = (options = {}) => {
  const database = createPool(options);
  const carts = createCarts();
  let tokenSequence = 0;
  const service = createCheckoutSessionService({
    database,
    carts,
    now: () => database.state.now,
    tokenGenerator: () => String(++tokenSequence).padStart(43, 'a'),
  });
  return { service, database, carts };
};

const startInput = (overrides = {}) => ({
  tenantId: 't1', items: [{ productId: 'product-1', quantity: 2 }], idempotencyKey: 'start-key-1234567890', ...overrides,
});

test('anonymous checkout session start succeeds and stores only hashes plus a minimal cart', async () => {
  const { service, database } = createService();
  const result = await service.start(startInput());
  const row = database.state.rows[0];
  assert.equal(result.state, SESSION_STATES.STARTED);
  assert.equal(result.resumeToken.length, 43);
  assert.equal(row.customer_id, null);
  assert.equal(row.resume_token_hash, hashSecret(result.resumeToken));
  assert.notEqual(row.resume_token_hash, result.resumeToken);
  assert.deepEqual(row.cart_draft, [{ productId: 'product-1', quantity: 2 }]);
  assert.equal(Object.hasOwn(row, 'price'), false);
  assert.equal(database.state.calls.some((call) => /FROM (AUTH|ADDRESSES|ORDERS|PAYMENTS)/i.test(call.sql)), false);
});

test('authenticated customer context is linked only after tenant-scoped customer verification', async () => {
  const { service, database } = createService();
  await service.start(startInput({ customerId: 'customer-a' }));
  assert.equal(database.state.rows[0].customer_id, 'customer-a');
  const customerLookup = database.state.calls.find((call) => call.sql.includes('FROM CUSTOMERS'));
  assert.deepEqual(customerLookup.parameters, ['customer-a', 't1']);
});

test('session-start controller derives customer ownership only from a verified customer session', async (t) => {
  const received = [];
  const controller = loadCheckoutSessionController(t, {
    async start(input) { received.push(input); return { resumeToken: 'safe', state: 'STARTED' }; },
  });
  const res = responseRecorder();
  await controller.start({
    tenantId: 't1',
    user: { customer_id: 'customer-from-session', staff_user_id: null },
    body: { items: [], idempotencyKey: 'start-key-1234567890', customer_id: 'customer-from-body' },
  }, res);
  assert.equal(received[0].customerId, 'customer-from-session');
  assert.equal(res.statusCode, 201);
});

test('request validators strip customer_id and tenant_id from checkout-session inputs', () => {
  const start = startCheckoutSessionSchema.validate({
    body: { items: [{ productId: 'product-1', quantity: 1 }], idempotencyKey: 'start-key-1234567890', customer_id: 'other', tenant_id: 't2' }, params: {}, query: {},
  }, { stripUnknown: true, allowUnknown: false });
  assert.equal(start.error, undefined);
  assert.equal(Object.hasOwn(start.value.body, 'customer_id'), false);
  assert.equal(Object.hasOwn(start.value.body, 'tenant_id'), false);
});

test('resume requires the opaque token and cannot use an internal database id or another tenant', async () => {
  const { service, database } = createService();
  const started = await service.start(startInput());
  await assert.rejects(service.resume({ tenantId: 't1', resumeToken: database.state.rows[0].id }), (error) => error.statusCode === 404);
  await assert.rejects(service.resume({ tenantId: 't2', resumeToken: started.resumeToken }), (error) => error.statusCode === 404);
  await assert.rejects(service.resume({ tenantId: 't1', resumeToken: 'b'.repeat(43) }), (error) => error.statusCode === 404);
  const resumed = await service.resume({ tenantId: 't1', resumeToken: started.resumeToken });
  assert.equal(resumed.state, SESSION_STATES.STARTED);
  assert.equal(Object.hasOwn(resumed, 'customerId'), false);
});

test('expired sessions are marked unusable and completed sessions cannot mutate', async () => {
  const { service, database } = createService({ currentTime: new Date('2026-09-23T00:00:00.000Z') });
  const started = await service.start(startInput());
  database.state.rows[0].expires_at = new Date('2026-09-22T23:00:00.000Z');
  await assert.rejects(service.resume({ tenantId: 't1', resumeToken: started.resumeToken }), (error) => error.statusCode === 404);
  assert.equal(database.state.rows[0].state, SESSION_STATES.EXPIRED);

  const active = await service.start(startInput({ idempotencyKey: 'another-start-key-123456' }));
  await service.markCompleted({ tenantId: 't1', resumeToken: active.resumeToken });
  await assert.rejects(
    service.updateDraft({ tenantId: 't1', resumeToken: active.resumeToken, input: { email: 'new@example.com' } }),
    (error) => error.statusCode === 409
  );

  const verified = await service.start(startInput({ idempotencyKey: 'verified-start-key-123456' }));
  database.state.rows.find((row) => row.resume_token_hash === hashSecret(verified.resumeToken)).state = SESSION_STATES.IDENTITY_VERIFIED;
  await assert.rejects(
    service.updateDraft({ tenantId: 't1', resumeToken: verified.resumeToken, input: { email: 'new@example.com' } }),
    (error) => error.statusCode === 409
  );
});

test('contact and address drafts validate, normalize, and never create an address or identity', async () => {
  const { service, database } = createService();
  const started = await service.start(startInput());
  const updated = await service.updateDraft({
    tenantId: 't1', resumeToken: started.resumeToken,
    input: {
      email: '  CUSTOMER@Example.COM ', fullName: ' Customer Name ', phone: '98765 43210',
      address: {
        fullName: ' Customer Name ', phone: '98765 43210', addressLine1: '1 Temple Street', addressLine2: '', landmark: '',
        city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'in',
      },
    },
  });
  assert.equal(updated.email, 'customer@example.com');
  assert.equal(updated.contact.phone, '+919876543210');
  assert.equal(updated.address.phone, '+919876543210');
  assert.equal(updated.address.country, 'IN');
  assert.equal(updated.state, SESSION_STATES.IDENTITY_REQUIRED);
  assert.equal(database.state.calls.some((call) => /\b(INSERT INTO ADDRESSES|INSERT INTO CUSTOMERS|INSERT INTO AUTH)\b/i.test(call.sql)), false);
});

test('validation rejects malformed contact/address and bounds oversized cart payloads', () => {
  const contact = updateCheckoutSessionSchema.validate({ body: { email: 'not-an-email' }, params: {}, query: {} });
  assert.ok(contact.error);
  const address = updateCheckoutSessionSchema.validate({
    body: { address: { fullName: 'A', phone: 'bad', addressLine1: 'x', city: '', state: '', pincode: '12', country: 'IND' } }, params: {}, query: {},
  });
  assert.ok(address.error);
  const international = updateCheckoutSessionSchema.validate({
    body: { address: { fullName: 'A Customer', phone: '+14155552671', addressLine1: '1 Main Street', city: 'New York', state: 'New York', pincode: '10001', country: 'US' } }, params: {}, query: {},
  });
  assert.equal(international.error, undefined);
  const oversized = startCheckoutSessionSchema.validate({
    body: { items: Array.from({ length: 101 }, (_, index) => ({ productId: `product-${index}`, quantity: 1 })), idempotencyKey: 'start-key-1234567890' }, params: {}, query: {},
  });
  assert.ok(oversized.error);
});

test('blank address recipient fields return validation details before any checkout-session mutation', () => {
  const result = updateCheckoutSessionSchema.validate({
    body: {
      address: {
        fullName: '', phone: '', addressLine1: '12 Temple Road', addressLine2: '', landmark: '',
        city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'IN',
      },
    }, params: {}, query: {},
  }, { abortEarly: false });
  assert.ok(result.error);
  assert.deepEqual(result.error.details.map((detail) => detail.path.join('.')).sort(), [
    'body.address.fullName', 'body.address.phone',
  ]);
});

test('cart drafts are revalidated on update and resume, with stale products reported safely', async () => {
  const { service, carts } = createService();
  const started = await service.start(startInput());
  await assert.rejects(
    service.updateDraft({ tenantId: 't1', resumeToken: started.resumeToken, input: { items: [{ productId: 'stale-product', quantity: 1 }] } }),
    (error) => error.statusCode === 400 && error.errorCode === 'VALIDATION_ERROR'
  );
  const resumed = await service.resume({ tenantId: 't1', resumeToken: started.resumeToken });
  assert.deepEqual(resumed.cartValidation.invalidItems, []);
  assert.ok(carts.calls.length >= 3);
});

test('email capture never queries AUTH or changes response shape based on account presence', async () => {
  const { service, database } = createService();
  const started = await service.start(startInput());
  const result = await service.updateDraft({ tenantId: 't1', resumeToken: started.resumeToken, input: { email: 'existing@example.com' } });
  assert.deepEqual(Object.keys(result).sort(), ['address', 'cart', 'cartValidation', 'contact', 'email', 'expiresAt', 'state']);
  assert.equal(database.state.calls.some((call) => /\bAUTH\b/i.test(call.sql)), false);
});

test('duplicate start idempotency keys are rejected safely rather than creating a second session', async () => {
  const { service, database } = createService();
  await service.start(startInput());
  await assert.rejects(service.start(startInput()), (error) => error.statusCode === 409);
  assert.equal(database.state.rows.length, 1);
});

test('resume-token middleware rejects malformed credentials without accepting a database id as authorization', () => {
  let missingError;
  requireCheckoutResumeToken({ get: () => '' }, {}, (error) => { missingError = error; });
  assert.equal(missingError.statusCode, 401);
  let validNext = false;
  requireCheckoutResumeToken({ get: () => 'a'.repeat(43) }, {}, (error) => { assert.equal(error, undefined); validNext = true; });
  assert.equal(validNext, true);
});

test('normal logging masks contact PII and checkout-session service emits no draft logs', async () => {
  assert.deepEqual(Logger.maskSensitive({ email: 'customer@example.com', phone: '9876543210', body: { address: 'private' } }), {
    email: '***', phone: '***', body: '***',
  });
  const { service } = createService();
  await service.start(startInput());
  const started = await service.start(startInput({ idempotencyKey: 'logging-start-key-12345' }));
  await service.updateDraft({ tenantId: 't1', resumeToken: started.resumeToken, input: { email: 'customer@example.com' } });
});
