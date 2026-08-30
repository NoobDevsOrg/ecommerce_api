const authService = require('./auth.service');
const ResponseFormatter = require('../../utils/response');

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

  await authService.logout(refreshToken, req.user.id);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Logout successful',
    data: null,
  });
};
