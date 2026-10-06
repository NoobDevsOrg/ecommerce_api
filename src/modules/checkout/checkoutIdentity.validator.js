const Joi = require('joi');
const { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = require('../auth/passwordPolicy');

const requestShell = (body) => Joi.object({
  body,
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

const checkoutPasswordSchema = requestShell(Joi.object({
  password: Joi.string().min(1).max(PASSWORD_MAX_LENGTH).required(),
}).required());

const checkoutRegistrationSchema = requestShell(Joi.object({
  password: customerPassword.required(),
  confirmPassword: Joi.string().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords do not match',
  }),
}).required());

const checkoutGoogleSchema = requestShell(Joi.object({
  idToken: Joi.string().trim().max(4096).required(),
}).required());

const checkoutOtpVerifySchema = requestShell(Joi.object({
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Enter the six-digit verification code',
  }),
}).required());

module.exports = {
  checkoutPasswordSchema,
  checkoutRegistrationSchema,
  checkoutGoogleSchema,
  checkoutOtpVerifySchema,
};
