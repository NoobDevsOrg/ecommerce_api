const crypto = require('crypto');
const pool = require('../../config/db');
const cartService = require('../cart/cart.service');
const { normalizeEmail } = require('../auth/identity');
const { AppError, AuthenticationError, ConflictError, NotFoundError, ValidationError } = require('../../utils/errors');

const SESSION_STATES = Object.freeze({
  STARTED: 'STARTED',
  CONTACT_CAPTURED: 'CONTACT_CAPTURED',
  DETAILS_CAPTURED: 'DETAILS_CAPTURED',
  IDENTITY_REQUIRED: 'IDENTITY_REQUIRED',
  IDENTITY_VERIFIED: 'IDENTITY_VERIFIED',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
});

const STATE_RANK = Object.freeze({
  [SESSION_STATES.STARTED]: 0,
  [SESSION_STATES.CONTACT_CAPTURED]: 1,
  [SESSION_STATES.DETAILS_CAPTURED]: 2,
  [SESSION_STATES.IDENTITY_REQUIRED]: 3,
  [SESSION_STATES.IDENTITY_VERIFIED]: 4,
  [SESSION_STATES.COMPLETED]: 5,
  [SESSION_STATES.EXPIRED]: 6,
});

const hashSecret = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const generateResumeToken = () => crypto.randomBytes(32).toString('base64url');

const getTtlMinutes = () => {
  const configured = Number(process.env.CHECKOUT_SESSION_TTL_MINUTES || 60);
  if (!Number.isInteger(configured) || configured < 5 || configured > 1440) {
    throw new AppError('Checkout session configuration is invalid', 500, 'CHECKOUT_SESSION_CONFIGURATION_INVALID');
  }
  return configured;
};

const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
};

const normalizeItems = (items) => items.map((item) => ({
  productId: item.productId.trim(),
  quantity: Number(item.quantity),
}));

const normalizePhone = (value, country = 'IN') => {
  const compact = String(value).replace(/[\s()-]/g, '');
  if (compact.startsWith('+')) return `+${compact.slice(1).replace(/\D/g, '')}`;
  const digits = compact.replace(/\D/g, '');
  return String(country).toUpperCase() === 'IN' ? (digits.startsWith('91') && digits.length === 12 ? `+${digits}` : `+91${digits}`) : digits;
};

const normalizeContact = (current, input, country) => ({
  ...current,
  ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
  ...(input.phone !== undefined ? { phone: normalizePhone(input.phone, country) } : {}),
});

const normalizeAddress = (address) => ({
  fullName: address.fullName.trim(),
  phone: normalizePhone(address.phone, address.country),
  addressLine1: address.addressLine1.trim(),
  addressLine2: typeof address.addressLine2 === 'string' && address.addressLine2.trim() ? address.addressLine2.trim() : null,
  landmark: typeof address.landmark === 'string' && address.landmark.trim() ? address.landmark.trim() : null,
  city: address.city.trim(),
  state: address.state.trim(),
  pincode: address.pincode.trim(),
  country: address.country.trim().toUpperCase(),
});

const calculateState = ({ currentState, email, contact, address, items }) => {
  if (currentState === SESSION_STATES.IDENTITY_VERIFIED || currentState === SESSION_STATES.COMPLETED) {
    return currentState;
  }

  let candidate = SESSION_STATES.STARTED;
  if (email) candidate = SESSION_STATES.CONTACT_CAPTURED;
  if (email && contact.fullName && contact.phone && Array.isArray(items) && items.length > 0) {
    candidate = SESSION_STATES.DETAILS_CAPTURED;
  }
  if (candidate === SESSION_STATES.DETAILS_CAPTURED && address) {
    candidate = SESSION_STATES.IDENTITY_REQUIRED;
  }
  return STATE_RANK[candidate] > STATE_RANK[currentState] ? candidate : currentState;
};

const sessionColumns = `id, tenant_id, resume_token_hash, state, email_normalized, customer_id,
  cart_draft, contact_draft, address_draft, expires_at, completed_at, created_at, updated_at`;

