const Joi = require('joi');
const { GOOGLE_PROVIDER_MODE, RAZORPAY_PROVIDER_MODES } = require('./providerRegistry');

const emptyRequestSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const googleClientId = Joi.string()
  .trim()
  .max(255)
  .pattern(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/)
  .messages({
    'string.pattern.base': 'Enter a valid Google OAuth web client ID',
  });

const updateGoogleConfigurationSchema = Joi.object({
  body: Joi.object({
    isEnabled: Joi.boolean().required(),
    mode: Joi.string().valid(GOOGLE_PROVIDER_MODE).default(GOOGLE_PROVIDER_MODE),
    clientId: Joi.when('isEnabled', {
      is: true,
      then: googleClientId.required(),
      otherwise: googleClientId.allow('', null).optional(),
    }),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const updateRazorpayConfigurationSchema = Joi.object({
  body: Joi.object({
    isEnabled: Joi.boolean().required(),
    mode: Joi.string().valid(...RAZORPAY_PROVIDER_MODES).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

module.exports = {
  emptyRequestSchema,
  updateGoogleConfigurationSchema,
  updateRazorpayConfigurationSchema,
};
