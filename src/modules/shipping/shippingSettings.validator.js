const Joi = require('joi');

const empty = Joi.object({}).default({});
const zoneId = Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required();
const countryCode = Joi.string().trim().uppercase().valid('IN', '*').required();
const mode = Joi.string().valid('FLAT', 'CONTACT_US').required();

const zoneFields = {
  name: Joi.string().trim().min(2).max(100).required(),
  countryCode,
  stateName: Joi.string().trim().max(100).allow('', null).default(null),
  fulfillmentMode: mode,
  flatRatePaise: Joi.alternatives().conditional('fulfillmentMode', {
    is: 'FLAT',
    then: Joi.number().integer().min(0).max(100000000).required(),
    otherwise: Joi.valid(null).default(null),
  }),
  isEnabled: Joi.boolean().default(true),
  priority: Joi.number().integer().min(0).max(1000000).default(100),
};

const createZoneSchema = Joi.object({ params: empty, query: empty, body: Joi.object(zoneFields).required() });
const updateZoneSchema = Joi.object({
  params: Joi.object({ zoneId }).required(), query: empty,
  body: Joi.object({
    name: Joi.string().trim().min(2).max(100), countryCode: Joi.string().trim().uppercase().valid('IN', '*'),
    stateName: Joi.string().trim().max(100).allow('', null), fulfillmentMode: Joi.string().valid('FLAT', 'CONTACT_US'),
    flatRatePaise: Joi.number().integer().min(0).max(100000000).allow(null), isEnabled: Joi.boolean(),
    priority: Joi.number().integer().min(0).max(1000000),
  }).min(1).required(),
});

const policyBody = Joi.object({
  freeShippingEnabled: Joi.boolean().required(),
  freeShippingThresholdPaise: Joi.alternatives().conditional('freeShippingEnabled', {
    is: true, then: Joi.number().integer().min(0).max(100000000).required(), otherwise: Joi.valid(null).default(null),
  }),
  internationalFallbackMode: Joi.string().valid('CONTACT_US').default('CONTACT_US'),
});
const updatePolicySchema = Joi.object({ params: empty, query: empty, body: policyBody.required() });
const emptyRequestSchema = Joi.object({ params: empty, query: empty, body: empty });

module.exports = { createZoneSchema, updateZoneSchema, updatePolicySchema, emptyRequestSchema };
