const Joi = require('joi');
const { ValidationError } = require('../utils/errors');

const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const { error, value } = schema.validate(
        {
          body: req.body,
          params: req.params,
          query: req.query,
        },
        {
          abortEarly: false,
          stripUnknown: true,
          allowUnknown: false,
        }
      );

      if (error) {
        const details = error.details.map((detail) => ({
          field: detail.path.join('.'),
          message: detail.message,
        }));
        return next(new ValidationError('Validation failed', details));
      }

      req.body = value.body || {};
      req.params = value.params || {};
      req.query = value.query || {};

      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = validateRequest;
