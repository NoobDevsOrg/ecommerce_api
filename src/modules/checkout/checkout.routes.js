const express = require('express');
const { authenticate, optionalAuthenticate } = require('../../middleware/auth');
const { authRateLimiter } = require('../../middleware/rateLimiter');
const validateRequest = require('../../middleware/validateRequest');
const { AuthorizationError, asyncHandler } = require('../../utils/errors');
const controller = require('./checkout.controller');
const { prepareCheckoutSchema } = require('./checkout.validator');
const checkoutSessionController = require('./checkoutSession.controller');
const checkoutIdentityController = require('./checkoutIdentity.controller');
const { requireCheckoutResumeToken } = require('./checkoutSession.middleware');
const {
  startCheckoutSessionSchema,
  updateCheckoutSessionSchema,
  emptyCheckoutSessionSchema,
} = require('./checkoutSession.validator');
const {
  checkoutPasswordSchema,
  checkoutRegistrationSchema,
  checkoutGoogleSchema,
  checkoutOtpVerifySchema,
} = require('./checkoutIdentity.validator');

const router = express.Router();

const requireCustomer = (req, _res, next) => {
  if (!req.user?.customer_id || req.user.staff_user_id) {
    return next(new AuthorizationError('Customer access is required'));
  }
  return next();
};

router.post('/sessions', optionalAuthenticate, validateRequest(startCheckoutSessionSchema), asyncHandler(checkoutSessionController.start));
router.get('/sessions/resume', optionalAuthenticate, requireCheckoutResumeToken, validateRequest(emptyCheckoutSessionSchema), asyncHandler(checkoutSessionController.resume));
router.patch('/sessions/draft', optionalAuthenticate, requireCheckoutResumeToken, validateRequest(updateCheckoutSessionSchema), asyncHandler(checkoutSessionController.updateDraft));
router.post('/sessions/identity/password', authRateLimiter, optionalAuthenticate, requireCheckoutResumeToken, validateRequest(checkoutPasswordSchema), asyncHandler(checkoutIdentityController.password));
router.post('/sessions/identity/current', authenticate, requireCustomer, requireCheckoutResumeToken, validateRequest(emptyCheckoutSessionSchema), asyncHandler(checkoutIdentityController.currentCustomer));
router.post('/sessions/identity/register', authRateLimiter, optionalAuthenticate, requireCheckoutResumeToken, validateRequest(checkoutRegistrationSchema), asyncHandler(checkoutIdentityController.register));
router.post('/sessions/identity/google', authRateLimiter, optionalAuthenticate, requireCheckoutResumeToken, validateRequest(checkoutGoogleSchema), asyncHandler(checkoutIdentityController.google));
router.post('/sessions/identity/email/send', authRateLimiter, optionalAuthenticate, requireCheckoutResumeToken, validateRequest(emptyCheckoutSessionSchema), asyncHandler(checkoutIdentityController.sendEmailOtp));
router.post('/sessions/identity/email/verify', authRateLimiter, optionalAuthenticate, requireCheckoutResumeToken, validateRequest(checkoutOtpVerifySchema), asyncHandler(checkoutIdentityController.verifyEmailOtp));
router.post('/prepare', authenticate, requireCustomer, validateRequest(prepareCheckoutSchema), asyncHandler(controller.prepare));

router.requireCustomer = requireCustomer;
module.exports = router;
