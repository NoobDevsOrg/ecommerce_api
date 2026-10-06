const express = require('express');
const authController = require('./auth.controller');
const { authenticate } = require('../../middleware/auth');
const { authRateLimiter } = require('../../middleware/rateLimiter');
const validateRequest = require('../../middleware/validateRequest');
const {
  loginSchema,
  refreshSchema,
  emptyRequestSchema,
  registerSchema,
  customerLoginSchema,
  googleSchema,
  updateCustomerProfileSchema,
  customerOtpSendSchema,
  customerOtpVerifySchema,
  passwordForgotSchema,
  passwordResetSchema,
} = require('./auth.validator');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();

router.post('/login', authRateLimiter, validateRequest(loginSchema), asyncHandler(authController.login));
router.post('/register', authRateLimiter, validateRequest(registerSchema), asyncHandler(authController.register));
router.post('/customer/login', authRateLimiter, validateRequest(customerLoginSchema), asyncHandler(authController.customerLogin));
router.post('/customer/email/send', authRateLimiter, validateRequest(customerOtpSendSchema), asyncHandler(authController.customerEmailOtpSend));
router.post('/customer/email/verify', authRateLimiter, validateRequest(customerOtpVerifySchema), asyncHandler(authController.customerEmailOtpVerify));
router.post('/customer/password/forgot', authRateLimiter, validateRequest(passwordForgotSchema), asyncHandler(authController.customerPasswordForgot));
router.post('/customer/password/reset', authRateLimiter, validateRequest(passwordResetSchema), asyncHandler(authController.customerPasswordReset));
router.post('/google', authRateLimiter, validateRequest(googleSchema), asyncHandler(authController.googleSignIn));
router.post('/refresh', validateRequest(refreshSchema), asyncHandler(authController.refresh));

router.get('/me', validateRequest(emptyRequestSchema), authenticate, asyncHandler(authController.getCurrentUser));
router.get('/customer/me', validateRequest(emptyRequestSchema), authenticate, asyncHandler(authController.getCurrentCustomer));
router.patch('/customer/profile', authenticate, validateRequest(updateCustomerProfileSchema), asyncHandler(authController.updateCustomerProfile));
router.post('/logout', validateRequest(refreshSchema), authenticate, asyncHandler(authController.logout));

module.exports = router;
