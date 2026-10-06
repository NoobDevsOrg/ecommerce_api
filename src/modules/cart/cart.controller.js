const ResponseFormatter = require('../../utils/response');
const cartService = require('./cart.service');

exports.validate = async (req, res) => {
  const data = await cartService.validateItems(req.tenantId, req.body.items);
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Cart validated successfully',
    data,
  });
};
