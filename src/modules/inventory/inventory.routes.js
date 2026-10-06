const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./inventory.controller');
const { listInventorySchema, historySchema, adjustmentSchema } = require('./inventory.validator');

const router = express.Router();
router.use(authenticate, authorize({ roles: ['ADMIN', 'SUPPORT'] }));
router.get('/', validateRequest(listInventorySchema), asyncHandler(controller.list));
router.get('/:productId/history', validateRequest(historySchema), asyncHandler(controller.history));
router.post('/:productId/adjustments', validateRequest(adjustmentSchema), asyncHandler(controller.adjust));
module.exports = router;
