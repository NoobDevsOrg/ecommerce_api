const pool = require('../../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
} = require('../../utils/errors');
const Logger = require('../../utils/logger');
const { isStrongCustomerPassword } = require('./passwordPolicy');
const { normalizeEmail } = require('./identity');
const integrationConfigService = require('../integrations/integrationConfig.service');
const { PURPOSES, createCustomerAuthVerificationService } = require('./customerAuthVerification.service');
const { sendCustomerAuthOtp } = require('./customerAuthVerificationEmail.service');
const { emailFailureDetails } = require('../../utils/smtpTransport');

const customerVerifications = createCustomerAuthVerificationService({
  sendEmail: sendCustomerAuthOtp,
  onTiming: ({ challengeDbMs, purpose }) => Logger.info('Customer auth OTP challenge timing', { challengeDbMs, purpose }),
});

const googleClient = new OAuth2Client();
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_SALT_ROUNDS = 12;

const hashToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const signAccessToken = (payload) => jwt.sign(payload, process.env.JWT_SECRET, {
  expiresIn: process.env.JWT_EXPIRY || '15m',
});

const signRefreshToken = (payload) => jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
  expiresIn: process.env.JWT_REFRESH_EXPIRY || '30d',
});

const buildUserPayload = (auth) => ({
  id: auth.id,
  email: auth.email,
  staff_user_id: auth.staff_user_id,
  customer_id: auth.customer_id,
  user_type: auth.user_type,
  role_id: auth.role_id,
  role_code: auth.role_code,
});

const buildUser = (auth) => ({
  ...buildUserPayload(auth),
  ...(auth.staff_user_id ? { full_name: auth.staff_name } : {}),
  ...(auth.customer_id ? { full_name: auth.customer_name } : {}),
});

const assertTenant = (tenantId) => {
  if (!tenantId) {
    throw new AppError('Tenant not resolved', 400, 'TENANT_REQUIRED');
  }
};

const persistRefreshToken = async (queryable, userId, refreshToken) => {
  await queryable.query(
    `UPDATE AUTH
     SET reset_token = $1,
         reset_token_exp = now() + ($2 || ' seconds')::interval,
         updated_at = now()
     WHERE id = $3`,
    [hashToken(refreshToken), String(REFRESH_TOKEN_TTL_SECONDS), userId]
  );
};

const issueSession = async (queryable, auth, tenantId) => {
  const user = buildUser(auth);
  const accessToken = signAccessToken({ ...buildUserPayload(auth), tenant_id: tenantId });
  // A unique token identifier is required for rotation. Without it, two tokens
  // issued in the same JWT timestamp window could be byte-for-byte identical.
  const refreshToken = signRefreshToken({ id: auth.id, tenant_id: tenantId, jti: crypto.randomUUID() });

  await persistRefreshToken(queryable, auth.id, refreshToken);
  await queryable.query('UPDATE AUTH SET last_login_at = now() WHERE id = $1', [auth.id]);

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: process.env.JWT_EXPIRY || '15m',
    tenantId,
    user,
  };
};

const findAuthByEmail = async (queryable, tenantId, email, { forUpdate = false } = {}) => {
  const result = await queryable.query(
    `SELECT a.id, a.email, a.password_hash, a.is_active, a.customer_id, a.staff_user_id,
            s.full_name AS staff_name, s.role_id, r.code AS role_code,
            c.full_name AS customer_name,
            CASE WHEN s.id IS NOT NULL THEN 'staff' ELSE 'customer' END AS user_type
     FROM AUTH a
     LEFT JOIN STAFF_USERS s ON a.staff_user_id = s.id
     LEFT JOIN ROLES r ON s.role_id = r.id
     LEFT JOIN CUSTOMERS c ON a.customer_id = c.id
     WHERE a.tenant_id = $1 AND a.email = $2
     ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
    [tenantId, normalizeEmail(email)]
  );

  return result.rows[0] || null;
};

const findCustomerByEmail = async (queryable, tenantId, email, { forUpdate = false } = {}) => {
  const result = await queryable.query(
    `SELECT id, email, full_name, is_verified
     FROM CUSTOMERS
     WHERE tenant_id = $1 AND email = $2
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tenantId, normalizeEmail(email)]
  );
  return result.rows[0] || null;
};

