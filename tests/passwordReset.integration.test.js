const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const test = require('node:test');

process.env.JWT_SECRET ||= 'password-reset-integration-access';
process.env.JWT_REFRESH_SECRET ||= 'password-reset-integration-refresh';

const dbPath = require.resolve('../src/config/db');
const verificationPath = require.resolve('../src/modules/auth/customerAuthVerification.service');
const authServicePath = require.resolve('../src/modules/auth/auth.service');
const authControllerPath = require.resolve('../src/modules/auth/auth.controller');

const state = { auth: [], customers: [], challenges: [], sent: [] };
const key = (tenantId, purpose, email) => `${tenantId}:${purpose}:${String(email).trim().toLowerCase()}`;
const verificationStub = {
  PURPOSES: { CUSTOMER_LOGIN: 'CUSTOMER_LOGIN', PASSWORD_RESET: 'PASSWORD_RESET' },
  createCustomerAuthVerificationService: () => ({
    resendAvailableAt: () => new Date('2026-10-03T00:01:00.000Z'),
    async create({ tenantId, purpose, email }) {
      const challenge = { tenantId, purpose, email: String(email).trim().toLowerCase(), codeHash: 'hashed:123456', code: undefined, attempts: 0, consumed: false, expiresAt: Date.now() + 60_000 };
      state.challenges = state.challenges.filter((item) => key(item.tenantId, item.purpose, item.email) !== key(tenantId, purpose, email));
      state.challenges.push(challenge); state.sent.push({ tenantId, purpose, email: challenge.email });
      return { expiresAt: new Date(challenge.expiresAt), resendAvailableAt: new Date() };
    },
    async verify({ tenantId, purpose, email, otp }) {
      const challenge = state.challenges.find((item) => key(item.tenantId, item.purpose, item.email) === key(tenantId, purpose, email));
      if (!challenge || challenge.consumed || challenge.expiresAt <= Date.now() || otp !== '123456') {
        if (challenge && !challenge.consumed) challenge.attempts += 1;
        const error = new Error('Invalid or expired verification code'); error.statusCode = 401; throw error;
      }
      challenge.consumed = true;
      return { normalizedEmail: challenge.email, purpose };
    },
  }),
};

const authView = (row) => row && ({ ...row, customer_name: row.customer_id ? 'Customer' : null, staff_name: row.staff_user_id ? 'Staff' : null, role_id: row.staff_user_id ? 'admin' : null, role_code: row.staff_user_id ? 'ADMIN' : null, user_type: row.staff_user_id ? 'staff' : 'customer' });
const pool = {
  async connect() { return client; },
  query: (...args) => client.query(...args),
};
const client = {
  release() {},
  async query(sql, params = []) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [] };
    if (statement.includes('FROM AUTH a') && statement.includes('a.tenant_id = $1 AND a.email = $2')) return { rows: [authView(state.auth.find((row) => row.tenant_id === params[0] && row.email === params[1]))].filter(Boolean) };
    if (statement.includes('FROM CUSTOMERS') && statement.includes('WHERE tenant_id = $1 AND email = $2')) return { rows: state.customers.filter((row) => row.tenant_id === params[0] && row.email === params[1]) };
    if (statement.startsWith('INSERT INTO CUSTOMERS')) { const customer = { id: params[0], tenant_id: params[1], email: params[2], full_name: params[3], is_verified: params[4] }; state.customers.push(customer); return { rows: [customer] }; }
    if (statement.startsWith('UPDATE CUSTOMERS SET is_verified')) { const customer = state.customers.find((row) => row.id === params[0] && row.tenant_id === params[1]); if (customer) customer.is_verified = true; return { rows: [] }; }
    if (statement.startsWith('INSERT INTO AUTH')) { state.auth.push({ id: params[0], tenant_id: params[1], customer_id: params[2], email: params[3], password_hash: params[4], google_subject: params[5] || null, is_active: true, staff_user_id: null, reset_token: null, reset_token_exp: null }); return { rows: [] }; }
    if (statement.includes('FROM AUTH a') && statement.includes('WHERE a.id = $1 AND a.tenant_id = $2')) return { rows: [authView(state.auth.find((row) => row.id === params[0] && row.tenant_id === params[1]))].filter(Boolean) };
    if (statement.includes('FROM AUTH') && statement.includes('FOR UPDATE')) return { rows: state.auth.filter((row) => row.id === params[0] && row.tenant_id === params[1]).map((row) => ({ id: row.id, reset_token: row.reset_token, reset_token_exp: row.reset_token_exp, is_active: row.is_active })) };
    if (statement.startsWith('UPDATE AUTH SET password_hash')) { const row = state.auth.find((entry) => entry.id === params[1] && entry.tenant_id === params[2] && entry.customer_id === params[3]); if (row) { row.password_hash = params[0]; row.reset_token = null; row.reset_token_exp = null; } return { rows: [] }; }
    if (statement.startsWith('UPDATE AUTH SET reset_token = $1')) { const row = state.auth.find((entry) => entry.id === params[2]); if (row) { row.reset_token = params[0]; row.reset_token_exp = new Date(Date.now() + 86_400_000); } return { rows: [] }; }
    if (statement.startsWith('UPDATE AUTH SET last_login_at')) return { rows: [] };
    throw new Error(`Unexpected query: ${statement}`);
  },
};

