const xss = require('xss');

const SQL_META_PATTERN = /(--|;|\/\*|\*\/|\b(drop|truncate|alter|union|sleep)\b)/i;

const sanitizeValue = (value) => {
  if (typeof value === 'string') {
    const cleaned = xss(value).trim();
    return cleaned.replace(/\u0000/g, '');
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === 'object') {
    const next = {};
    Object.keys(value).forEach((key) => {
      next[key] = sanitizeValue(value[key]);
    });
    return next;
  }

  return value;
};

const hasSuspiciousSqlMeta = (input) => {
  if (typeof input === 'string') {
    return SQL_META_PATTERN.test(input);
  }

  if (Array.isArray(input)) {
    return input.some(hasSuspiciousSqlMeta);
  }

  if (input && typeof input === 'object') {
    return Object.values(input).some(hasSuspiciousSqlMeta);
  }

  return false;
};

const sanitizeInput = (req, _res, next) => {
  req.body = sanitizeValue(req.body || {});
  req.query = sanitizeValue(req.query || {});
  req.params = sanitizeValue(req.params || {});

  req.hasSuspiciousInput =
    hasSuspiciousSqlMeta(req.body) ||
    hasSuspiciousSqlMeta(req.query) ||
    hasSuspiciousSqlMeta(req.params);

  return next();
};

module.exports = sanitizeInput;