const findAuthByGoogleSubject = async (queryable, tenantId, googleSubject, { forUpdate = false } = {}) => {
  const result = await queryable.query(
    `SELECT a.id, a.email, a.is_active, a.customer_id, a.staff_user_id,
            c.full_name AS customer_name,
            NULL::text AS staff_name, NULL::text AS role_id, NULL::text AS role_code,
            'customer' AS user_type
     FROM AUTH a
     LEFT JOIN CUSTOMERS c ON a.customer_id = c.id
     WHERE a.tenant_id = $1 AND a.google_subject = $2
     ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
    [tenantId, googleSubject]
  );

  return result.rows[0] || null;
};

const findAuthById = async (userId, tenantId, queryable = pool) => {
  const result = await queryable.query(
    `SELECT a.id, a.email, a.password_hash, a.is_active, a.customer_id, a.staff_user_id,
            s.full_name AS staff_name, s.role_id, r.code AS role_code,
            c.full_name AS customer_name,
            CASE WHEN s.id IS NOT NULL THEN 'staff' ELSE 'customer' END AS user_type
     FROM AUTH a
     LEFT JOIN STAFF_USERS s ON a.staff_user_id = s.id
     LEFT JOIN ROLES r ON s.role_id = r.id
     LEFT JOIN CUSTOMERS c ON a.customer_id = c.id
     WHERE a.id = $1 AND a.tenant_id = $2`,
    [userId, tenantId]
  );

  return result.rows[0] || null;
};

const assertActive = (auth, { concealInactive = true } = {}) => {
  if (!auth) {
    throw new AuthenticationError('Invalid email or password');
  }
  if (!auth.is_active) {
    if (concealInactive) {
      throw new AuthenticationError('Invalid email or password');
    }
    throw new AppError('Account is inactive', 403, 'ACCOUNT_INACTIVE');
  }
};

const assertCustomer = (auth) => {
  if (!auth?.customer_id || auth.staff_user_id) {
    throw new AuthenticationError('Invalid email or password');
  }
};

const assertStaff = (auth) => {
  if (!auth?.staff_user_id || auth.customer_id) {
    throw new AuthenticationError('Invalid email or password');
  }
};

const verifyPassword = async (auth, password) => {
  const validPassword = await bcrypt.compare(password, auth.password_hash);
  if (!validPassword) {
    throw new AuthenticationError('Invalid email or password');
  }
};

const createCustomerAuth = async (client, tenantId, { fullName, email, password, googleSubject = null, verified = false }) => {
  const customerId = crypto.randomUUID();
  const authId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);

  const customerResult = await client.query(
    `INSERT INTO CUSTOMERS (id, tenant_id, email, full_name, is_verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, full_name`,
    [customerId, tenantId, email, fullName, verified]
  );

  await client.query(
    `INSERT INTO AUTH (id, tenant_id, customer_id, email, password_hash, google_subject, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [authId, tenantId, customerId, email, passwordHash, googleSubject]
  );

  return {
    id: authId,
    email,
    is_active: true,
    customer_id: customerId,
    staff_user_id: null,
    customer_name: customerResult.rows[0].full_name,
    staff_name: null,
    role_id: null,
    role_code: null,
    user_type: 'customer',
  };
};

const verifyGoogleIdentity = async (tenantId, idToken) => {
  const googleConfiguration = await integrationConfigService.getEnabledGoogleConfiguration(tenantId);

  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: googleConfiguration.clientId });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload?.email || payload.email_verified !== true) {
      throw new AuthenticationError('Google sign-in could not be verified');
    }

    return {
      subject: payload.sub,
      email: normalizeEmail(payload.email),
      fullName: typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 120)
        : payload.email.split('@')[0],
    };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }

    Logger.warn('Google token verification failed');
    throw new AuthenticationError('Google sign-in could not be verified');
  }
};

exports.login = async (tenantId, email, password) => {
  assertTenant(tenantId);
  const auth = await findAuthByEmail(pool, tenantId, email);
  assertActive(auth, { concealInactive: false });
  assertStaff(auth);
  await verifyPassword(auth, password);

  const session = await issueSession(pool, auth, tenantId);
  Logger.info('User logged in', { userId: auth.id, tenantId, userType: auth.user_type });
  return session;
};

