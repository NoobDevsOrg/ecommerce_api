const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { asyncHandler } = require('../../utils/errors');
const controller = require('./dashboard.controller');
const { overviewSchema } = require('./dashboard.validator');

const router = express.Router();
router.use(authenticate, authorize({ roles: ['ADMIN', 'SUPPORT'] }));
router.get('/overview', validateRequest(overviewSchema), asyncHandler(controller.overview));

module.exports = router;
