const authService = require('./auth.service');
const ResponseFormatter = require('../../utils/response');
const Logger = require('../../utils/logger');

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const tenantId = req.tenantId;

  const result = await authService.login(tenantId, email, password);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Login successful',
    data: {
      ...result,
      tenant: req.tenant,
    },
  });
};

exports.register = async (req, res) => {
  const result = await authService.registerCustomer(req.tenantId, req.body);

  return ResponseFormatter.send(res, {
    statusCode: 201,
    message: 'Account created successfully',
    data: { ...result, tenant: req.tenant },
  });
};

exports.customerLogin = async (req, res) => {
  const result = await authService.loginCustomer(req.tenantId, req.body.email, req.body.password);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Login successful',
    data: { ...result, tenant: req.tenant },
  });
};
exports.customerEmailOtpSend = async (req, res) => {
  const startedAt = performance.now();
  try {
    const result = await authService.requestCustomerLoginOtp(req.tenantId, req.body.email);
    return ResponseFormatter.send(res, { statusCode: 200, message: 'If this email can be used to sign in, we’ve sent a verification code.', data: result });
  } finally {
    // No email or OTP is included in this operational measurement.
    Logger.info('Customer login OTP request timing', { totalRequestMs: Number((performance.now() - startedAt).toFixed(1)) });
  }
};
exports.customerEmailOtpVerify = async (req, res) => {
  const result = await authService.verifyCustomerLoginOtp(req.tenantId, req.body.email, req.body.code);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Login successful', data: { ...result, tenant: req.tenant } });
};
exports.customerPasswordForgot = async (req, res) => { const result = await authService.requestPasswordReset(req.tenantId, req.body.email); return ResponseFormatter.send(res, { statusCode: 200, message: 'If this email can reset a password, we’ve sent a verification code.', data: result }); };
exports.customerPasswordReset = async (req, res) => { await authService.resetCustomerPassword(req.tenantId, req.body); return ResponseFormatter.send(res, { statusCode: 200, message: 'Password updated successfully', data: null }); };

exports.googleSignIn = async (req, res) => {
  const result = await authService.authenticateGoogleCustomer(req.tenantId, req.body.idToken);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Login successful',
    data: { ...result, tenant: req.tenant },
  });
};

exports.getCurrentUser = async (req, res) => {
  const userId = req.user.id;
  const tenantId = req.tenantId;

  const data = await authService.getCurrentUser(userId, tenantId);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'User fetched successfully',
    data,
  });
};

exports.getCurrentCustomer = async (req, res) => {
  const data = await authService.getCurrentCustomer(req.user.id, req.tenantId);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Customer profile fetched successfully',
    data,
  });
};

exports.updateCustomerProfile = async (req, res) => {
  const data = await authService.updateCustomerProfile(req.user.id, req.tenantId, req.body);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Customer profile updated successfully',
    data,
  });
};

exports.refresh = async (req, res) => {
  const { refreshToken } = req.body;
  const tenantId = req.tenantId;

  const data = await authService.refreshSession(refreshToken, tenantId);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Token refreshed successfully',
    data,
  });
};

exports.logout = async (req, res) => {
  const { refreshToken } = req.body;

  await authService.logout(refreshToken, req.user.id, req.tenantId);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Logout successful',
    data: null,
  });
};