const originalDb = require.cache[dbPath];
const originalVerification = require.cache[verificationPath];
delete require.cache[authServicePath]; delete require.cache[authControllerPath];
require.cache[dbPath] = { exports: pool };
require.cache[verificationPath] = { exports: verificationStub };
const authService = require('../src/modules/auth/auth.service');
const authController = require('../src/modules/auth/auth.controller');

const resetState = async () => {
  const hash = await bcrypt.hash('OldPassword9', 4);
  state.auth = [
    { id: 'auth-a', tenant_id: 'tenant-a', email: 'same@example.com', password_hash: hash, is_active: true, customer_id: 'customer-a', staff_user_id: null, google_subject: null, reset_token: null, reset_token_exp: null },
    { id: 'auth-b', tenant_id: 'tenant-b', email: 'same@example.com', password_hash: hash, is_active: true, customer_id: 'customer-b', staff_user_id: null, google_subject: null, reset_token: null, reset_token_exp: null },
    { id: 'auth-checkout', tenant_id: 'tenant-a', email: 'checkout@example.com', password_hash: await bcrypt.hash('generated-unusable', 4), is_active: true, customer_id: 'customer-checkout', staff_user_id: null, google_subject: null, reset_token: null, reset_token_exp: null },
    { id: 'auth-google', tenant_id: 'tenant-a', email: 'google@example.com', password_hash: hash, is_active: true, customer_id: 'customer-google', staff_user_id: null, google_subject: 'google-subject', reset_token: null, reset_token_exp: null },
    { id: 'auth-staff', tenant_id: 'tenant-a', email: 'staff@example.com', password_hash: hash, is_active: true, customer_id: null, staff_user_id: 'staff-a', google_subject: null, reset_token: 'staff-refresh-hash', reset_token_exp: new Date(Date.now() + 86_400_000) },
    { id: 'auth-inactive', tenant_id: 'tenant-a', email: 'inactive@example.com', password_hash: hash, is_active: false, customer_id: 'customer-inactive', staff_user_id: null, google_subject: null, reset_token: null, reset_token_exp: null },
  ]; state.customers = [
    { id: 'customer-a', tenant_id: 'tenant-a', email: 'same@example.com', full_name: 'Customer', is_verified: true },
    { id: 'customer-b', tenant_id: 'tenant-b', email: 'same@example.com', full_name: 'Customer', is_verified: true },
    { id: 'customer-checkout', tenant_id: 'tenant-a', email: 'checkout@example.com', full_name: 'Checkout', is_verified: true },
    { id: 'customer-google', tenant_id: 'tenant-a', email: 'google@example.com', full_name: 'Google', is_verified: true },
    { id: 'customer-inactive', tenant_id: 'tenant-a', email: 'inactive@example.com', full_name: 'Inactive', is_verified: true },
  ]; state.challenges = []; state.sent = [];
};
const response = () => { const result = {}; return { result, status(code) { result.statusCode = code; return this; }, json(body) { result.body = body; return result; } }; };
test.beforeEach(resetState);
test.after(() => { delete require.cache[authServicePath]; delete require.cache[authControllerPath]; if (originalDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath]; if (originalVerification) require.cache[verificationPath] = originalVerification; else delete require.cache[verificationPath]; });

