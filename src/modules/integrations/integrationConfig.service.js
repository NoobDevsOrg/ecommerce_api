const crypto = require('crypto');
const pool = require('../../config/db');
const { AppError } = require('../../utils/errors');
const {
  GOOGLE_PROVIDER_CODE, GOOGLE_PROVIDER_MODE,
  RAZORPAY_PROVIDER_CODE, RAZORPAY_PROVIDER_MODES,
  providerRegistry,
} = require('./providerRegistry');

const assertGoogleProvider = () => {
  if (!providerRegistry[GOOGLE_PROVIDER_CODE]) {
    throw new AppError('Google provider is not supported', 503, 'INTEGRATION_UNAVAILABLE');
  }
};

const assertRazorpayProvider = () => {
  if (!providerRegistry[RAZORPAY_PROVIDER_CODE]) {
    throw new AppError('Razorpay provider is not supported', 503, 'INTEGRATION_UNAVAILABLE');
  }
};

const mapGoogleConfiguration = (row) => ({
  provider: GOOGLE_PROVIDER_CODE,
  isEnabled: Boolean(row?.is_enabled),
  mode: row?.mode || GOOGLE_PROVIDER_MODE,
  clientId: row?.safe_config?.clientId || null,
});

const findGoogleConfiguration = async (tenantId) => {
  const result = await pool.query(
    `SELECT is_enabled, mode, safe_config
     FROM INTEGRATION_CONFIGURATIONS
     WHERE tenant_id = $1 AND provider_code = $2`,
    [tenantId, GOOGLE_PROVIDER_CODE]
  );

  return result.rows[0] || null;
};

exports.getPublicGoogleConfiguration = async (tenantId) => {
  assertGoogleProvider();
  const configuration = mapGoogleConfiguration(await findGoogleConfiguration(tenantId));

  return {
    provider: configuration.provider,
    isEnabled: configuration.isEnabled,
    mode: configuration.mode,
    clientId: configuration.isEnabled ? configuration.clientId : null,
  };
};

exports.getAdminGoogleConfiguration = async (tenantId) => {
  assertGoogleProvider();
  return mapGoogleConfiguration(await findGoogleConfiguration(tenantId));
};

exports.getEnabledGoogleConfiguration = async (tenantId) => {
  assertGoogleProvider();
  const configuration = mapGoogleConfiguration(await findGoogleConfiguration(tenantId));

  if (!configuration.isEnabled || !configuration.clientId) {
    throw new AppError('Google sign-in is not configured', 503, 'GOOGLE_SIGN_IN_UNAVAILABLE');
  }

  return configuration;
};

exports.updateGoogleConfiguration = async (tenantId, actorUserId, { isEnabled, mode, clientId }) => {
  assertGoogleProvider();

  const safeConfig = { clientId: clientId || null };
  const result = await pool.query(
    `INSERT INTO INTEGRATION_CONFIGURATIONS
       (id, tenant_id, provider_code, is_enabled, mode, safe_config, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
     ON CONFLICT (tenant_id, provider_code)
     DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       mode = EXCLUDED.mode,
       safe_config = EXCLUDED.safe_config,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING is_enabled, mode, safe_config`,
    [
      crypto.randomUUID(),
      tenantId,
      GOOGLE_PROVIDER_CODE,
      isEnabled,
      mode,
      JSON.stringify(safeConfig),
      actorUserId,
    ]
  );

  return mapGoogleConfiguration(result.rows[0]);
};

const mapRazorpayConfiguration = (row) => ({
  provider: RAZORPAY_PROVIDER_CODE,
  isEnabled: Boolean(row?.is_enabled),
  mode: RAZORPAY_PROVIDER_MODES.includes(row?.mode) ? row.mode : 'TEST',
});

const findRazorpayConfiguration = async (tenantId) => {
  const result = await pool.query(
    `SELECT is_enabled, mode FROM INTEGRATION_CONFIGURATIONS
     WHERE tenant_id = $1 AND provider_code = $2`,
    [tenantId, RAZORPAY_PROVIDER_CODE]
  );
  return result.rows[0] || null;
};

exports.getAdminRazorpayConfiguration = async (tenantId) => {
  assertRazorpayProvider();
  return mapRazorpayConfiguration(await findRazorpayConfiguration(tenantId));
};

// Pending payments may still be verified after an administrator disables new
// payment starts, so verification uses this configuration without requiring it
// to be enabled. Secrets never pass through this service or this table.
exports.getRazorpayConfiguration = async (tenantId) => {
  assertRazorpayProvider();
  return mapRazorpayConfiguration(await findRazorpayConfiguration(tenantId));
};

exports.getEnabledRazorpayConfiguration = async (tenantId) => {
  const configuration = await exports.getRazorpayConfiguration(tenantId);
  if (!configuration.isEnabled) {
    throw new AppError('Online payment is temporarily unavailable', 503, 'PAYMENT_UNAVAILABLE');
  }
  return configuration;
};

exports.updateRazorpayConfiguration = async (tenantId, actorUserId, { isEnabled, mode }) => {
  assertRazorpayProvider();
  if (process.env.NODE_ENV !== 'production' && mode !== 'TEST') {
    throw new AppError('Only Razorpay Test mode is permitted outside production', 400, 'PAYMENT_CONFIGURATION_INVALID');
  }
  const result = await pool.query(
    `INSERT INTO INTEGRATION_CONFIGURATIONS
       (id, tenant_id, provider_code, is_enabled, mode, safe_config, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $6)
     ON CONFLICT (tenant_id, provider_code)
     DO UPDATE SET is_enabled = EXCLUDED.is_enabled, mode = EXCLUDED.mode,
                   safe_config = '{}'::jsonb, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING is_enabled, mode`,
    [crypto.randomUUID(), tenantId, RAZORPAY_PROVIDER_CODE, isEnabled, mode, actorUserId]
  );
  return mapRazorpayConfiguration(result.rows[0]);
};
