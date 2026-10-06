const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.CHECKOUT_OTP_SECRET ||= 'test-checkout-otp-secret';

const { createCheckoutIdentityService, SESSION_STATES } = require('../src/modules/checkout/checkoutIdentity.service');
const {
  checkoutPasswordSchema,
  checkoutRegistrationSchema,
  checkoutGoogleSchema,
  checkoutOtpVerifySchema,
} = require('../src/modules/checkout/checkoutIdentity.validator');

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const RESUME_TOKEN = 'r'.repeat(43);
const NOW = new Date('2026-09-23T00:00:00.000Z');

const draft = (overrides = {}) => ({
  email_normalized: 'buyer@example.com',
  contact_draft: { fullName: 'Buyer Name', phone: '9876543210' },
  address_draft: {
    fullName: 'Buyer Name', phone: '9876543210', addressLine1: '1 Temple Street', addressLine2: null,
    landmark: null, city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'IN',
  },
  cart_draft: [{ productId: 'product-1', quantity: 1 }],
  ...overrides,
});

const customerAuth = (overrides = {}) => ({
  id: 'auth-existing', email: 'buyer@example.com', password_hash: 'hash', is_active: true,
  customer_id: 'customer-existing', staff_user_id: null, customer_name: 'Existing Name',
  staff_name: null, role_id: null, role_code: null, user_type: 'customer', ...overrides,
});

