const { AppError } = require('../utils/errors');

const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 't1';

const parseHostMap = () => {
  const raw = process.env.TENANT_HOST_MAP_JSON;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Tenant host map must be an object');
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([host, tenantId]) => typeof host === 'string' && host && typeof tenantId === 'string' && tenantId)
        .map(([host, tenantId]) => [host.toLowerCase(), tenantId])
    );
  } catch (_error) {
    throw new AppError('Tenant configuration is invalid', 500, 'TENANT_CONFIGURATION_INVALID');
  }
};

// Tenant selection is deployment-controlled. A request can select only a host
// that the deployment has explicitly mapped to a tenant; body/query/header
// tenant identifiers are never considered.
const resolveTenantId = (req) => {
  const hostMap = parseHostMap();
  const configuredHosts = Object.keys(hostMap);
  if (configuredHosts.length === 0) return DEFAULT_TENANT_ID;

  const host = String(req.hostname || req.get?.('host') || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  const tenantId = hostMap[host];
  if (!tenantId) {
    throw new AppError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  }
  return tenantId;
};

const tenantResolver = async (req, res, next) => {
  try {
    if (req.method === 'OPTIONS' || req.path === '/health') {
      return next();
    }

    const tenantId = resolveTenantId(req);
    req.tenant = {
      id: tenantId,
      // The authoritative tenant profile remains in PostgreSQL. Only its safe
      // identifier is needed by request-scoped services.
      name: tenantId === DEFAULT_TENANT_ID ? 'Default Tenant' : undefined,
      slug: tenantId,
    };
    req.tenantId = tenantId;

    next();
  } catch (error) {
    return next(new AppError('Failed to resolve tenant', 500, 'TENANT_RESOLUTION_ERROR'));
  }
};

module.exports = tenantResolver;
module.exports.resolveTenantId = resolveTenantId;
