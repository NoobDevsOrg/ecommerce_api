const Joi = require('joi');

const paginationSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({}).default({}),
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }).required(),
});

const orderIdSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({
    orderId: Joi.string().uuid({ version: ['uuidv4'] }).required(),
  }).required(),
  query: Joi.object({}).default({}),
});

const orderReferenceSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({
    orderReference: Joi.string().trim().min(8).max(128).pattern(/^SGN-[A-Z0-9-]+$/).required(),
  }).required(),
  query: Joi.object({}).default({}),
});

const orderItemReviewParamsSchema = Joi.object({
  body: Joi.object({
    rating: Joi.number().integer().min(1).max(5).required(),
    review: Joi.string().allow('').max(3000),
  }).required(),
  params: Joi.object({
    orderReference: Joi.string().trim().min(8).max(128).pattern(/^SGN-[A-Z0-9-]+$/).required(),
    orderItemId: Joi.string().trim().min(1).max(128).required(),
  }).required(),
  query: Joi.object({}).default({}),
});

module.exports = { paginationSchema, orderIdSchema, orderReferenceSchema, orderItemReviewParamsSchema };
