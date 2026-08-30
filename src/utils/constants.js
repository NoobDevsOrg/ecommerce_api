/**
 * Application constants and enums
 */

const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

const PRODUCT_STATUS = {
  PUBLISHED: 'published',
  DRAFT: 'draft',
  ARCHIVED: 'archived',
};

const ORDER_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PROCESSING: 'PROCESSING',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
};

const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
};

const PAYMENT_METHOD = {
  UPI: 'UPI',
  CARD: 'CARD',
  NETBANKING: 'NETBANKING',
  COD: 'COD',
};

const ADDRESS_TYPE = {
  HOME: 'HOME',
  WORK: 'WORK',
  OTHER: 'OTHER',
};

const GENDER = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
};

const USER_TYPE = {
  STAFF: 'staff',
  CUSTOMER: 'customer',
};

const COUPON_DISCOUNT_TYPE = {
  FLAT: 'FLAT',
  PERCENT: 'PERCENT',
};

const ERROR_MESSAGES = {
  INVALID_CREDENTIALS: 'Invalid email or password',
  TENANT_NOT_FOUND: 'Tenant not found',
  USER_NOT_FOUND: 'User not found',
  PRODUCT_NOT_FOUND: 'Product not found',
  UNAUTHORIZED: 'Unauthorized',
  UNAUTHORIZED_ACCESS: 'You do not have permission to access this resource',
  INVALID_TOKEN: 'Invalid or expired token',
  MISSING_TOKEN: 'Missing authorization token',
  MISSING_REQUIRED_FIELD: 'Missing required field: ',
  INVALID_EMAIL: 'Invalid email address',
  INVALID_SLUG: 'Invalid slug format',
  INVALID_FILE_TYPE: 'Invalid file type',
  FILE_TOO_LARGE: 'File size exceeds limit',
  DUPLICATE_EMAIL: 'Email already exists for this tenant',
  DUPLICATE_SKU: 'SKU already exists for this tenant',
  DUPLICATE_SLUG: 'Slug already exists for this tenant',
};

const FILE_CONFIG = {
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  MAX_SIZE: 5 * 1024 * 1024, // 5MB
  UPLOAD_DIR: 'uploads/products',
};

module.exports = {
  HTTP_STATUS,
  PRODUCT_STATUS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  ADDRESS_TYPE,
  GENDER,
  USER_TYPE,
  COUPON_DISCOUNT_TYPE,
  ERROR_MESSAGES,
  FILE_CONFIG,
};
