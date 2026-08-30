const { AppError } = require('../utils/errors');

const tenantResolver = async (req, res, next) => {
  try {
    if (req.method === 'OPTIONS' || req.path === '/health') {
      return next();
    }

    // Keep simple default tenant resolution until a dynamic tenant source is introduced.
    req.tenant = {
      id: 't1',
      name: 'Default Tenant',
      slug: 't1',
    };

    req.tenantId = 't1';

    next();
  } catch (error) {
    return next(new AppError('Failed to resolve tenant', 500, 'TENANT_RESOLUTION_ERROR'));
  }
};

module.exports = tenantResolver;