exports.loginCustomer = async (tenantId, email, password) => {
  assertTenant(tenantId);
  const auth = await findAuthByEmail(pool, tenantId, email);
  assertActive(auth);
  assertCustomer(auth);
  await verifyPassword(auth, password);

  const session = await issueSession(pool, auth, tenantId);
  Logger.info('Customer logged in', { userId: auth.id, tenantId });
  return session;
};
exports.requestCustomerLoginOtp = async (tenantId, email) => {
  assertTenant(tenantId);
  // A challenge proves ownership before an identity is created. Do not look up
  // an account here: known and first-time addresses must receive the same
  // neutral response and follow the same tenant-scoped OTP path.
  try {
    const challenge = await customerVerifications.create({ tenantId, purpose: PURPOSES.CUSTOMER_LOGIN, email: normalizeEmail(email) });
    return { accepted: true, resendAvailableAt: challenge.resendAvailableAt };
  } catch (error) {
    // Cooldown/limit errors are safe to return; delivery failures remain neutral.
    if (error?.statusCode === 429) throw error;
    Logger.warn('Customer login OTP delivery failed', { tenantId, email: emailFailureDetails(error) });
  }
  return { accepted: true, resendAvailableAt: customerVerifications.resendAvailableAt() };
};
exports.verifyCustomerLoginOtp = async (tenantId, email, code) => {
  assertTenant(tenantId);
  const verified = await customerVerifications.verify({ tenantId, purpose: PURPOSES.CUSTOMER_LOGIN, email, otp: code });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let auth = await findAuthByEmail(client, tenantId, verified.normalizedEmail, { forUpdate: true });
    if (auth) {
      // This also blocks staff identities; email proof must never turn a staff
      // AUTH record into a customer or alter password/Google credentials.
      assertActive(auth); assertCustomer(auth);
    } else {
      const customer = await findCustomerByEmail(client, tenantId, verified.normalizedEmail, { forUpdate: true });
      if (customer) {
        await client.query('UPDATE CUSTOMERS SET is_verified=true, updated_at=now() WHERE id=$1 AND tenant_id=$2', [customer.id, tenantId]);
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), PASSWORD_SALT_ROUNDS);
        const authId = crypto.randomUUID();
        await client.query('INSERT INTO AUTH (id, tenant_id, customer_id, email, password_hash, google_subject, is_active) VALUES ($1,$2,$3,$4,$5,NULL,true)', [authId, tenantId, customer.id, verified.normalizedEmail, passwordHash]);
        auth = { id: authId, email: verified.normalizedEmail, is_active: true, customer_id: customer.id, staff_user_id: null, customer_name: customer.full_name, staff_name: null, role_id: null, role_code: null, user_type: 'customer' };
      } else {
        auth = await createCustomerAuth(client, tenantId, {
          fullName: null,
          email: verified.normalizedEmail,
          password: crypto.randomBytes(32).toString('base64url'),
          verified: true,
        });
      }
    }
    const session = await issueSession(client, auth, tenantId);
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    // A concurrent first-time verifier may have inserted the tenant/email
    // identity after our initial lookup. The database remains authoritative;
    // safely re-read the resulting customer identity instead of duplicating it.
    if (error?.code === '23505') {
      const concurrent = await findAuthByEmail(pool, tenantId, verified.normalizedEmail);
      if (concurrent) {
        assertActive(concurrent); assertCustomer(concurrent);
        return issueSession(pool, concurrent, tenantId);
      }
    }
    throw error;
  } finally {
    client.release();
  }
};
exports.requestPasswordReset = async (tenantId, email) => {
  assertTenant(tenantId);
  // This timestamp is returned for every syntactically valid request, whether
  // or not an eligible account exists, so the neutral forgot-password contract
  // remains intact while the UI can explain its disabled resend button.
  const neutralResendAvailableAt = customerVerifications.resendAvailableAt();
  const auth = await findAuthByEmail(pool, tenantId, email);
  if (!auth?.is_active || !auth.customer_id || auth.staff_user_id) return { accepted: true, resendAvailableAt: neutralResendAvailableAt };
  try {
    await customerVerifications.create({ tenantId, purpose: PURPOSES.PASSWORD_RESET, email });
    return { accepted: true, resendAvailableAt: neutralResendAvailableAt };
  } catch (error) {
    if (error?.statusCode === 429) throw error;
    Logger.warn('Customer password reset delivery failed', { tenantId });
  }
  return { accepted: true, resendAvailableAt: neutralResendAvailableAt };
};
exports.resetCustomerPassword = async (tenantId, { email, code, newPassword }) => {
  assertTenant(tenantId); if (!isStrongCustomerPassword(newPassword)) throw new AppError('Password does not meet the required security standard', 400, 'WEAK_PASSWORD');
  const verified = await customerVerifications.verify({ tenantId, purpose: PURPOSES.PASSWORD_RESET, email, otp: code });
  const client = await pool.connect(); try { await client.query('BEGIN'); const auth = await findAuthByEmail(client, tenantId, verified.normalizedEmail, { forUpdate: true }); assertActive(auth); assertCustomer(auth); const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    await client.query('UPDATE AUTH SET password_hash=$1, reset_token=NULL, reset_token_exp=NULL, updated_at=now() WHERE id=$2 AND tenant_id=$3 AND customer_id=$4 AND staff_user_id IS NULL', [passwordHash, auth.id, tenantId, auth.customer_id]); await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

exports.registerCustomer = async (tenantId, { fullName, email, password }) => {
  assertTenant(tenantId);
  const normalizedEmail = normalizeEmail(email);

  if (!isStrongCustomerPassword(password)) {
    throw new AppError('Password does not meet the required security standard', 400, 'WEAK_PASSWORD');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantResult = await client.query(
      'SELECT id FROM TENANTS WHERE id = $1 AND is_active = true',
      [tenantId]
    );
    if (tenantResult.rows.length === 0) {
      throw new AppError('Tenant is unavailable', 400, 'TENANT_UNAVAILABLE');
    }

    const existing = await client.query(
      'SELECT id FROM AUTH WHERE tenant_id = $1 AND email = $2 FOR UPDATE',
      [tenantId, normalizedEmail]
    );
    if (existing.rows.length > 0) {
      throw new ConflictError('Unable to create an account with those details');
    }

    const auth = await createCustomerAuth(client, tenantId, {
      fullName: fullName.trim(),
      email: normalizedEmail,
      password,
    });
    const session = await issueSession(client, auth, tenantId);
    await client.query('COMMIT');

    Logger.info('Customer account registered', { userId: auth.id, tenantId });
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      throw new ConflictError('Unable to create an account with those details');
    }
    throw error;
  } finally {
    client.release();
  }
};

exports.authenticateGoogleCustomer = async (tenantId, idToken) => {
  assertTenant(tenantId);
  const identity = await verifyGoogleIdentity(tenantId, idToken);

  const linkedAuth = await findAuthByGoogleSubject(pool, tenantId, identity.subject);
  if (linkedAuth) {
    const auth = linkedAuth;
    assertActive(auth);
    assertCustomer(auth);
    return issueSession(pool, auth, tenantId);
  }

  const existingAccount = await pool.query(
    'SELECT id FROM AUTH WHERE tenant_id = $1 AND email = $2',
    [tenantId, identity.email]
  );
  if (existingAccount.rows.length > 0) {
    throw new ConflictError('This account cannot use Google sign-in. Please use your existing sign-in method.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantResult = await client.query(
      'SELECT id FROM TENANTS WHERE id = $1 AND is_active = true',
      [tenantId]
    );
    if (tenantResult.rows.length === 0) {
      throw new AppError('Tenant is unavailable', 400, 'TENANT_UNAVAILABLE');
    }

    const auth = await createCustomerAuth(client, tenantId, {
      fullName: identity.fullName,
      email: identity.email,
      password: crypto.randomBytes(32).toString('base64url'),
      googleSubject: identity.subject,
      verified: true,
    });
    const session = await issueSession(client, auth, tenantId);
    await client.query('COMMIT');

    Logger.info('Google customer account registered', { userId: auth.id, tenantId });
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      const concurrentIdentity = await findAuthByGoogleSubject(pool, tenantId, identity.subject);
      if (concurrentIdentity) {
        assertActive(concurrentIdentity);
        assertCustomer(concurrentIdentity);
        return issueSession(pool, concurrentIdentity, tenantId);
      }
      throw new ConflictError('Google sign-in could not be completed. Please try again.');
    }
    throw error;
  } finally {
    client.release();
  }
};

