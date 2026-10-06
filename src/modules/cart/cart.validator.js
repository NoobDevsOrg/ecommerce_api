const Joi = require('joi');

// This is deliberately an application policy, rather than a UI-only limit.
// Checkout can reuse the same bound until a business-specific limit is agreed.
const MAX_CART_ITEM_QUANTITY = 10;
const MAX_CART_ITEMS = 100;

const productId = Joi.string()
  .trim()
  .min(1)
  .max(128)
  .pattern(/^[A-Za-z0-9_-]+$/)
  .required();

const validateCartSchema = Joi.object({
  body: Joi.object({
    items: Joi.array()
      .items(Joi.object({
        productId,
        quantity: Joi.number().integer().min(1).max(MAX_CART_ITEM_QUANTITY).required(),
      }).required())
      .min(1)
      .max(MAX_CART_ITEMS)
      .unique('productId')
      .required(),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

module.exports = {
  validateCartSchema,
  MAX_CART_ITEM_QUANTITY,
  MAX_CART_ITEMS,
};
