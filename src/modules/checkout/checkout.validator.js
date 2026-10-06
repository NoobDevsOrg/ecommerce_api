const Joi = require('joi');
const { MAX_CART_ITEMS, MAX_CART_ITEM_QUANTITY } = require('../cart/cart.validator');

const productId = Joi.string().trim().min(1).max(128).pattern(/^[A-Za-z0-9_-]+$/).required();

const prepareCheckoutSchema = Joi.object({
  body: Joi.object({
    items: Joi.array().items(Joi.object({
      productId,
      quantity: Joi.number().integer().min(1).max(MAX_CART_ITEM_QUANTITY).required(),
    }).required()).min(1).max(MAX_CART_ITEMS).unique('productId').required(),
    addressId: Joi.string().uuid({ version: ['uuidv4'] }).required(),
    idempotencyKey: Joi.string().trim().min(8).max(128).pattern(/^[A-Za-z0-9_-]+$/).required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

module.exports = { prepareCheckoutSchema };
