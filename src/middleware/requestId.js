const crypto = require('crypto');

const TRUSTED_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[4-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

module.exports = (req, res, next) => {
  const incoming = String(req.get('x-request-id') || '');
  req.requestId = TRUSTED_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
};
