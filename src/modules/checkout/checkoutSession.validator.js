const Joi = require('joi');
const { addressFields } = require('../addresses/address.validator');
const { MAX_CART_ITEM_QUANTITY, MAX_CART_ITEMS } = require('../cart/cart.validator');

const productId = Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required();
const checkoutItems = Joi.array().items(Joi.object({
  productId,
  quantity: Joi.number().integer().min(1).max(MAX_CART_ITEM_QUANTITY).required(),
}).required()).min(1).max(MAX_CART_ITEMS).unique('productId');

const contactPhone = Joi.string().trim().pattern(/^\+?[0-9][0-9\s-]{8,14}$/).messages({
  'string.pattern.base': 'Enter a valid phone number',
});

const startCheckoutSessionSchema = Joi.object({
  body: Joi.object({
    items: checkoutItems.required(),
    idempotencyKey: Joi.string().trim().min(16).max(128).pattern(/^[A-Za-z0-9_-]+$/).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const updateCheckoutSessionSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().trim().email().max(254),
    fullName: Joi.string().trim().min(2).max(120),
    phone: contactPhone,
    address: Joi.object(addressFields),
    items: checkoutItems,
  }).or('email', 'fullName', 'phone', 'address', 'items').required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const emptyCheckoutSessionSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

module.exports = {
  startCheckoutSessionSchema,
  updateCheckoutSessionSchema,
  emptyCheckoutSessionSchema,
};
