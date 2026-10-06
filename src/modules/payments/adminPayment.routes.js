const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./adminPayment.controller');
const { listPaymentsSchema, reportPaymentsSchema, paymentReferenceSchema, startReviewSchema, resolveReconciliationSchema } = require('./adminPayment.validator');

const router = express.Router();
router.use(authenticate, authorize({ roles: ['ADMIN', 'SUPPORT'] }));
router.get('/', validateRequest(listPaymentsSchema), asyncHandler(controller.list));
router.get('/report', validateRequest(reportPaymentsSchema), asyncHandler(controller.report));
router.post('/:paymentReference/reconciliation/review', validateRequest(startReviewSchema), asyncHandler(controller.startReview));
router.post('/:paymentReference/reconciliation/resolve', validateRequest(resolveReconciliationSchema), asyncHandler(controller.resolveReconciliation));
router.get('/:paymentReference', validateRequest(paymentReferenceSchema), asyncHandler(controller.getByReference));
module.exports = router;
