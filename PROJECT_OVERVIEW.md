# Project Overview

## Purpose
Node.js + Express multi-tenant ecommerce backend using PostgreSQL (Supabase-compatible) with production-focused security, validation, and standardized API responses.

## Tech Stack
- Node.js (>=18)
- Express
- PostgreSQL via pg
- Joi request validation
- JWT auth (access + refresh)
- bcryptjs for password hashing
- multer for product image uploads
- helmet, cors, express-rate-limit, xss input sanitization

## Structure
- src/app.js: Express app bootstrap, middleware wiring, routes, global error handling
- src/server.js: Process startup and shutdown lifecycle
- src/config/db.js: PostgreSQL pool configuration
- src/middleware/: auth, rate limiting, tenant resolver, request validation, sanitization, logging, error handling
- src/modules/auth/: auth routes, controller, service, validator
- src/modules/products/: product routes, controller, service, validator
- src/utils/: shared response formatter, logger, error classes, helpers
- uploads/products/: product image storage

## Run Locally
1. Install dependencies: npm install
2. Set environment variables (see below)
3. Start in development: npm run dev
4. Start in production mode: npm start

## Required Environment Variables
- NODE_ENV
- PORT
- DATABASE_URL
- DB_SSL
- DB_POOL_MAX
- JWT_SECRET
- JWT_EXPIRY
- JWT_REFRESH_SECRET
- JWT_REFRESH_EXPIRY
- CORS_ORIGINS
- RATE_LIMIT_WINDOW_MS
- RATE_LIMIT_MAX
- MAX_FILE_SIZE
- UPLOAD_DIR
- LOG_LEVEL
- PUBLIC_PRODUCT_CACHE_TTL_MS

## Security Notes
- All routes use Joi schema validation at middleware level
- Standardized success and error response envelopes are enforced globally
- Private routes require Bearer access token
- Refresh token rotation is enabled via /auth/refresh
- Errors are normalized and raw internal errors are not exposed in production
