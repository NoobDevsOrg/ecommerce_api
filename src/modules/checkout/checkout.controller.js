const ResponseFormatter = require('../../utils/response');
const checkoutService = require('./checkout.service');

exports.prepare = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Checkout prepared. Payment is required to complete this order.',
  data: await checkoutService.prepare({
    tenantId: req.tenantId,
    customerId: req.user.customer_id,
    items: req.body.items,
    addressId: req.body.addressId,
    idempotencyKey: req.body.idempotencyKey,
    requestId: req.requestId,
  }),
});
