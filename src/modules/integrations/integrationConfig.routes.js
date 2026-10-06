const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./integrationConfig.controller');
const { emptyRequestSchema, updateGoogleConfigurationSchema, updateRazorpayConfigurationSchema } = require('./integrationConfig.validator');

const router = express.Router();
const manageIntegrations = [authenticate, authorize({ roles: ['ADMIN', 'SUPPORT'] })];

router.get('/public/google', validateRequest(emptyRequestSchema), asyncHandler(controller.getPublicGoogleConfiguration));
router.get('/admin/google', ...manageIntegrations, validateRequest(emptyRequestSchema), asyncHandler(controller.getAdminGoogleConfiguration));
router.put('/admin/google', ...manageIntegrations, validateRequest(updateGoogleConfigurationSchema), asyncHandler(controller.updateGoogleConfiguration));
router.get('/admin/razorpay', ...manageIntegrations, validateRequest(emptyRequestSchema), asyncHandler(controller.getAdminRazorpayConfiguration));
router.put('/admin/razorpay', ...manageIntegrations, validateRequest(updateRazorpayConfigurationSchema), asyncHandler(controller.updateRazorpayConfiguration));

module.exports = router;
