const crypto = require('crypto');
const pool = require('../../config/db');
const cartService = require('../cart/cart.service');
const addressService = require('../addresses/address.service');
const authService = require('../auth/auth.service');
const { sendCheckoutOtp } = require('./checkoutOtpEmail.service');
const { isStrongCustomerPassword } = require('../auth/passwordPolicy');
const {
  AppError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} = require('../../utils/errors');

const SESSION_STATES = Object.freeze({
  IDENTITY_REQUIRED: 'IDENTITY_REQUIRED',
  IDENTITY_VERIFIED: 'IDENTITY_VERIFIED',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
});

const sessionColumns = `id, tenant_id, resume_token_hash, state, email_normalized, customer_id,
  cart_draft, contact_draft, address_draft, expires_at, completed_at, created_at, updated_at`;

const hashResumeToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const OTP_LENGTH = 6;
const MAX_OTP_SENDS = 5;
const MAX_OTP_ATTEMPTS = 5;
const configInt = (name, fallback, min, max) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError('Checkout email verification configuration is invalid', 503, 'CHECKOUT_EMAIL_UNAVAILABLE');
  }
  return value;
};
const otpConfig = () => ({
  ttlMinutes: configInt('CHECKOUT_OTP_TTL_MINUTES', 10, 5, 15),
  resendSeconds: configInt('CHECKOUT_OTP_RESEND_SECONDS', 60, 30, 300),
});
const otpHash = ({ secret, sessionId, email, code }) => crypto
  .createHmac('sha256', secret)
  .update(`${sessionId}:${email}:${code}`)
  .digest('hex');
const otpSecret = () => {
  if (!process.env.CHECKOUT_OTP_SECRET) {
    throw new AppError('Email verification is temporarily unavailable', 503, 'CHECKOUT_EMAIL_UNAVAILABLE');
  }
  return process.env.CHECKOUT_OTP_SECRET;
};
const generateOtp = () => String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
};

const requireIdentityDraft = (session) => {
  const contact = parseJson(session.contact_draft, {});
  const address = parseJson(session.address_draft, null);
  const items = parseJson(session.cart_draft, []);

  if (!session.email_normalized || !contact.fullName || !contact.phone || !address || !Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Complete the checkout contact, delivery address, and bag before verifying identity');
  }

  return { contact, address, items };
};

