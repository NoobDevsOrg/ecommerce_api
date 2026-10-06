const Joi = require('joi');

const empty = Joi.object({}).default({});
const productId = Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required();
const pagination = Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(20) }).required();

const listInventorySchema = Joi.object({ body: empty, params: empty, query: pagination.keys({ search: Joi.string().trim().max(100).allow('').default('') }) });
const historySchema = Joi.object({ body: empty, params: Joi.object({ productId }).required(), query: pagination });
const adjustmentSchema = Joi.object({
  params: Joi.object({ productId }).required(), query: empty,
  body: Joi.object({ quantityDelta: Joi.number().integer().min(-1000000).max(1000000).invalid(0).required(), reason: Joi.string().trim().min(2).max(500).required() }).required(),
});
module.exports = { listInventorySchema, historySchema, adjustmentSchema };
