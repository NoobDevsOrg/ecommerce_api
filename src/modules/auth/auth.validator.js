const Joi = require('joi');

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

module.exports = {
  loginSchema,
  refreshSchema,
  emptyRequestSchema,
};
