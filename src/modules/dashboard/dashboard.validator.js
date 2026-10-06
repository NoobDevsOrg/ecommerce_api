const Joi = require('joi');

const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : helpers.error('date.format');
}, 'calendar date validation');

const overviewSchema = Joi.object({
  params: Joi.object({}).default({}),
  body: Joi.object({}).default({}),
  query: Joi.object({ from: isoDate.optional(), to: isoDate.optional() }).required(),
});

module.exports = { overviewSchema };
