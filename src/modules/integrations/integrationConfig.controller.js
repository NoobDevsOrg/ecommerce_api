const integrationConfigService = require('./integrationConfig.service');
const ResponseFormatter = require('../../utils/response');
const audit = require('../../services/audit.service');
const Logger = require('../../utils/logger');
const auditConfiguration = (req, entityId, action, afterSnapshot) => void audit.record(audit.eventFromRequest(req, { tenantId: req.tenantId, entityType: 'INTEGRATION', entityId, action, afterSnapshot }))
  .catch((error) => Logger.warn('Integration audit persistence failed', { requestId: req.requestId, message: error.message }));

exports.getPublicGoogleConfiguration = async (req, res) => {
  const data = await integrationConfigService.getPublicGoogleConfiguration(req.tenantId);
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Google sign-in configuration fetched',
    data,
  });
};

exports.getAdminGoogleConfiguration = async (req, res) => {
  const data = await integrationConfigService.getAdminGoogleConfiguration(req.tenantId);
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Google sign-in configuration fetched',
    data,
  });
};

exports.updateGoogleConfiguration = async (req, res) => {
  const data = await integrationConfigService.updateGoogleConfiguration(req.tenantId, req.user.id, req.body);
  auditConfiguration(req, 'GOOGLE', 'INTEGRATION_UPDATED', data);
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Google sign-in configuration updated',
    data,
  });
};

exports.getAdminRazorpayConfiguration = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Razorpay configuration fetched',
  data: await integrationConfigService.getAdminRazorpayConfiguration(req.tenantId),
});

exports.updateRazorpayConfiguration = async (req, res) => {
  const data = await integrationConfigService.updateRazorpayConfiguration(req.tenantId, req.user.id, req.body);
  auditConfiguration(req, 'RAZORPAY', 'INTEGRATION_UPDATED', data);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Razorpay configuration updated', data });
};