const createHarness = ({
  sessionOverrides = {},
  existingByEmail = null,
  googleBySubject = null,
  verifyPassword = async () => {},
  createCustomerAuth,
  verifyGoogleIdentity = async () => ({ subject: 'google-subject', email: 'buyer@example.com', fullName: 'Google Buyer' }),
  cartInvalid = [],
  sendOtp = async () => {},
} = {}) => {
  const state = {
    sessions: [{
      id: 'a6c5e6b1-5e01-4b79-8866-0182b4d74012', tenant_id: 't1', resume_token_hash: hash(RESUME_TOKEN),
      state: SESSION_STATES.IDENTITY_REQUIRED, customer_id: null, expires_at: new Date('2026-09-23T01:00:00.000Z'),
      completed_at: null, created_at: NOW, updated_at: NOW, ...draft(), ...sessionOverrides,
    }],
    profiles: new Map([['customer-existing', { id: 'customer-existing', full_name: 'Existing Name', phone: null }]]),
    addresses: [],
    createdCustomers: [],
    issued: [],
    verifications: [],
    calls: [],
  };
  const client = {
    async query(sql, params = []) {
      state.calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM CHECKOUT_EMAIL_VERIFICATIONS')) {
        const verification = state.verifications.find((entry) => entry.tenant_id === params[0] && entry.checkout_session_id === params[1]);
        return { rows: verification ? [verification] : [] };
      }
      if (sql.includes('INSERT INTO CHECKOUT_EMAIL_VERIFICATIONS')) {
        state.verifications.push({ id: params[0], tenant_id: params[1], checkout_session_id: params[2], email_normalized: params[3], code_hash: params[4], expires_at: params[5], next_resend_at: params[6], send_count: 1, attempt_count: 0, consumed_at: null });
        return { rows: [] };
      }
      if (sql.includes('SET code_hash = $1')) {
        const verification = state.verifications.find((entry) => entry.id === params[3]);
        Object.assign(verification, { code_hash: params[0], expires_at: params[1], next_resend_at: params[2], send_count: verification.send_count + 1, attempt_count: 0 });
        return { rows: [] };
      }
      if (sql.includes('SET attempt_count = attempt_count + 1')) {
        const verification = state.verifications.find((entry) => entry.id === params[0]);
        verification.attempt_count += 1;
        return { rows: [] };
      }
      if (sql.includes('SET consumed_at = now()')) {
        const verification = state.verifications.find((entry) => entry.id === params[0] && !entry.consumed_at);
        if (verification) verification.consumed_at = NOW;
        return { rows: verification ? [{ id: verification.id }] : [] };
      }
      if (sql.includes('FROM CHECKOUT_SESSIONS') && sql.includes('resume_token_hash')) {
        const row = state.sessions.find((entry) => entry.tenant_id === params[0] && entry.resume_token_hash === params[1]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('SET state = $1, updated_at = now()')) {
        const row = state.sessions.find((entry) => entry.id === params[1]);
        row.state = params[0];
        return { rows: [] };
      }
      if (sql.includes('FROM AUTH a') && sql.includes('a.customer_id = $2')) {
        const profile = state.profiles.get(params[1]);
        return { rows: profile ? [customerAuth({ customer_id: params[1], customer_name: profile.full_name })] : [] };
      }
      if (sql.includes('UPDATE CUSTOMERS')) {
        const profile = state.profiles.get(params[0]);
        if (!profile) return { rows: [] };
        if (!profile.full_name) profile.full_name = params[2];
        if (!profile.phone) profile.phone = params[3];
        return { rows: [profile] };
      }
      if (sql.includes('UPDATE CHECKOUT_SESSIONS') && sql.includes('customer_id = $1')) {
        const row = state.sessions.find((entry) => entry.id === params[2] && entry.tenant_id === params[3]);
        if (!row || (row.customer_id && row.customer_id !== params[0])) return { rows: [] };
        row.customer_id = params[0];
        row.state = params[1];
        return { rows: [{ id: row.id, state: row.state, customer_id: row.customer_id, expires_at: row.expires_at }] };
      }
      if (sql.includes('FROM TENANTS')) return { rows: [{ id: params[0] }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const database = { connect: async () => client, query: (...args) => client.query(...args) };
  const carts = {
    async validateItems(tenantId, items) {
      assert.equal(tenantId, 't1');
      const invalidItems = items.filter((item) => cartInvalid.includes(item.productId)).map((item) => ({ productId: item.productId }));
      const validItems = items.filter((item) => !cartInvalid.includes(item.productId)).map((item) => ({ ...item, unitPrice: 100, lineSubtotal: 100, product: { id: item.productId } }));
      return { items: validItems, invalidItems, subtotal: validItems.length * 100 };
    },
  };
  const addresses = {
    async createInTransaction(_client, tenantId, customerId, address) {
      assert.equal(tenantId, 't1');
      const duplicate = state.addresses.find((entry) => entry.customerId === customerId && entry.addressLine1 === address.addressLine1);
      if (duplicate) return duplicate;
      const created = { id: `address-${state.addresses.length + 1}`, customerId, ...address };
      state.addresses.push(created);
      return created;
    },
  };
  const auth = {
    async findAuthByEmail(_client, _tenantId, email) {
      return existingByEmail && email === existingByEmail.email ? existingByEmail : null;
    },
    async findAuthByGoogleSubject(_client, _tenantId, subject) {
      return googleBySubject && subject === 'google-subject' ? googleBySubject : null;
    },
    assertActive(record) { if (!record?.is_active) throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 }); },
    assertCustomer(record) { if (!record?.customer_id || record.staff_user_id) throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 }); },
    verifyPassword,
    async createCustomerAuth(_client, tenantId, values) {
      if (createCustomerAuth) return createCustomerAuth(_client, tenantId, values, state);
      const created = customerAuth({ id: 'auth-new', customer_id: 'customer-new', customer_name: values.fullName, email: values.email });
      state.profiles.set(created.customer_id, { id: created.customer_id, full_name: values.fullName, phone: null });
      state.createdCustomers.push(created);
      return created;
    },
    verifyGoogleIdentity,
    async issueSession(_client, record, tenantId) {
      const session = { accessToken: `access-${state.issued.length + 1}`, refreshToken: `refresh-${state.issued.length + 1}`, user: { customer_id: record.customer_id }, tenantId };
      state.issued.push(session);
      return session;
    },
  };
  return {
    state,
    service: createCheckoutIdentityService({ database, carts, addresses, auth, now: () => NOW, sendOtp }),
  };
};

const call = (service, method, overrides = {}) => service[method]({ tenantId: 't1', resumeToken: RESUME_TOKEN, password: 'ValidPass1', ...overrides });

test('new password customer finalizes atomically, links the session, and receives the normal session shape', async () => {
  const { service, state } = createHarness();
  const result = await call(service, 'finalizeRegistration');
  assert.equal(state.createdCustomers.length, 1);
  assert.equal(state.sessions[0].customer_id, 'customer-new');
  assert.equal(state.sessions[0].state, SESSION_STATES.IDENTITY_VERIFIED);
  assert.equal(state.addresses.length, 1);
  assert.equal(result.addressId, 'address-1');
  assert.equal(result.authentication.user.customer_id, 'customer-new');
  assert.equal(JSON.stringify(state.sessions[0]).includes('ValidPass1'), false);
});