exports.getCurrentUser = async (userId, tenantId) => {
  const auth = await findAuthById(userId, tenantId);
  if (!auth) {
    throw new NotFoundError('User');
  }
  return { ...buildUser(auth), is_active: auth.is_active };
};

exports.getCurrentCustomer = async (userId, tenantId) => {
  const auth = await findAuthById(userId, tenantId);
  if (!auth) {
    throw new NotFoundError('Customer');
  }
  if (!auth.customer_id || auth.staff_user_id) {
    throw new AuthorizationError('Customer access is required');
  }

  const customerResult = await pool.query(
    `SELECT id, email, full_name, phone, avatar_url, date_of_birth, gender, is_verified
     FROM CUSTOMERS
     WHERE id = $1 AND tenant_id = $2`,
    [auth.customer_id, tenantId]
  );
  if (customerResult.rows.length === 0) {
    throw new NotFoundError('Customer');
  }

  const customer = customerResult.rows[0];
  return {
    id: auth.id,
    customerId: customer.id,
    email: customer.email,
    fullName: customer.full_name,
    phone: customer.phone,
    avatarUrl: customer.avatar_url,
    dateOfBirth: customer.date_of_birth,
    gender: customer.gender,
    isVerified: customer.is_verified,
    userType: 'customer',
  };
};

