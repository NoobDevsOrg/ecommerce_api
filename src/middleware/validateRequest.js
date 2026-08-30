const Joi = require('joi');
const { ValidationError } = require('../utils/errors');

const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const { value } = schema.validate(
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

      req.body = value.body || {};
      req.params = value.params || {};
      req.query = value.query || {};

      next();
    } catch (error) {
      if (error.isJoi) {
        const details = error.details.map((detail) => ({
          field: detail.path.join('.'),
          message: detail.message,
        }));

        return next(new ValidationError('Validation failed', details));
      }
      next(error);
    }
  };
};

module.exports = validateRequest;
