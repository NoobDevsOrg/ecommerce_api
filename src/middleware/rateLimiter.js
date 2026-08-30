const rateLimit = require('express-rate-limit');
const ResponseFormatter = require('../utils/response');

const isProduction = process.env.NODE_ENV === 'production';
const defaultLimit = isProduction ? 120 : 1000;

function getRequestScope(req) {
  const requestPath = req.path || '';
  const isAdminRequest = requestPath.startsWith('/products/admin/')
    || requestPath.startsWith('/products/enquiries/');

  return isAdminRequest ? 'admin' : 'public';
}

const rateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.RATE_LIMIT_MAX || defaultLimit),
  standardHeaders: true,
  legacyHeaders: false,
  // Keep public and authenticated-admin route traffic out of the same IP bucket.
  // `trust proxy` is configured by the application, so req.ip remains the canonical client IP.
  keyGenerator: (req) => `${getRequestScope(req)}:${req.ip || 'unknown'}`,
  handler: (req, res) => {
    return ResponseFormatter.sendError(res, {
      statusCode: 429,
      message: 'Too many requests. Please try again later.',
      errorCode: 'RATE_LIMIT_EXCEEDED',
    });
  },
});

module.exports = rateLimiter;
