const express = require('express');
const { authenticate } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { AuthorizationError, asyncHandler } = require('../../utils/errors');
const controller = require('./order.controller');
const { paginationSchema, orderIdSchema, orderReferenceSchema, orderItemReviewParamsSchema } = require('./order.validator');

const router = express.Router();

const requireCustomer = (req, _res, next) => {
  if (!req.user?.customer_id || req.user.staff_user_id) {
    return next(new AuthorizationError('Customer access is required'));
  }
  return next();
};

router.use(authenticate, requireCustomer);
router.get('/me', validateRequest(paginationSchema), asyncHandler(controller.list));
router.get('/me/:orderReference/review-items', validateRequest(orderReferenceSchema), asyncHandler(controller.getReviewItems));
router.post('/me/:orderReference/items/:orderItemId/reviews', validateRequest(orderItemReviewParamsSchema), asyncHandler(controller.submitItemReview));
router.get('/me/:orderReference/related', validateRequest(orderReferenceSchema), asyncHandler(controller.getRelatedProducts));
router.get('/me/:orderReference', validateRequest(orderReferenceSchema), asyncHandler(controller.getByReference));
router.get('/', validateRequest(paginationSchema), asyncHandler(controller.list));
router.get('/:orderId', validateRequest(orderIdSchema), asyncHandler(controller.getById));

// Exposed for focused middleware tests; it is not an HTTP endpoint.
router.requireCustomer = requireCustomer;
module.exports = router;