const createCheckoutSessionService = ({
  database = pool,
  carts = cartService,
  now = () => new Date(),
  tokenGenerator = generateResumeToken,
} = {}) => {
  const validateCart = async (tenantId, items, { rejectUnavailable }) => {
    const validation = await carts.validateItems(tenantId, items);
    if (rejectUnavailable && (validation.invalidItems.length > 0 || validation.items.length !== items.length)) {
      throw new ValidationError('Your bag has changed. Review the unavailable items before checkout.', validation.invalidItems);
    }
    return validation;
  };

  const assertSessionCustomer = async (client, tenantId, customerId) => {
    if (!customerId) return;
    const result = await client.query(
      'SELECT id FROM CUSTOMERS WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId]
    );
    if (!result.rows[0]) throw new AuthenticationError('Customer session is unavailable');
  };

  const expireIfNeeded = async (client, row) => {
    if (new Date(row.expires_at).getTime() > now().getTime()) return;
    if (row.state !== SESSION_STATES.EXPIRED) {
      await client.query(
        `UPDATE CHECKOUT_SESSIONS
         SET state = $1, updated_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [SESSION_STATES.EXPIRED, row.id, row.tenant_id]
      );
    }
    throw new NotFoundError('Checkout session');
  };

  const lockByResumeToken = async (client, tenantId, resumeToken) => {
    const result = await client.query(
      `SELECT ${sessionColumns}
       FROM CHECKOUT_SESSIONS
       WHERE tenant_id = $1 AND resume_token_hash = $2
       FOR UPDATE`,
      [tenantId, hashSecret(resumeToken)]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Checkout session');
    await expireIfNeeded(client, row);
    if (row.state === SESSION_STATES.EXPIRED) throw new NotFoundError('Checkout session');
    if (row.state === SESSION_STATES.COMPLETED || row.completed_at) {
      throw new ConflictError('Checkout session is no longer available');
    }
    return row;
  };

  const present = (row, cartValidation) => ({
    state: row.state,
    email: row.email_normalized || null,
    contact: parseJson(row.contact_draft, {}),
    address: parseJson(row.address_draft, null),
    cart: parseJson(row.cart_draft, []),
    cartValidation: {
      items: cartValidation.items,
      invalidItems: cartValidation.invalidItems,
      subtotal: cartValidation.subtotal,
    },
    expiresAt: row.expires_at,
  });

  const start = async ({ tenantId, customerId = null, items, idempotencyKey }) => {
    if (!tenantId) throw new AppError('Tenant not resolved', 400, 'TENANT_REQUIRED');
    const cartDraft = normalizeItems(items);
    await validateCart(tenantId, cartDraft, { rejectUnavailable: true });

    const resumeToken = tokenGenerator();
    const resumeTokenHash = hashSecret(resumeToken);
    const startIdempotencyHash = hashSecret(idempotencyKey);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await assertSessionCustomer(client, tenantId, customerId);
      const existing = await client.query(
        `SELECT id FROM CHECKOUT_SESSIONS
         WHERE tenant_id = $1 AND start_idempotency_hash = $2
         FOR UPDATE`,
        [tenantId, startIdempotencyHash]
      );
      if (existing.rows[0]) {
        throw new ConflictError('Checkout session start was already processed');
      }

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + getTtlMinutes() * 60 * 1000);
      const result = await client.query(
        `INSERT INTO CHECKOUT_SESSIONS
           (id, tenant_id, resume_token_hash, start_idempotency_hash, state, customer_id,
            cart_draft, contact_draft, address_draft, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '{}'::jsonb, NULL, $8, $9, $9)
         RETURNING ${sessionColumns}`,
        [
          crypto.randomUUID(), tenantId, resumeTokenHash, startIdempotencyHash,
          SESSION_STATES.STARTED, customerId, JSON.stringify(cartDraft), expiresAt, createdAt,
        ]
      );
      await client.query('COMMIT');
      const cartValidation = await validateCart(tenantId, cartDraft, { rejectUnavailable: false });
      return { resumeToken, ...present(result.rows[0], cartValidation) };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505' && error?.constraint === 'uq_checkout_sessions_tenant_start_idempotency') {
        throw new ConflictError('Checkout session start was already processed');
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const resume = async ({ tenantId, resumeToken }) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const row = await lockByResumeToken(client, tenantId, resumeToken);
      const cartValidation = await validateCart(tenantId, parseJson(row.cart_draft, []), { rejectUnavailable: false });
      await client.query('COMMIT');
      return present(row, cartValidation);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const updateDraft = async ({ tenantId, resumeToken, input }) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const row = await lockByResumeToken(client, tenantId, resumeToken);
      if (row.state === SESSION_STATES.IDENTITY_VERIFIED) {
        throw new ConflictError('Checkout session identity is already finalized');
      }
      const currentContact = parseJson(row.contact_draft, {});
      const currentCart = parseJson(row.cart_draft, []);
      const nextEmail = input.email === undefined ? row.email_normalized : normalizeEmail(input.email);
      const nextAddress = input.address === undefined ? parseJson(row.address_draft, null) : normalizeAddress(input.address);
      const nextContact = normalizeContact(currentContact, input, nextAddress?.country);
      const nextCart = input.items === undefined ? currentCart : normalizeItems(input.items);
      const cartValidation = await validateCart(tenantId, nextCart, { rejectUnavailable: input.items !== undefined });
      const nextState = calculateState({
        currentState: row.state,
        email: nextEmail,
        contact: nextContact,
        address: nextAddress,
        items: nextCart,
      });
      const result = await client.query(
        `UPDATE CHECKOUT_SESSIONS
         SET state = $1, email_normalized = $2, contact_draft = $3::jsonb,
             address_draft = $4::jsonb, cart_draft = $5::jsonb, updated_at = now()
         WHERE id = $6 AND tenant_id = $7
         RETURNING ${sessionColumns}`,
        [
          nextState, nextEmail || null, JSON.stringify(nextContact),
          nextAddress ? JSON.stringify(nextAddress) : null, JSON.stringify(nextCart),
          row.id, tenantId,
        ]
      );
      await client.query('COMMIT');
      return present(result.rows[0], cartValidation);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  // Internal future handoff only. No HTTP endpoint exposes completion in this
  // foundation; identity finalization will call this after trusted completion.
  const markCompleted = async ({ tenantId, resumeToken }) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const row = await lockByResumeToken(client, tenantId, resumeToken);
      const result = await client.query(
        `UPDATE CHECKOUT_SESSIONS
         SET state = $1, completed_at = now(), updated_at = now()
         WHERE id = $2 AND tenant_id = $3
         RETURNING ${sessionColumns}`,
        [SESSION_STATES.COMPLETED, row.id, tenantId]
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  return { start, resume, updateDraft, markCompleted };
};

const service = createCheckoutSessionService();
module.exports = { ...service, createCheckoutSessionService, SESSION_STATES, hashSecret, getTtlMinutes };
