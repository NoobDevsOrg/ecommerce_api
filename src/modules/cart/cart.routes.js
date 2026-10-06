const express = require('express');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./cart.controller');
const { validateCartSchema } = require('./cart.validator');

const router = express.Router();

// Guests and signed-in customers use the same stateless browser cart. Tenant
// resolution is performed by the global middleware; this route accepts no
// client-authoritative tenant, price, or capability values.
router.post('/validate', validateRequest(validateCartSchema), asyncHandler(controller.validate));

module.exports = router;
