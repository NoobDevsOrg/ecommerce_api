const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const tenantResolver = require('./middleware/tenantResolver');
const rateLimiter = require('./middleware/rateLimiter');
const sanitizeInput = require('./middleware/sanitizeInput');
const requestLogger = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { AppError } = require('./utils/errors');
const ResponseFormatter = require('./utils/response');

const authRoutes = require('./modules/auth/auth.routes');
const productRoutes = require('./modules/products/product.routes');

const app = express();
app.disable('x-powered-by');

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        return callback(new AppError('CORS origin not allowed', 403, 'CORS_FORBIDDEN_ORIGIN'));
      }
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new AppError('CORS origin not allowed', 403, 'CORS_FORBIDDEN_ORIGIN'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id'],
};

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());
app.use(requestLogger);
app.use(sanitizeInput);
app.use((req, _res, next) => {
  if (req.hasSuspiciousInput) {
    return next(new AppError('Request contains potentially unsafe input', 400, 'SUSPICIOUS_INPUT'));
  }

  return next();
});

app.use(rateLimiter);

app.use(tenantResolver);

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/auth', authRoutes);
app.use('/products', productRoutes);

app.get('/health', (req, res) => {
  return ResponseFormatter.send(
    res,
    {
      statusCode: 200,
      message: 'Server is healthy',
      data: {
        status: 'UP',
        timestamp: new Date().toISOString(),
      },
    }
  );
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
