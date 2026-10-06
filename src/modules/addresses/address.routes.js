const express = require('express');
const { authenticate } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { AuthorizationError, asyncHandler } = require('../../utils/errors');
const controller = require('./address.controller');
const { addressIdSchema, createAddressSchema, emptyRequestSchema, updateAddressSchema } = require('./address.validator');

const router = express.Router();

const requireCustomer = (req, _res, next) => {
  if (!req.user?.customer_id || req.user.staff_user_id) {
    return next(new AuthorizationError('Customer access is required'));
  }
  return next();
};

router.use(authenticate, requireCustomer);
router.get('/', validateRequest(emptyRequestSchema), asyncHandler(controller.list));
router.post('/', validateRequest(createAddressSchema), asyncHandler(controller.create));
router.patch('/:id', validateRequest(updateAddressSchema), asyncHandler(controller.update));
router.delete('/:id', validateRequest(addressIdSchema), asyncHandler(controller.remove));
router.put('/:id/default', validateRequest(addressIdSchema), asyncHandler(controller.setDefault));

module.exports = router;