test('forgot endpoint is neutral for known, unknown, inactive, and staff identities', async () => {
  const calls = ['same@example.com', 'unknown@example.com', 'inactive@example.com', 'staff@example.com'].map(async (email) => { const res = response(); await authController.customerPasswordForgot({ tenantId: 'tenant-a', body: { email } }, res); return res; });
  const results = await Promise.all(calls);
  for (const result of results) {
    assert.equal(result.result.body.success, true);
    assert.equal(result.result.body.statusCode, 200);
    assert.equal(result.result.body.message, 'If this email can reset a password, we’ve sent a verification code.');
    assert.deepEqual(result.result.body.data, { accepted: true, resendAvailableAt: new Date('2026-10-03T00:01:00.000Z') });
  }
  assert.deepEqual(state.sent, [{ tenantId: 'tenant-a', purpose: 'PASSWORD_RESET', email: 'same@example.com' }]);
});

test('customer login OTP sends for new and existing tenant-scoped email identities', async () => {
  await authService.requestCustomerLoginOtp('tenant-a', '  SAME@EXAMPLE.COM  ');
  const before = state.auth.length;
  const res = response();
  await authController.customerEmailOtpSend({ tenantId: 'tenant-a', body: { email: '  NEW@EXAMPLE.COM  ' } }, res);
  assert.equal(res.result.body.success, true);
  assert.equal(res.result.body.statusCode, 200);
  assert.equal(res.result.body.message, 'If this email can be used to sign in, we’ve sent a verification code.');
  assert.equal(res.result.body.data.accepted, true);
  assert.ok(res.result.body.data.resendAvailableAt instanceof Date);
  assert.equal(state.auth.length, before);
  assert.deepEqual(state.sent, [
    { tenantId: 'tenant-a', purpose: 'CUSTOMER_LOGIN', email: 'same@example.com' },
    { tenantId: 'tenant-a', purpose: 'CUSTOMER_LOGIN', email: 'new@example.com' },
  ]);
});

test('verified first-time email OTP creates one verified customer/Auth identity and later reuses it', async () => {
  await authService.requestCustomerLoginOtp('tenant-a', 'new@example.com');
  const first = await authService.verifyCustomerLoginOtp('tenant-a', 'new@example.com', '123456');
  const created = state.auth.find((row) => row.tenant_id === 'tenant-a' && row.email === 'new@example.com');
  assert.ok(created?.customer_id); assert.equal(state.customers.filter((row) => row.id === created.customer_id && row.is_verified).length, 1);
  assert.equal(first.user.id, created.id);
  await authService.requestCustomerLoginOtp('tenant-a', 'new@example.com');
  const second = await authService.verifyCustomerLoginOtp('tenant-a', 'new@example.com', '123456');
  assert.equal(second.user.id, created.id);
  assert.equal(state.auth.filter((row) => row.tenant_id === 'tenant-a' && row.email === 'new@example.com').length, 1);
});

test('OTP login preserves existing checkout, password, and Google customer identities', async () => {
  const passwordHash = state.auth.find((row) => row.id === 'auth-a').password_hash;
  const googleSubject = state.auth.find((row) => row.id === 'auth-google').google_subject;
  for (const email of ['same@example.com', 'checkout@example.com', 'google@example.com']) {
    await authService.requestCustomerLoginOtp('tenant-a', email);
    await authService.verifyCustomerLoginOtp('tenant-a', email, '123456');
  }
  assert.equal(state.auth.find((row) => row.id === 'auth-a').password_hash, passwordHash);
  assert.equal(state.auth.find((row) => row.id === 'auth-google').google_subject, googleSubject);
  assert.equal(state.auth.find((row) => row.id === 'auth-checkout').customer_id, 'customer-checkout');
  assert.equal(state.auth.length, 6);
});