exports.updateCustomerProfile = async (userId, tenantId, { fullName }) => {
  const result = await pool.query(
    `UPDATE CUSTOMERS c
     SET full_name = $1, updated_at = now()
     FROM AUTH a
     WHERE a.id = $2
       AND a.tenant_id = $3
       AND a.customer_id = c.id
       AND a.staff_user_id IS NULL
       AND c.tenant_id = $3
     RETURNING c.id, c.email, c.full_name, c.phone, c.avatar_url, c.date_of_birth, c.gender, c.is_verified`,
    [fullName.trim(), userId, tenantId]
  );
  if (result.rows.length === 0) {
    throw new AuthorizationError('Customer access is required');
  }

  const customer = result.rows[0];
  return {
    id: userId,
    customerId: customer.id,
    email: customer.email,
    fullName: customer.full_name,
    phone: customer.phone,
    avatarUrl: customer.avatar_url,
    dateOfBirth: customer.date_of_birth,
    gender: customer.gender,
    isVerified: customer.is_verified,
    userType: 'customer',
  };
};

exports.refreshSession = async (refreshToken, tenantId) => {
  assertTenant(tenantId);
  if (!refreshToken) {
    throw new AuthenticationError('Refresh token is required');
  }

  let payload;
  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch (_error) {
    throw new AuthenticationError('Invalid or expired refresh token');
  }

  if (payload.tenant_id !== tenantId) {
    throw new AuthenticationError('Refresh token tenant mismatch');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the one tenant-scoped auth row before checking the stored token and
    // writing its replacement. This makes a refresh token single-use even when
    // the client sends concurrent refresh requests.
    const result = await client.query(
      `SELECT id, reset_token, reset_token_exp, is_active
       FROM AUTH
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [payload.id, tenantId]
    );
    const stored = result.rows[0];
    if (!stored?.is_active || !stored.reset_token || !stored.reset_token_exp) {
      throw new AuthenticationError('Refresh token is no longer valid');
    }
    if (new Date(stored.reset_token_exp).getTime() <= Date.now()) {
      throw new AuthenticationError('Refresh token has expired');
    }
    if (stored.reset_token !== hashToken(refreshToken)) {
      throw new AuthenticationError('Refresh token is no longer valid');
    }

    const auth = await findAuthById(stored.id, tenantId, client);
    if (!auth?.is_active) {
      throw new AuthenticationError('User not found or inactive');
    }

    const session = await issueSession(client, auth, tenantId);
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

exports.logout = async (refreshToken, userId, tenantId) => {
  if (!refreshToken) {
    throw new AuthenticationError('Refresh token is required');
  }

  const result = await pool.query(
    'SELECT reset_token FROM AUTH WHERE id = $1 AND tenant_id = $2',
    [userId, tenantId]
  );
  if (result.rows.length === 0 || result.rows[0].reset_token !== hashToken(refreshToken)) {
    throw new AuthenticationError('Refresh token is no longer valid');
  }

  await pool.query(
    `UPDATE AUTH
     SET reset_token = NULL, reset_token_exp = NULL, updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  );
};

// Explicit, narrowly-scoped reuse points for the checkout identity handoff.
// They preserve the normal customer password, Google verification, and token
// issuance semantics without creating a checkout-specific auth mechanism.
exports.checkoutIdentity = {
  findAuthByEmail,
  findCustomerByEmail,
  findAuthByGoogleSubject,
  assertActive,
  assertCustomer,
  verifyPassword,
  createCustomerAuth,
  verifyGoogleIdentity,
  issueSession,
  isStrongCustomerPassword,
};
