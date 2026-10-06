const express = require('express');
const { authenticate } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { AuthorizationError, asyncHandler } = require('../../utils/errors');
const controller = require('./payment.controller');
const { createRazorpayOrderSchema, verifyRazorpayPaymentSchema, paymentStateSchema } = require('./payment.validator');

const requireCustomer = (req, _res, next) => {
  if (!req.user?.customer_id || req.user.staff_user_id) return next(new AuthorizationError('Customer access is required'));
  return next();
};

const paymentRouter = express.Router();
paymentRouter.post('/razorpay/orders', authenticate, requireCustomer, validateRequest(createRazorpayOrderSchema), asyncHandler(controller.createRazorpayOrder));
paymentRouter.post('/razorpay/verify', authenticate, requireCustomer, validateRequest(verifyRazorpayPaymentSchema), asyncHandler(controller.verifyRazorpayPayment));
paymentRouter.get('/razorpay/orders/:orderReference', authenticate, requireCustomer, validateRequest(paymentStateSchema), asyncHandler(controller.getCustomerPaymentState));

const webhookRouter = express.Router();
webhookRouter.post('/', express.raw({ type: 'application/json', limit: '1mb' }), asyncHandler(controller.handleRazorpayWebhook));

module.exports = { paymentRouter, webhookRouter, requireCustomer };
