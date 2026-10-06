const { AuthenticationError } = require('../../utils/errors');

const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const requireCheckoutResumeToken = (req, _res, next) => {
  const token = String(req.get('x-checkout-resume-token') || '').trim();
  if (!RESUME_TOKEN_PATTERN.test(token)) {
    return next(new AuthenticationError('Checkout session is unavailable'));
  }

  req.checkoutResumeToken = token;
  return next();
};

module.exports = { requireCheckoutResumeToken };
