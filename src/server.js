require('dotenv').config();
const app = require('./app');
const Logger = require('./utils/logger');

const PORT = process.env.PORT || 5000;

const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
  Logger.error('Missing required environment variables', {
    missing: missingEnvVars,
  });
  process.exit(1);
}

const server = app.listen(PORT, () => {
  Logger.info(`✓ Server running on port ${PORT}`);
  Logger.info(` Environment: ${process.env.NODE_ENV || 'development'}`);
  Logger.info('✓ Ready to accept requests');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  Logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    Logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  Logger.info('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    Logger.info('Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  Logger.error('Uncaught Exception', {
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    promise: String(promise),
  });
  process.exit(1);
});

module.exports = server;