test('concurrent, cross-tenant, staff, and invalid OTP paths cannot create duplicate or unauthorized customers', async () => {
  await authService.requestCustomerLoginOtp('tenant-a', 'concurrent@example.com');
  const concurrent = await Promise.allSettled([
    authService.verifyCustomerLoginOtp('tenant-a', 'concurrent@example.com', '123456'),
    authService.verifyCustomerLoginOtp('tenant-a', 'concurrent@example.com', '123456'),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(state.auth.filter((row) => row.tenant_id === 'tenant-a' && row.email === 'concurrent@example.com').length, 1);
  await authService.requestCustomerLoginOtp('tenant-a', 'isolated@example.com');
  await authService.requestCustomerLoginOtp('tenant-b', 'isolated@example.com');
  await authService.verifyCustomerLoginOtp('tenant-a', 'isolated@example.com', '123456');
  await authService.verifyCustomerLoginOtp('tenant-b', 'isolated@example.com', '123456');
  assert.equal(state.auth.filter((row) => row.email === 'isolated@example.com').length, 2);
  await authService.requestCustomerLoginOtp('tenant-a', 'staff@example.com');
  await assert.rejects(authService.verifyCustomerLoginOtp('tenant-a', 'staff@example.com', '123456'), /Invalid email or password/);
  assert.equal(state.auth.filter((row) => row.email === 'staff@example.com').length, 1);
  const beforeInvalid = state.auth.length;
  await authService.requestCustomerLoginOtp('tenant-a', 'invalid@example.com');
  await assert.rejects(authService.verifyCustomerLoginOtp('tenant-a', 'invalid@example.com', '000000'), /Invalid|expired/);
  state.challenges.find((challenge) => challenge.email === 'invalid@example.com').expiresAt = Date.now() - 1;
  await assert.rejects(authService.verifyCustomerLoginOtp('tenant-a', 'invalid@example.com', '123456'), /Invalid|expired/);
  assert.equal(state.auth.length, beforeInvalid);
});

test('wrong, expired, consumed, and wrong-purpose reset codes cannot mutate passwords', async () => {
  await authService.requestPasswordReset('tenant-a', 'same@example.com'); const original = state.auth[0].password_hash;
  await assert.rejects(authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '000000', newPassword: 'NewPassword9' }), /Invalid|expired/);
  assert.equal(state.challenges[0].attempts, 1); assert.equal(state.auth[0].password_hash, original);
  state.challenges[0].expiresAt = Date.now() - 1;
  await assert.rejects(authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '123456', newPassword: 'NewPassword9' }), /Invalid|expired/);
  await verificationStub.createCustomerAuthVerificationService().create({ tenantId: 'tenant-a', purpose: 'CUSTOMER_LOGIN', email: 'same@example.com' });
  await assert.rejects(authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '123456', newPassword: 'NewPassword9' }), /Invalid|expired/);
  await authService.requestPasswordReset('tenant-a', 'same@example.com'); await authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '123456', newPassword: 'NewPassword9' });
  await assert.rejects(authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '123456', newPassword: 'NextPassword9' }), /Invalid|expired/);
});

test('successful reset preserves identity, changes password, and invalidates the old refresh session', async () => {
  const before = { id: state.auth[0].id, customer: state.auth[0].customer_id, count: state.auth.length };
  const oldSession = await authService.loginCustomer('tenant-a', 'same@example.com', 'OldPassword9');
  await authService.requestPasswordReset('tenant-a', 'same@example.com'); await authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '123456', newPassword: 'NewPassword9' });
  await assert.rejects(authService.loginCustomer('tenant-a', 'same@example.com', 'OldPassword9'), /Invalid email or password/);
  const newSession = await authService.loginCustomer('tenant-a', 'same@example.com', 'NewPassword9');
  await assert.rejects(authService.refreshSession(oldSession.refreshToken, 'tenant-a'), /no longer valid/);
  assert.ok(newSession.refreshToken); assert.deepEqual({ id: state.auth[0].id, customer: state.auth[0].customer_id, count: state.auth.length }, before);
});

test('checkout-created and Google customers retain their existing auth identities on reset', async () => {
  await authService.requestPasswordReset('tenant-a', 'checkout@example.com'); await authService.resetCustomerPassword('tenant-a', { email: 'checkout@example.com', code: '123456', newPassword: 'CheckoutPassword9' });
  assert.equal((await authService.loginCustomer('tenant-a', 'checkout@example.com', 'CheckoutPassword9')).user.customer_id, 'customer-checkout');
  await authService.requestPasswordReset('tenant-a', 'google@example.com'); await authService.resetCustomerPassword('tenant-a', { email: 'google@example.com', code: '123456', newPassword: 'GooglePassword9' });
  assert.equal(state.auth.find((row) => row.id === 'auth-google').google_subject, 'google-subject'); assert.equal(state.auth.length, 6);
});

test('PASSWORD_RESET cannot authenticate login, tenant reset is isolated, and staff refresh state is untouched', async () => {
  await authService.requestPasswordReset('tenant-a', 'same@example.com');
  await assert.rejects(authService.verifyCustomerLoginOtp('tenant-a', 'same@example.com', '123456'), /Invalid|expired/);
  await authService.requestPasswordReset('tenant-b', 'same@example.com'); await authService.resetCustomerPassword('tenant-a', { email: 'same@example.com', code: '123456', newPassword: 'TenantAPassword9' });
  await assert.rejects(authService.loginCustomer('tenant-b', 'same@example.com', 'TenantAPassword9'), /Invalid email or password/);
  assert.equal(state.auth.find((row) => row.id === 'auth-staff').reset_token, 'staff-refresh-hash');
});
