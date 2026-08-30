const express = require('express');
const authController = require('./auth.controller');
const { authenticate } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const { loginSchema, refreshSchema, emptyRequestSchema } = require('./auth.validator');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();

router.post('/login', validateRequest(loginSchema), asyncHandler(authController.login));
router.post('/refresh', validateRequest(refreshSchema), asyncHandler(authController.refresh));

router.get('/me', validateRequest(emptyRequestSchema), authenticate, asyncHandler(authController.getCurrentUser));
router.post('/logout', validateRequest(refreshSchema), authenticate, asyncHandler(authController.logout));

module.exports = router;
