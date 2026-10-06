const Joi = require('joi');

const listCustomersSchema = Joi.object({
  params: Joi.object({}).default({}),
  body: Joi.object({}).default({}),
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    search: Joi.string().trim().max(100).allow('').default(''),
    from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).required(),
});

const customerIdSchema = Joi.object({
  params: Joi.object({
    customerId: Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required(),
  }).required(),
  body: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const customerOrdersSchema = Joi.object({
  params: Joi.object({
    customerId: Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required(),
  }).required(),
  body: Joi.object({}).default({}),
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }).required(),
});

module.exports = { listCustomersSchema, customerIdSchema, customerOrdersSchema };
