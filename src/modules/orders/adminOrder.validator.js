const Joi = require('joi');

const orderReference = Joi.string().trim().min(8).max(128).pattern(/^SGN-[A-Z0-9-]+$/).required();
const empty = Joi.object({}).default({});
const listAdminOrdersSchema = Joi.object({
  body: empty, params: empty,
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
    search: Joi.string().trim().max(100).allow('').default(''), status: Joi.string().valid('CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED').optional(),
    paymentStatus: Joi.string().valid('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'REQUIRES_RECONCILIATION').optional(),
    from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(), to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).required(),
});
const referenceSchema = Joi.object({ body: empty, query: empty, params: Joi.object({ orderReference }).required() });
const transitionSchema = Joi.object({
  params: Joi.object({ orderReference }).required(), query: empty,
  body: Joi.object({
    toStatus: Joi.string().valid('PROCESSING', 'SHIPPED', 'DELIVERED').required(),
    courierName: Joi.string().trim().max(120).allow('', null), trackingNumber: Joi.string().trim().max(160).allow('', null),
    trackingUrl: Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(1000).allow('', null),
    dispatchedAt: Joi.date().iso().optional(), expectedDeliveryDate: Joi.date().iso().optional(),
  }).required(),
});
module.exports = { listAdminOrdersSchema, referenceSchema, transitionSchema };
