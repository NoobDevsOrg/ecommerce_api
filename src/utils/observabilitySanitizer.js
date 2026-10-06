const SENSITIVE = /(password|passphrase|authorization|cookie|token|jwt|session|otp|verification.?code|(^|[_-])code($|[_-])|signature|secret|smtp|database|db.?url|api.?key|credential)/i;
const PII = /(email|phone|mobile|address|full.?name|first.?name|last.?name)/i;

const mask = (value) => typeof value === 'string' && value.length > 0 ? '***' : '[redacted]';

const sanitize = (value, { maskPii = true, depth = 0 } = {}) => {
  if (depth > 12) return '[truncated]';
  if (Buffer.isBuffer(value)) return '[omitted binary payload]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, { maskPii, depth: depth + 1 }));
  if (!value || typeof value !== 'object') return value;
  if (value.buffer && (value.mimetype || value.originalname || value.size)) return '[omitted file payload]';
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SENSITIVE.test(key)) return [key, mask(item)];
    if (maskPii && PII.test(key)) return [key, '[masked]'];
    return [key, sanitize(item, { maskPii, depth: depth + 1 })];
  }));
};

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

module.exports = { sanitize, byteLength };
