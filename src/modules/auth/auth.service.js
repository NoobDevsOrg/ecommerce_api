const pool = require('../../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  AppError,
  AuthenticationError,
  NotFoundError,
} = require('../../utils/errors');
const Logger = require('../../utils/logger');

const hashToken = (value) => {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
};

const signAccessToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRY || '15m',
  });
};

const signRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRY || '30d',
  });
};

const buildUserPayload = (auth) => {
  return {
    id: auth.id,
    email: auth.email,
    staff_user_id: auth.staff_user_id,
    customer_id: auth.customer_id,
    user_type: auth.user_type,
    role_id: auth.role_id,
    role_code: auth.role_code,
  };
};

const persistRefreshToken = async (userId, refreshToken) => {
  await pool.query(
    `UPDATE AUTH
     SET reset_token = $1,
         reset_token_exp = now() + ($2 || ' seconds')::interval,
         updated_at = now()
     WHERE id = $3`,
    [hashToken(refreshToken), String(30 * 24 * 60 * 60), userId]
  );
};

exports.login = async (tenantId, email, password) => {
  try {
    if (!tenantId) {
      throw new AppError('Tenant not resolved for login', 400, 'TENANT_REQUIRED');
    }

    if (!email || !password) {
      throw new AppError('Email and password are required', 400, 'INVALID_CREDENTIAL_INPUT');
    }

    const result = await pool.query(
      `SELECT a.id, a.email, a.password_hash, a.is_active,
              s.id as staff_user_id, s.full_name as staff_name, s.role_id,
              r.code as role_code,
              c.id as customer_id, c.full_name as customer_name,
              CASE WHEN s.id IS NOT NULL THEN 'staff' ELSE 'customer' END as user_type
       FROM AUTH a
       LEFT JOIN STAFF_USERS s ON a.staff_user_id = s.id
       LEFT JOIN ROLES r ON s.role_id = r.id
       LEFT JOIN CUSTOMERS c ON a.customer_id = c.id
       WHERE a.tenant_id = $1 AND a.email = $2`,
      [tenantId, email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      throw new AuthenticationError('Invalid email or password');
    }

    const auth = result.rows[0];

    if (!auth.is_active) {
      throw new AppError('Account is inactive', 403, 'ACCOUNT_INACTIVE');
    }

    const validPassword = await bcrypt.compare(password, auth.password_hash);
    if (!validPassword) {
      throw new AuthenticationError('Invalid email or password');
    }

    const userPayload = buildUserPayload(auth);
    const accessToken = signAccessToken({ ...userPayload, tenant_id: tenantId });
    const refreshToken = signRefreshToken({ id: auth.id, tenant_id: tenantId });

    await persistRefreshToken(auth.id, refreshToken);
    await pool.query('UPDATE AUTH SET last_login_at = now() WHERE id = $1', [auth.id]);

    Logger.info('User logged in', { email, userId: auth.id, tenantId });

    const user = {
      ...userPayload,
      ...(auth.staff_user_id && {
        full_name: auth.staff_name,
      }),
      ...(auth.customer_id && {
        full_name: auth.customer_name,
      }),
    };

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRY || '8h',
      user,
    };
  } catch (error) {
    Logger.error('Login error', { email, tenantId, message: error.message });
    throw error;
  }
};

exports.getCurrentUser = async (userId, tenantId) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.email, a.is_active,
              s.id as staff_user_id, s.full_name as staff_name, s.role_id,
              r.code as role_code,
              c.id as customer_id, c.full_name as customer_name,
              CASE WHEN s.id IS NOT NULL THEN 'staff' ELSE 'customer' END as user_type
       FROM AUTH a
       LEFT JOIN STAFF_USERS s ON a.staff_user_id = s.id
       LEFT JOIN ROLES r ON s.role_id = r.id
       LEFT JOIN CUSTOMERS c ON a.customer_id = c.id
       WHERE a.id = $1 AND a.tenant_id = $2`,
      [userId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('User');
    }

    const auth = result.rows[0];

    return {
      id: auth.id,
      email: auth.email,
      is_active: auth.is_active,
      user_type: auth.user_type,
      ...(auth.staff_user_id && {
        staff_user_id: auth.staff_user_id,
        full_name: auth.staff_name,
        role_id: auth.role_id,
        role_code: auth.role_code,
      }),
      ...(auth.customer_id && {
        customer_id: auth.customer_id,
        full_name: auth.customer_name,
      }),
    };
  } catch (error) {
    Logger.error('Get current user error', { userId, tenantId, message: error.message });
    throw error;
  }
};

exports.refreshSession = async (refreshToken, tenantId) => {
  try {
    if (!refreshToken) {
      throw new AuthenticationError('Refresh token is required');
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (_error) {
      throw new AuthenticationError('Invalid or expired refresh token');
    }

    if (payload.tenant_id !== tenantId) {
      throw new AuthenticationError('Refresh token tenant mismatch');
    }

    const result = await pool.query(
      `SELECT id, email, is_active, reset_token
       FROM AUTH
       WHERE id = $1 AND tenant_id = $2`,
      [payload.id, tenantId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw new AuthenticationError('User not found or inactive');
    }

    const tokenHash = hashToken(refreshToken);
    if (!result.rows[0].reset_token || result.rows[0].reset_token !== tokenHash) {
      throw new AuthenticationError('Refresh token is no longer valid');
    }

    const user = await exports.getCurrentUser(result.rows[0].id, tenantId);
    const accessToken = signAccessToken({ ...user, tenant_id: tenantId });
    const newRefreshToken = signRefreshToken({ id: user.id, tenant_id: tenantId });

    await persistRefreshToken(user.id, newRefreshToken);

    return {
      accessToken,
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRY || '15m',
    };
  } catch (error) {
    Logger.error('Refresh session error', { message: error.message, tenantId });
    throw error;
  }
};

exports.logout = async (refreshToken, userId) => {
  try {
    if (!refreshToken) {
      throw new AuthenticationError('Refresh token is required');
    }

    const result = await pool.query('SELECT reset_token FROM AUTH WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new AuthenticationError('User not found');
    }

    if (result.rows[0].reset_token !== hashToken(refreshToken)) {
      throw new AuthenticationError('Refresh token is no longer valid');
    }

    await pool.query(
      `UPDATE AUTH
       SET reset_token = NULL,
           reset_token_exp = NULL,
           updated_at = now()
       WHERE id = $1`,
      [userId]
    );
  } catch (error) {
    Logger.error('Logout error', { message: error.message, userId });
    throw error;
  }
};
