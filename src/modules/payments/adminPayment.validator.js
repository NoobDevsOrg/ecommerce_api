const Joi = require('joi');

const empty = Joi.object({}).default({});
const query = Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(20), search: Joi.string().trim().max(100).allow('').default(''), status: Joi.string().valid('CREATED', 'PAID', 'FAILED', 'REFUNDED', 'REQUIRES_RECONCILIATION').optional(), from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(), to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional() }).required();
const paymentReference = Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required();
const params = Joi.object({ paymentReference }).required();
const resolution = Joi.object({ action: Joi.string().valid('RESOLVE_AFTER_RESTOCK', 'MANUAL_RESOLUTION', 'ESCALATE').required(), note: Joi.string().trim().max(500).allow('', null) }).required();

module.exports = {
  listPaymentsSchema: Joi.object({ params: empty, body: empty, query }),
  reportPaymentsSchema: Joi.object({ params: empty, body: empty, query }),
  paymentReferenceSchema: Joi.object({ params, body: empty, query: empty }),
  startReviewSchema: Joi.object({ params, body: empty, query: empty }),
  resolveReconciliationSchema: Joi.object({ params, body: resolution, query: empty }),
};
