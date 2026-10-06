const crypto = require('crypto');
const { AppError } = require('../../../utils/errors');

const API_BASE_URL = 'https://api.razorpay.com/v1';

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new AppError('Online payment is temporarily unavailable', 503, 'PAYMENT_CONFIGURATION_MISSING');
  }
  return String(value).trim();
};

const assertModeMatchesKey = (mode, keyId) => {
  if (!['TEST', 'LIVE'].includes(mode)) {
    throw new AppError('Online payment is temporarily unavailable', 503, 'PAYMENT_CONFIGURATION_INVALID');
  }
  const expectedPrefix = mode === 'TEST' ? 'rzp_test_' : 'rzp_live_';
  if (!keyId.startsWith(expectedPrefix)) {
    throw new AppError('Online payment is temporarily unavailable', 503, 'PAYMENT_CONFIGURATION_INVALID');
  }
};

const runtimeCredentials = (mode) => {
  const keyId = requiredEnvironment('RAZORPAY_KEY_ID');
  const keySecret = requiredEnvironment('RAZORPAY_KEY_SECRET');
  assertModeMatchesKey(mode, keyId);
  return { keyId, keySecret };
};

const timingSafeEquals = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const request = async ({ method, path, body, mode }) => {
  const { keyId, keySecret } = runtimeCredentials(mode);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new AppError('Payment provider is temporarily unavailable', 503, 'PAYMENT_PROVIDER_ERROR');
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Payment provider is temporarily unavailable', 503, 'PAYMENT_PROVIDER_ERROR');
  } finally {
    clearTimeout(timeout);
  }
};

const createOrder = async ({ mode, amountPaise, currency, receipt, notes }) => {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || currency !== 'INR' || !receipt || receipt.length > 40) {
    throw new AppError('Payment request is invalid', 500, 'PAYMENT_PROVIDER_REQUEST_INVALID');
  }
  const result = await request({
    method: 'POST',
    path: '/orders',
    mode,
    body: { amount: amountPaise, currency, receipt, notes },
  });
  if (typeof result.id !== 'string' || result.amount !== amountPaise || result.currency !== currency) {
    throw new AppError('Payment provider returned an invalid order', 503, 'PAYMENT_PROVIDER_INVALID_RESPONSE');
  }
  return { id: result.id, amount: result.amount, currency: result.currency, receipt: result.receipt || receipt };
};

const fetchPayment = async ({ mode, paymentId }) => {
  if (!/^[A-Za-z0-9_]+$/.test(paymentId || '')) {
    throw new AppError('Payment response could not be verified', 400, 'PAYMENT_VERIFICATION_FAILED');
  }
  return request({ method: 'GET', path: `/payments/${encodeURIComponent(paymentId)}`, mode });
};

const verifyPaymentSignature = ({ mode, providerOrderId, paymentId, signature }) => {
  const { keySecret } = runtimeCredentials(mode);
  const expected = crypto.createHmac('sha256', keySecret).update(`${providerOrderId}|${paymentId}`).digest('hex');
  return timingSafeEquals(expected, signature);
};

const verifyWebhookSignature = ({ rawBody, signature }) => {
  const secret = requiredEnvironment('RAZORPAY_WEBHOOK_SECRET');
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return timingSafeEquals(expected, signature);
};

const getPublicKeyId = (mode) => runtimeCredentials(mode).keyId;

module.exports = {
  createOrder,
  fetchPayment,
  verifyPaymentSignature,
  verifyWebhookSignature,
  getPublicKeyId,
};
