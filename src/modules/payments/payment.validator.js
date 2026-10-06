const Joi = require('joi');

const orderReference = Joi.string().trim().max(64).pattern(/^[A-Za-z0-9-]+$/).required();
const razorpayId = Joi.string().trim().max(128).pattern(/^[A-Za-z0-9_]+$/).required();
const signature = Joi.string().trim().length(64).pattern(/^[a-f0-9]+$/i).required();

const createRazorpayOrderSchema = Joi.object({
  body: Joi.object({ orderReference }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const verifyRazorpayPaymentSchema = Joi.object({
  body: Joi.object({
    orderReference,
    razorpayOrderId: razorpayId,
    razorpayPaymentId: razorpayId,
    razorpaySignature: signature,
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const paymentStateSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({ orderReference }).required(),
  query: Joi.object({}).default({}),
});

module.exports = { createRazorpayOrderSchema, verifyRazorpayPaymentSchema, paymentStateSchema };
