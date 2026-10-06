const Joi = require('joi');
const { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = require('./passwordPolicy');

const loginSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).max(128).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const refreshSchema = Joi.object({
  body: Joi.object({
    refreshToken: Joi.string().required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const emptyRequestSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const customerPassword = Joi.string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .pattern(/[a-z]/)
  .pattern(/[A-Z]/)
  .pattern(/\d/)
  .messages({
    'string.pattern.base': 'Password must include uppercase, lowercase, and a number',
  });

const registerSchema = Joi.object({
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(120).required(),
    email: Joi.string().trim().email().max(254).required(),
    password: customerPassword.required(),
    confirmPassword: Joi.string().valid(Joi.ref('password')).required().messages({
      'any.only': 'Passwords do not match',
    }),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const customerLoginSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().trim().email().max(254).required(),
    password: Joi.string().min(1).max(PASSWORD_MAX_LENGTH).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const googleSchema = Joi.object({
  body: Joi.object({
    idToken: Joi.string().trim().max(4096).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const updateCustomerProfileSchema = Joi.object({
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(120).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});
const customerOtpSendSchema = Joi.object({ body: Joi.object({ email: Joi.string().trim().email().max(254).required() }).required(), params: Joi.object({}).default({}), query: Joi.object({}).default({}) });
const customerOtpVerifySchema = Joi.object({ body: Joi.object({ email: Joi.string().trim().email().max(254).required(), code: Joi.string().pattern(/^\d{6}$/).required() }).required(), params: Joi.object({}).default({}), query: Joi.object({}).default({}) });
const passwordForgotSchema = customerOtpSendSchema;
const passwordResetSchema = Joi.object({ body: Joi.object({ email: Joi.string().trim().email().max(254).required(), code: Joi.string().pattern(/^\d{6}$/).required(), newPassword: customerPassword.required(), confirmPassword: Joi.string().valid(Joi.ref('newPassword')).required().messages({ 'any.only': 'Passwords do not match' }) }).required(), params: Joi.object({}).default({}), query: Joi.object({}).default({}) });

module.exports = {
  loginSchema,
  refreshSchema,
  emptyRequestSchema,
  registerSchema,
  customerLoginSchema,
  googleSchema,
  updateCustomerProfileSchema,
  customerOtpSendSchema,
  customerOtpVerifySchema,
  passwordForgotSchema,
  passwordResetSchema,
};