test('an existing password customer is verified and linked, while a wrong password leaves no side effects', async () => {
  const existing = customerAuth();
  const success = createHarness({ existingByEmail: existing });
  await call(success.service, 'finalizePassword');
  assert.equal(success.state.sessions[0].customer_id, 'customer-existing');

  const failure = createHarness({ existingByEmail: existing, verifyPassword: async () => { throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 }); } });
  await assert.rejects(call(failure.service, 'finalizePassword'), (error) => error.statusCode === 401);
  assert.equal(failure.state.sessions[0].customer_id, null);
  assert.equal(failure.state.addresses.length, 0);
});

test('staff identity cannot enter customer checkout and browser customer identifiers are absent from validators', () => {
  const staff = customerAuth({ customer_id: null, staff_user_id: 'staff-1' });
  const { service, state } = createHarness({ existingByEmail: staff });
  return assert.rejects(call(service, 'finalizePassword'), (error) => error.statusCode === 401).then(() => {
    assert.equal(state.sessions[0].customer_id, null);
    const validated = checkoutPasswordSchema.validate({ body: { password: 'x', customer_id: 'other', tenant_id: 't2' }, params: {}, query: {} }, { stripUnknown: true });
    assert.equal(validated.error, undefined);
    assert.equal(Object.hasOwn(validated.value.body, 'customer_id'), false);
    assert.equal(Object.hasOwn(validated.value.body, 'tenant_id'), false);
  });
});

test('Google finalization links only the verified subject and never auto-links a matching password email', async () => {
  const existingGoogle = customerAuth({ email: 'buyer@example.com', customer_id: 'customer-google' });
  const linked = createHarness({ googleBySubject: existingGoogle });
  linked.state.profiles.set('customer-google', { id: 'customer-google', full_name: null, phone: null });
  const result = await call(linked.service, 'finalizeGoogle', { idToken: 'id-token', password: undefined });
  assert.equal(result.customer.id, 'customer-google');

  const blocked = createHarness({ existingByEmail: customerAuth({ email: 'buyer@example.com' }) });
  await assert.rejects(call(blocked.service, 'finalizeGoogle', { idToken: 'id-token', password: undefined }), (error) => error.statusCode === 409);
  assert.equal(blocked.state.sessions[0].customer_id, null);
  assert.equal(blocked.state.addresses.length, 0);
});

test('a verified new Google customer uses the existing provider semantics without storing provider credentials in the session', async () => {
  const { service, state } = createHarness();
  const result = await call(service, 'finalizeGoogle', { idToken: 'id-token', password: undefined });
  assert.equal(state.createdCustomers.length, 1);
  assert.equal(result.authentication.user.customer_id, 'customer-new');
  assert.equal(JSON.stringify(state.sessions[0]).includes('id-token'), false);
});

test('cross-tenant, expired, completed, stale, and conflicting identity attempts are rejected before address handoff', async () => {
  const crossTenant = createHarness({ existingByEmail: customerAuth() });
  await assert.rejects(crossTenant.service.finalizePassword({ tenantId: 't2', resumeToken: RESUME_TOKEN, password: 'ValidPass1' }), (error) => error.statusCode === 404);

  const expired = createHarness({ existingByEmail: customerAuth(), sessionOverrides: { expires_at: new Date('2026-09-22T23:00:00.000Z') } });
  await assert.rejects(call(expired.service, 'finalizePassword'), (error) => error.statusCode === 404);
  assert.equal(expired.state.addresses.length, 0);

  const completed = createHarness({ existingByEmail: customerAuth(), sessionOverrides: { state: SESSION_STATES.COMPLETED, completed_at: NOW } });
  await assert.rejects(call(completed.service, 'finalizePassword'), (error) => error.statusCode === 409);

  const stale = createHarness({ existingByEmail: customerAuth(), cartInvalid: ['product-1'] });
  await assert.rejects(call(stale.service, 'finalizePassword'), (error) => error.statusCode === 400);
  assert.equal(stale.state.addresses.length, 0);

  const linked = createHarness({ googleBySubject: customerAuth(), sessionOverrides: { state: SESSION_STATES.IDENTITY_VERIFIED, customer_id: 'customer-other' } });
  linked.state.profiles.set('customer-other', { id: 'customer-other', full_name: 'Other', phone: '9999999999' });
  await assert.rejects(call(linked.service, 'finalizeGoogle', { idToken: 'id-token', password: undefined }), (error) => error.statusCode === 409);
});

