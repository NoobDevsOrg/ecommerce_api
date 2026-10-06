const Joi = require('joi');
const empty = Joi.object({}).unknown(false);
const pagination = Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(20) }).required();
const id = Joi.object({ id: Joi.string().trim().max(128).required() }).required();
module.exports = { listSchema: Joi.object({ body: empty, params: empty, query: pagination }), idSchema: Joi.object({ body: empty, params: id, query: empty }), emptySchema: Joi.object({ body: empty, params: empty, query: empty }) };