const createCheckoutIdentityService = ({
  database = pool,
  carts = cartService,
  addresses = addressService,
  auth = authService.checkoutIdentity,
  now = () => new Date(),
  sendOtp = sendCheckoutOtp,
} = {}) => {
  if (!auth) throw new Error('Checkout identity authentication helpers are unavailable');

  const expireIfNeeded = async (client, session) => {
    if (new Date(session.expires_at).getTime() > now().getTime()) return;
    if (session.state !== SESSION_STATES.EXPIRED) {
      await client.query(
        `UPDATE CHECKOUT_SESSIONS
         SET state = $1, updated_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [SESSION_STATES.EXPIRED, session.id, session.tenant_id]
      );
    }
    throw new NotFoundError('Checkout session');
  };

  const lockSession = async (client, tenantId, resumeToken) => {
    const result = await client.query(
      `SELECT ${sessionColumns}
       FROM CHECKOUT_SESSIONS
       WHERE tenant_id = $1 AND resume_token_hash = $2
       FOR UPDATE`,
      [tenantId, hashResumeToken(resumeToken)]
    );
    const session = result.rows[0];
    if (!session) throw new NotFoundError('Checkout session');
    await expireIfNeeded(client, session);
    if (session.state === SESSION_STATES.COMPLETED || session.completed_at) {
      throw new ConflictError('Checkout session is no longer available');
    }
    if (![SESSION_STATES.IDENTITY_REQUIRED, SESSION_STATES.IDENTITY_VERIFIED].includes(session.state)) {
      throw new ConflictError('Checkout session is not ready for identity verification');
    }
    return session;
  };

  const validateCart = async (tenantId, items) => {
    const validation = await carts.validateItems(tenantId, items);
    if (validation.invalidItems.length > 0 || validation.items.length !== items.length) {
      throw new ValidationError('Your bag has changed. Review the unavailable items before checkout.', validation.invalidItems);
    }
    return validation;
  };

  const loadCustomerAuth = async (client, tenantId, customerId) => {
    const result = await client.query(
      `SELECT a.id, a.email, a.password_hash, a.is_active, a.customer_id, a.staff_user_id,
              c.full_name AS customer_name,
              NULL::text AS staff_name, NULL::text AS role_id, NULL::text AS role_code,
              'customer' AS user_type
       FROM AUTH a
       JOIN CUSTOMERS c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.customer_id = $2 AND a.staff_user_id IS NULL
       FOR UPDATE`,
      [tenantId, customerId]
    );
    return result.rows[0] || null;
  };

  const completeMissingProfile = async (client, tenantId, customerId, contact) => {
    const result = await client.query(
      `UPDATE CUSTOMERS
       SET full_name = COALESCE(NULLIF(full_name, ''), $3),
           phone = COALESCE(NULLIF(phone, ''), $4),
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, full_name, phone`,
      [customerId, tenantId, contact.fullName.trim(), String(contact.phone).replace(/[\s-]/g, '')]
    );
    if (!result.rows[0]) throw new AuthenticationError('Customer identity is unavailable');
    return result.rows[0];
  };

  const linkAndHandoff = async (client, { session, authRecord, draft, cartValidation }) => {
    if (!authRecord?.customer_id || authRecord.staff_user_id) {
      throw new AuthenticationError('Invalid customer identity');
    }
    if (session.customer_id && session.customer_id !== authRecord.customer_id) {
      throw new ConflictError('Checkout session identity cannot be changed');
    }

    const profile = await completeMissingProfile(
      client,
      session.tenant_id,
      authRecord.customer_id,
      draft.contact
    );

    // This remains inside the identity transaction and delegates to the
    // Address module, retaining its duplicate/default-address guarantees.
    const address = await addresses.createInTransaction(
      client,
      session.tenant_id,
      authRecord.customer_id,
      draft.address
    );

    const linked = await client.query(
      `UPDATE CHECKOUT_SESSIONS
       SET customer_id = $1, state = $2, updated_at = now()
       WHERE id = $3 AND tenant_id = $4
         AND (customer_id IS NULL OR customer_id = $1)
       RETURNING id, state, customer_id, expires_at`,
      [authRecord.customer_id, SESSION_STATES.IDENTITY_VERIFIED, session.id, session.tenant_id]
    );
    if (!linked.rows[0]) throw new ConflictError('Checkout session identity cannot be changed');

    const customerAuth = { ...authRecord, customer_name: profile.full_name };
    const authentication = await auth.issueSession(client, customerAuth, session.tenant_id);

    return {
      session: {
        state: linked.rows[0].state,
        expiresAt: linked.rows[0].expires_at,
      },
      customer: {
        id: profile.id,
        fullName: profile.full_name,
        phone: profile.phone,
        profileComplete: Boolean(profile.full_name && profile.phone),
      },
      addressId: address.id,
      cartValidation: {
        items: cartValidation.items,
        invalidItems: cartValidation.invalidItems,
        subtotal: cartValidation.subtotal,
      },
      authentication,
    };
  };

  const withSession = async ({ tenantId, resumeToken, operation }) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const session = await lockSession(client, tenantId, resumeToken);
      const draft = requireIdentityDraft(session);
      const cartValidation = await validateCart(tenantId, draft.items);
      const result = await operation({ client, session, draft, cartValidation });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      // Tenant-scoped email and customer/auth identity constraints are the
      // final concurrency boundary. Do not disclose which identity collided.
      if (error?.code === '23505') {
        throw new ConflictError('Identity verification is required to continue checkout');
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const requestEmailOtp = async ({ tenantId, resumeToken }) => {
    const client = await database.connect();
    let delivery;
    try {
      await client.query('BEGIN');
      const session = await lockSession(client, tenantId, resumeToken);
      const draft = requireIdentityDraft(session);
      const { ttlMinutes, resendSeconds } = otpConfig();
      const secret = otpSecret();
      const existing = await client.query(
        `SELECT id, send_count, consumed_at, next_resend_at
         FROM CHECKOUT_EMAIL_VERIFICATIONS
         WHERE tenant_id = $1 AND checkout_session_id = $2
         FOR UPDATE`,
        [tenantId, session.id]
      );
      const verification = existing.rows[0];
      if (verification?.consumed_at) throw new ConflictError('Email is already verified for this checkout');
      if (verification && new Date(verification.next_resend_at).getTime() > now().getTime()) {
        throw new AppError('Please wait before requesting another verification code', 429, 'CHECKOUT_OTP_RESEND_COOLDOWN');
      }
      if (verification && verification.send_count >= MAX_OTP_SENDS) {
        throw new AppError('Too many verification codes requested. Please try again later.', 429, 'CHECKOUT_OTP_SEND_LIMIT');
      }

      const code = generateOtp();
      const expiresAt = new Date(now().getTime() + ttlMinutes * 60 * 1000);
      const resendAt = new Date(now().getTime() + resendSeconds * 1000);
      const codeHash = otpHash({ secret, sessionId: session.id, email: session.email_normalized, code });
      if (verification) {
        await client.query(
          `UPDATE CHECKOUT_EMAIL_VERIFICATIONS
           SET code_hash = $1, expires_at = $2, attempt_count = 0,
               send_count = send_count + 1, next_resend_at = $3, updated_at = now()
           WHERE id = $4 AND tenant_id = $5`,
          [codeHash, expiresAt, resendAt, verification.id, tenantId]
        );
      } else {
        await client.query(
          `INSERT INTO CHECKOUT_EMAIL_VERIFICATIONS
             (id, tenant_id, checkout_session_id, email_normalized, code_hash, expires_at, next_resend_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [crypto.randomUUID(), tenantId, session.id, session.email_normalized, codeHash, expiresAt, resendAt]
        );
      }
      await client.query('COMMIT');
      delivery = { to: session.email_normalized, code, expiresAt, resendAt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    try {
      await sendOtp({ to: delivery.to, code: delivery.code });
    } catch (_error) {
      // Do not retain a resend cooldown when the provider did not accept the
      // message. The code itself is never logged or returned to the browser.
      await database.query(
        `UPDATE CHECKOUT_EMAIL_VERIFICATIONS
         SET next_resend_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND email_normalized = $2 AND consumed_at IS NULL`,
        [tenantId, delivery.to]
      );
      throw new AppError('Email verification is temporarily unavailable', 503, 'CHECKOUT_EMAIL_UNAVAILABLE');
    }

    return { expiresAt: delivery.expiresAt, resendAvailableAt: delivery.resendAt };
  };

  const verifyEmailOtp = async ({ tenantId, resumeToken, code }) => withSession({
    tenantId,
    resumeToken,
    operation: async ({ client, session, draft, cartValidation }) => {
      const verificationResult = await client.query(
        `SELECT id, code_hash, expires_at, consumed_at, attempt_count
         FROM CHECKOUT_EMAIL_VERIFICATIONS
         WHERE tenant_id = $1 AND checkout_session_id = $2 AND email_normalized = $3
         FOR UPDATE`,
        [tenantId, session.id, session.email_normalized]
      );
      const verification = verificationResult.rows[0];
      const expectedHash = verification && otpHash({ secret: otpSecret(), sessionId: session.id, email: session.email_normalized, code });
      const valid = Boolean(
        verification
        && !verification.consumed_at
        && verification.attempt_count < MAX_OTP_ATTEMPTS
        && new Date(verification.expires_at).getTime() > now().getTime()
        && crypto.timingSafeEqual(Buffer.from(verification.code_hash, 'hex'), Buffer.from(expectedHash, 'hex'))
      );
      if (!valid) {
        if (verification && !verification.consumed_at && verification.attempt_count < MAX_OTP_ATTEMPTS) {
          await client.query(
            'UPDATE CHECKOUT_EMAIL_VERIFICATIONS SET attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1 AND tenant_id = $2',
            [verification.id, tenantId]
          );
        }
        throw new AuthenticationError('Verification code is invalid or expired');
      }

      const consumed = await client.query(
        `UPDATE CHECKOUT_EMAIL_VERIFICATIONS
         SET consumed_at = now(), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND consumed_at IS NULL
         RETURNING id`,
        [verification.id, tenantId]
      );
      if (!consumed.rows[0]) throw new AuthenticationError('Verification code is invalid or expired');

      const existing = session.customer_id
        ? await loadCustomerAuth(client, tenantId, session.customer_id)
        : await auth.findAuthByEmail(client, tenantId, session.email_normalized, { forUpdate: true });
      if (existing) {
        auth.assertActive(existing);
        auth.assertCustomer(existing);
        return linkAndHandoff(client, { session, authRecord: existing, draft, cartValidation });
      }

      const tenant = await client.query('SELECT id FROM TENANTS WHERE id = $1 AND is_active = true', [tenantId]);
      if (!tenant.rows[0]) throw new AppError('Tenant is unavailable', 400, 'TENANT_UNAVAILABLE');
      const authRecord = await auth.createCustomerAuth(client, tenantId, {
        fullName: draft.contact.fullName.trim(),
        email: session.email_normalized,
        // OTP, not this generated credential, is the authority for this
        // checkout. It does not alter existing password/Google identities.
        password: crypto.randomBytes(32).toString('base64url'),
        verified: true,
      });
      return linkAndHandoff(client, { session, authRecord, draft, cartValidation });
    },
  });

  const finalizePassword = async ({ tenantId, resumeToken, password }) => withSession({
    tenantId,
    resumeToken,
    operation: async ({ client, session, draft, cartValidation }) => {
      const authRecord = session.customer_id
        ? await loadCustomerAuth(client, tenantId, session.customer_id)
        : await auth.findAuthByEmail(client, tenantId, session.email_normalized, { forUpdate: true });
      auth.assertActive(authRecord);
      auth.assertCustomer(authRecord);
      await auth.verifyPassword(authRecord, password);
      return linkAndHandoff(client, { session, authRecord, draft, cartValidation });
    },
  });

  // A normal authenticated customer session remains the authority here. This
  // does not create a checkout-specific credential; it only completes the
  // already-authenticated customer's draft/address handoff.
  const finalizeCurrentCustomer = async ({ tenantId, resumeToken, customerId }) => withSession({
    tenantId,
    resumeToken,
    operation: async ({ client, session, draft, cartValidation }) => {
      const authRecord = await loadCustomerAuth(client, tenantId, customerId);
      auth.assertActive(authRecord);
      auth.assertCustomer(authRecord);
      if (authRecord.email !== session.email_normalized) {
        throw new ConflictError('Checkout session identity cannot be changed');
      }
      return linkAndHandoff(client, { session, authRecord, draft, cartValidation });
    },
  });

  const finalizeRegistration = async ({ tenantId, resumeToken, password }) => {
    if (!isStrongCustomerPassword(password)) {
      throw new AppError('Password does not meet the required security standard', 400, 'WEAK_PASSWORD');
    }

    return withSession({
      tenantId,
      resumeToken,
      operation: async ({ client, session, draft, cartValidation }) => {
        if (session.customer_id) {
          const linkedAuth = await loadCustomerAuth(client, tenantId, session.customer_id);
          auth.assertActive(linkedAuth);
          auth.assertCustomer(linkedAuth);
          await auth.verifyPassword(linkedAuth, password);
          return linkAndHandoff(client, { session, authRecord: linkedAuth, draft, cartValidation });
        }

        const existing = await auth.findAuthByEmail(client, tenantId, session.email_normalized, { forUpdate: true });
        if (existing) {
          throw new ConflictError('Identity verification is required to continue checkout');
        }

        const tenant = await client.query(
          'SELECT id FROM TENANTS WHERE id = $1 AND is_active = true',
          [tenantId]
        );
        if (!tenant.rows[0]) throw new AppError('Tenant is unavailable', 400, 'TENANT_UNAVAILABLE');

        const authRecord = await auth.createCustomerAuth(client, tenantId, {
          fullName: draft.contact.fullName.trim(),
          email: session.email_normalized,
          password,
        });
        return linkAndHandoff(client, { session, authRecord, draft, cartValidation });
      },
    });
  };

  const finalizeGoogle = async ({ tenantId, resumeToken, idToken }) => {
    // Token verification may contact provider metadata, so do it before the
    // short transaction that claims the checkout session.
    const identity = await auth.verifyGoogleIdentity(tenantId, idToken);

    return withSession({
      tenantId,
      resumeToken,
      operation: async ({ client, session, draft, cartValidation }) => {
        if (identity.email !== session.email_normalized) {
          throw new AuthenticationError('Google sign-in could not be verified');
        }
        const subjectAuth = await auth.findAuthByGoogleSubject(client, tenantId, identity.subject, { forUpdate: true });
        if (subjectAuth) {
          auth.assertActive(subjectAuth);
          auth.assertCustomer(subjectAuth);
          return linkAndHandoff(client, { session, authRecord: subjectAuth, draft, cartValidation });
        }

        if (session.customer_id) {
          throw new ConflictError('Checkout session identity cannot be changed');
        }

        // A matching email never creates a provider link. The neutral result
        // intentionally does not disclose whether that existing account uses
        // a password, Google, or belongs to staff.
        const existingEmail = await auth.findAuthByEmail(client, tenantId, identity.email, { forUpdate: true });
        if (existingEmail) {
          throw new ConflictError('Identity verification is required to continue checkout');
        }

        const tenant = await client.query(
          'SELECT id FROM TENANTS WHERE id = $1 AND is_active = true',
          [tenantId]
        );
        if (!tenant.rows[0]) throw new AppError('Tenant is unavailable', 400, 'TENANT_UNAVAILABLE');

        const authRecord = await auth.createCustomerAuth(client, tenantId, {
          fullName: draft.contact.fullName.trim() || identity.fullName,
          email: identity.email,
          password: crypto.randomBytes(32).toString('base64url'),
          googleSubject: identity.subject,
          verified: true,
        });
        return linkAndHandoff(client, { session, authRecord, draft, cartValidation });
      },
    });
  };

  return { requestEmailOtp, verifyEmailOtp, finalizePassword, finalizeCurrentCustomer, finalizeRegistration, finalizeGoogle };
};

const service = createCheckoutIdentityService();
module.exports = { ...service, createCheckoutIdentityService, SESSION_STATES };