test('repeated same-identity finalization is safe, fills only missing profile values, and reuses the address-module duplicate behavior', async () => {
  const existing = customerAuth();
  const { service, state } = createHarness({ existingByEmail: existing });
  const first = await call(service, 'finalizePassword');
  const second = await call(service, 'finalizePassword');
  assert.equal(first.addressId, second.addressId);
  assert.equal(state.addresses.length, 1);
  assert.equal(state.profiles.get('customer-existing').full_name, 'Existing Name');
  assert.equal(state.profiles.get('customer-existing').phone, '9876543210');
  assert.equal(state.issued.length, 2);
});

test('an already authenticated customer can finalize only their matching checkout draft without a password', async () => {
  const { service, state } = createHarness({
    sessionOverrides: { state: SESSION_STATES.IDENTITY_REQUIRED, customer_id: 'customer-existing' },
  });
  const result = await service.finalizeCurrentCustomer({ tenantId: 't1', resumeToken: RESUME_TOKEN, customerId: 'customer-existing' });
  assert.equal(result.customer.id, 'customer-existing');
  assert.equal(state.addresses[0].customerId, 'customer-existing');

  const mismatched = createHarness({
    sessionOverrides: { customer_id: 'customer-existing', email_normalized: 'other@example.com' },
  });
  await assert.rejects(
    mismatched.service.finalizeCurrentCustomer({ tenantId: 't1', resumeToken: RESUME_TOKEN, customerId: 'customer-existing' }),
    (error) => error.statusCode === 409
  );
  assert.equal(mismatched.state.addresses.length, 0);
});

test('concurrent uniqueness collision is neutral and leaves no address/customer linkage for the losing request', async () => {
  const { service, state } = createHarness({
    createCustomerAuth: async () => {
      const error = new Error('duplicate key');
      error.code = '23505';
      throw error;
    },
  });
  await assert.rejects(call(service, 'finalizeRegistration'), (error) => error.statusCode === 409 && error.errorCode === 'RESOURCE_CONFLICT');
  assert.equal(state.sessions[0].customer_id, null);
  assert.equal(state.addresses.length, 0);
});

test('identity validators enforce password, confirmation, and Google-token bounds without accepting ownership input', () => {
  assert.ok(checkoutRegistrationSchema.validate({ body: { password: 'weak', confirmPassword: 'weak' }, params: {}, query: {} }).error);
  assert.equal(checkoutRegistrationSchema.validate({ body: { password: 'ValidPass1', confirmPassword: 'ValidPass1' }, params: {}, query: {} }).error, undefined);
  assert.ok(checkoutGoogleSchema.validate({ body: { idToken: 'x'.repeat(4097) }, params: {}, query: {} }).error);
  assert.equal(checkoutOtpVerifySchema.validate({ body: { code: '123456' }, params: {}, query: {} }).error, undefined);
  assert.ok(checkoutOtpVerifySchema.validate({ body: { code: '12345x' }, params: {}, query: {} }).error);
});

test('email OTP is hashed, scoped to the checkout, single-use, and finalizes only after email proof', async () => {
  let delivered;
  const { service, state } = createHarness({ sendOtp: async (message) => { delivered = message; } });
  const sent = await service.requestEmailOtp({ tenantId: 't1', resumeToken: RESUME_TOKEN });
  assert.ok(sent.expiresAt);
  assert.match(delivered.code, /^\d{6}$/);
  assert.equal(state.verifications.length, 1);
  assert.notEqual(state.verifications[0].code_hash, delivered.code);

  await assert.rejects(
    service.verifyEmailOtp({ tenantId: 't1', resumeToken: RESUME_TOKEN, code: '000000' }),
    (error) => error.statusCode === 401
  );
  const result = await service.verifyEmailOtp({ tenantId: 't1', resumeToken: RESUME_TOKEN, code: delivered.code });
  assert.equal(result.customer.id, 'customer-new');
  assert.ok(state.verifications[0].consumed_at);
  assert.equal(state.addresses.length, 1);
  await assert.rejects(
    service.verifyEmailOtp({ tenantId: 't1', resumeToken: RESUME_TOKEN, code: delivered.code }),
    (error) => error.statusCode === 401
  );
});

test('email OTP links a same-tenant existing customer only after code verification', async () => {
  let delivered;
  const { service, state } = createHarness({ existingByEmail: customerAuth(), sendOtp: async (message) => { delivered = message; } });
  await service.requestEmailOtp({ tenantId: 't1', resumeToken: RESUME_TOKEN });
  assert.equal(state.sessions[0].customer_id, null);
  await service.verifyEmailOtp({ tenantId: 't1', resumeToken: RESUME_TOKEN, code: delivered.code });
  assert.equal(state.sessions[0].customer_id, 'customer-existing');
  assert.equal(state.createdCustomers.length, 0);
});
