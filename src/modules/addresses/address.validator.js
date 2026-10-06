const Joi = require('joi');

const optionalText = (max) => Joi.string().trim().max(max).allow('', null).optional();

const normalizedCountry = (helpers) => String(helpers.state.ancestors[0]?.country || 'IN').trim().toUpperCase();
const phone = Joi.string().trim().custom((value, helpers) => {
  const compact = String(value).replace(/[\s()-]/g, '');
  const country = normalizedCountry(helpers);
  if (country === 'IN') {
    const local = compact.replace(/^\+91/, '').replace(/^91(?=[6-9]\d{9}$)/, '');
    if (!/^[6-9]\d{9}$/.test(local)) return helpers.error('phone.india');
  } else if (!/^\+?\d{8,15}$/.test(compact)) {
    return helpers.error('phone.international');
  }
  return value;
}).messages({
  'phone.india': 'Enter a valid 10-digit Indian mobile number',
  'phone.international': 'Enter a valid international phone number',
});

const pincode = Joi.string().trim().custom((value, helpers) => {
  const country = normalizedCountry(helpers);
  if (country === 'IN' && !/^[1-9][0-9]{5}$/.test(value)) return helpers.error('pincode.india');
  if (country !== 'IN' && !/^[A-Za-z0-9][A-Za-z0-9 -]{1,14}[A-Za-z0-9]$/.test(value)) return helpers.error('pincode.international');
  return value;
}).messages({
  'pincode.india': 'Enter a valid six-digit PIN code',
  'pincode.international': 'Enter a valid postal code',
});

const addressFields = {
  fullName: Joi.string().trim().min(2).max(120).required(),
  phone: phone.required(),
  addressLine1: Joi.string().trim().min(3).max(200).required(),
  addressLine2: optionalText(200),
  landmark: optionalText(120),
  city: Joi.string().trim().min(2).max(100).required(),
  state: Joi.string().trim().min(2).max(100).required(),
  pincode: pincode.required(),
  country: Joi.string().trim().uppercase().length(2).default('IN'),
};

const addressId = Joi.string().uuid({ version: ['uuidv4'] }).required();

const emptyRequestSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const createAddressSchema = Joi.object({
  body: Joi.object({
    ...addressFields,
    isDefault: Joi.boolean().default(false),
  }).required(),
  params: Joi.object({}).default({}),
  query: Joi.object({}).default({}),
});

const updateAddressSchema = Joi.object({
  body: Joi.object(addressFields).required(),
  params: Joi.object({ id: addressId }).required(),
  query: Joi.object({}).default({}),
});

const addressIdSchema = Joi.object({
  body: Joi.object({}).default({}),
  params: Joi.object({ id: addressId }).required(),
  query: Joi.object({}).default({}),
});

module.exports = {
  addressFields,
  emptyRequestSchema,
  createAddressSchema,
  updateAddressSchema,
  addressIdSchema,
};
