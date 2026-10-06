const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./shippingSettings.controller');
const { createZoneSchema, updateZoneSchema, updatePolicySchema, emptyRequestSchema } = require('./shippingSettings.validator');

const router = express.Router();
router.use(authenticate, authorize({ roles: ['ADMIN', 'SUPPORT'] }));
router.get('/settings', validateRequest(emptyRequestSchema), asyncHandler(controller.list));
router.put('/settings', validateRequest(updatePolicySchema), asyncHandler(controller.updatePolicy));
router.get('/zones', validateRequest(emptyRequestSchema), asyncHandler(controller.listZones));
router.post('/zones', validateRequest(createZoneSchema), asyncHandler(controller.createZone));
router.patch('/zones/:zoneId', validateRequest(updateZoneSchema), asyncHandler(controller.updateZone));
module.exports = router;
