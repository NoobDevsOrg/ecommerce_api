const ResponseFormatter = require('../utils/response');
const Logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

const databaseDetails = (error) => (
  process.env.NODE_ENV === 'production' ? undefined : error.detail
);

const mapPostgresError = (error) => {
  if (!error || !error.code) {
    return null;
  }

  if (error.code === '23505') {
    return {
      statusCode: 409,
      message: 'Resource already exists',
      errorCode: 'DB_CONFLICT',
      details: databaseDetails(error),
    };
  }

  if (error.code === '23503') {
    return {
      statusCode: 400,
      message: 'Related resource not found',
      errorCode: 'DB_FOREIGN_KEY_ERROR',
      details: databaseDetails(error),
    };
  }

  if (error.code === '22P02') {
    return {
      statusCode: 400,
      message: 'Invalid request format',
      errorCode: 'DB_INVALID_INPUT',
      details: databaseDetails(error),
    };
  }

  return {
    statusCode: 500,
    message: 'Database operation failed',
    errorCode: 'DB_ERROR',
    details: process.env.NODE_ENV === 'production' ? undefined : error.message,
  };
};

const notFoundHandler = (req, res) => {
  return ResponseFormatter.sendError(res, {
    statusCode: 404,
    message: 'Route not found',
    errorCode: 'ROUTE_NOT_FOUND',
  });
};

const errorHandler = (err, req, res, _next) => {
  const pgError = mapPostgresError(err);

  const isOperationalError = err instanceof AppError;
  const normalized = pgError || {
    statusCode: isOperationalError ? err.statusCode : err.statusCode || 500,
    message: isOperationalError
      ? err.message
      : process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message || 'Internal server error',
    errorCode: isOperationalError ? err.errorCode : err.errorCode || 'INTERNAL_SERVER_ERROR',
    details:
      isOperationalError
        ? err.details
        : process.env.NODE_ENV === 'production'
          ? undefined
          : err.stack,
  };

  Logger.error('Unhandled request error', {
    route: req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched',
    method: req.method,
    statusCode: normalized.statusCode,
    errorCode: normalized.errorCode,
    message: normalized.message,
  });

  res.locals.observabilityErrorCode = normalized.errorCode;

  return ResponseFormatter.sendError(res, normalized);
};

module.exports = {
  errorHandler,
  notFoundHandler,
};
