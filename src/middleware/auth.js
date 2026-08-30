const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { AuthenticationError, AuthorizationError } = require('../utils/errors');
const Logger = require('../utils/logger');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing authorization token');
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      throw new AuthenticationError('Missing authorization token');
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_error) {
      throw new AuthenticationError('Invalid or expired token');
    }

    const result = await pool.query(
      `SELECT a.id, a.email, a.is_active,a.tenant_id,
              s.id as staff_user_id, c.id as customer_id,
              s.role_id, r.code as role_code
       FROM AUTH a
       LEFT JOIN STAFF_USERS s ON a.staff_user_id = s.id
       LEFT JOIN CUSTOMERS c ON a.customer_id = c.id
       LEFT JOIN ROLES r ON s.role_id = r.id
       WHERE a.id = $1 AND a.tenant_id = $2`,
      [decoded.id, req.tenantId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw new AuthenticationError('User not found or inactive');
    }

    const user = result.rows[0];

    req.user = {
      id: user.id,
      email: user.email,
      tenant_id: user.tenant_id,
      staff_user_id: user.staff_user_id,
      customer_id: user.customer_id,
      role_id: user.role_id,
      role_code: user.role_code,
    };

    Logger.debug('User authenticated', { userId: user.id, email: user.email });
    return next();
  } catch (error) {
    Logger.error('Auth middleware error', {
      message: error.message,
      path: req.path,
    });
    return next(error);
  }
};

const authorize = (...args) => {
  let allowedRoles = [];
  let allowedUserIds = [];

  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    allowedRoles = Array.isArray(args[0].roles) ? args[0].roles : [];
    allowedUserIds = Array.isArray(args[0].userIds) ? args[0].userIds : [];
  } else {
    allowedRoles = args;
  }

  return (req, _res, next) => {
    if (!req.user) {
      return next(new AuthenticationError('Authentication is required'));
    }

    if (allowedUserIds.length === 0 && allowedRoles.length === 0) {
      return next();
    }

    if (allowedUserIds.includes(req.user.id)) {
      return next();
    }

    const role = req.user.role_code;
    if (allowedRoles.length > 0 && role && allowedRoles.includes(role)) {
      return next();
    }

    return next(new AuthorizationError('You do not have permission to access this resource'));
  };
};

module.exports = {
  authenticate,
  authorize,
};
