const Logger = require('../utils/logger');

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

const maskHeaders = (headers = {}) => {
  const copy = { ...headers };
  Object.keys(copy).forEach((key) => {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      copy[key] = '***';
    }
  });
  return copy;
};

const requestLogger = (req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    Logger.info('HTTP request', {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip,
      headers: maskHeaders(req.headers),
    });
  });

  next();
};

module.exports = requestLogger;
