const crypto = require('crypto');
const pool = require('../../config/db');
const { AppError, AuthenticationError, ConflictError } = require('../../utils/errors');
const { normalizeEmail } = require('./identity');

const PURPOSES = Object.freeze({ CUSTOMER_LOGIN: 'CUSTOMER_LOGIN', PASSWORD_RESET: 'PASSWORD_RESET' });
const config = (name, fallback, min, max) => { const value = Number(process.env[name] || fallback); if (!Number.isInteger(value) || value < min || value > max) throw new AppError('Email verification is temporarily unavailable', 503, 'CUSTOMER_AUTH_OTP_UNAVAILABLE'); return value; };
const secret = () => process.env.CUSTOMER_AUTH_OTP_SECRET || process.env.CHECKOUT_OTP_SECRET || (() => { throw new AppError('Email verification is temporarily unavailable', 503, 'CUSTOMER_AUTH_OTP_UNAVAILABLE'); })();
const codeHash = (tenantId, purpose, email, code) => crypto.createHmac('sha256', secret()).update(`customer-auth:${tenantId}:${purpose}:${email}:${code}`).digest('hex');
const code = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const createCustomerAuthVerificationService = ({ database = pool, now = () => new Date(), sendEmail = async () => {}, generateCode = code, onTiming = () => {} } = {}) => {
  const ttl = () => config('CUSTOMER_AUTH_OTP_TTL_MINUTES', 10, 5, 15);
  const cooldown = () => config('CUSTOMER_AUTH_OTP_RESEND_SECONDS', 60, 30, 300);
  const resendAvailableAt = () => new Date(now().getTime() + cooldown() * 1000);
  const create = async ({ tenantId, purpose, email }) => {
    if (!Object.values(PURPOSES).includes(purpose)) throw new AppError('Verification purpose is invalid', 400, 'VERIFICATION_PURPOSE_INVALID');
    const normalizedEmail = normalizeEmail(email); const startedAt = performance.now(); const client = await database.connect(); let delivery;
    try { await client.query('BEGIN'); const existing = await client.query(`SELECT * FROM CUSTOMER_AUTH_VERIFICATIONS WHERE tenant_id=$1 AND purpose=$2 AND normalized_email=$3 AND consumed_at IS NULL FOR UPDATE`, [tenantId, purpose, normalizedEmail]); const row = existing.rows[0]; const at = now();
      if (row && new Date(row.resend_available_at) > at) throw new AppError('Please wait before requesting another verification code', 429, 'CUSTOMER_AUTH_OTP_RESEND_COOLDOWN');
      if (row && row.send_count >= 5) throw new AppError('Too many verification codes requested. Please try again later.', 429, 'CUSTOMER_AUTH_OTP_SEND_LIMIT');
      const otp = generateCode(); const expiresAt = new Date(at.getTime() + ttl() * 60000); const resendAt = new Date(at.getTime() + cooldown() * 1000); const hash = codeHash(tenantId, purpose, normalizedEmail, otp);
      if (row) await client.query('UPDATE CUSTOMER_AUTH_VERIFICATIONS SET code_hash=$1, expires_at=$2, resend_available_at=$3, send_count=send_count+1, attempt_count=0, updated_at=now() WHERE id=$4 AND tenant_id=$5', [hash, expiresAt, resendAt, row.id, tenantId]);
      else await client.query('INSERT INTO CUSTOMER_AUTH_VERIFICATIONS (id,tenant_id,purpose,normalized_email,code_hash,expires_at,resend_available_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [crypto.randomUUID(), tenantId, purpose, normalizedEmail, hash, expiresAt, resendAt]);
      await client.query('COMMIT'); delivery = { to: normalizedEmail, code: otp, purpose, expiresAt, resendAt };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const challengeDbMs = Number((performance.now() - startedAt).toFixed(1));
    const { expiresAt, resendAt } = delivery;
    try { await sendEmail(delivery); } finally {
      // Drop the sole raw-code-bearing object as soon as delivery finishes.
      delivery = undefined;
      onTiming({ challengeDbMs, purpose });
    }
    return { expiresAt, resendAvailableAt: resendAt };
  };
  const verify = async ({ tenantId, purpose, email, otp }) => { const normalizedEmail = normalizeEmail(email); const client = await database.connect(); try { await client.query('BEGIN'); const result = await client.query('SELECT * FROM CUSTOMER_AUTH_VERIFICATIONS WHERE tenant_id=$1 AND purpose=$2 AND normalized_email=$3 AND consumed_at IS NULL FOR UPDATE', [tenantId, purpose, normalizedEmail]); const row = result.rows[0]; const valid = row && row.attempt_count < 5 && new Date(row.expires_at) > now() && crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(codeHash(tenantId, purpose, normalizedEmail, otp), 'hex'));
      if (!valid) { if (row && row.attempt_count < 5) await client.query('UPDATE CUSTOMER_AUTH_VERIFICATIONS SET attempt_count=attempt_count+1, updated_at=now() WHERE id=$1 AND tenant_id=$2', [row.id, tenantId]); await client.query('COMMIT'); throw new AuthenticationError('Invalid or expired verification code'); }
      const consumed = await client.query('UPDATE CUSTOMER_AUTH_VERIFICATIONS SET consumed_at=now(), updated_at=now() WHERE id=$1 AND tenant_id=$2 AND consumed_at IS NULL RETURNING id', [row.id, tenantId]); if (!consumed.rows[0]) throw new ConflictError('Verification code has already been used'); await client.query('COMMIT'); return { normalizedEmail, purpose };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } };
  return { create, verify, resendAvailableAt };
};
module.exports = { PURPOSES, createCustomerAuthVerificationService };
