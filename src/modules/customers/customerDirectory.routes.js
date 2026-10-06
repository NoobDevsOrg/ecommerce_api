const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./customerDirectory.controller');
const { listCustomersSchema, customerIdSchema, customerOrdersSchema } = require('./customerDirectory.validator');

const router = express.Router();

router.use(authenticate, authorize({ roles: ['ADMIN', 'SUPPORT'] }));
router.get('/', validateRequest(listCustomersSchema), asyncHandler(controller.list));
router.get('/report', validateRequest(listCustomersSchema), asyncHandler(controller.report));
router.get('/:customerId/orders', validateRequest(customerOrdersSchema), asyncHandler(controller.listOrders));
router.get('/:customerId', validateRequest(customerIdSchema), asyncHandler(controller.getById));

module.exports = router;
