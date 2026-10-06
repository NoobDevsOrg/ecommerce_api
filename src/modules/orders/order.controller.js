const ResponseFormatter = require('../../utils/response');
const orderService = require('./order.service');

exports.list = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Orders fetched successfully',
  data: await orderService.list(req.tenantId, req.user.customer_id, req.query),
});

exports.getById = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Order fetched successfully',
  data: await orderService.getById(req.tenantId, req.user.customer_id, req.params.orderId),
});

exports.getByReference = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Order fetched successfully',
  data: await orderService.getByReference(req.tenantId, req.user.customer_id, req.params.orderReference),
});

exports.getRelatedProducts = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Related products fetched successfully',
  data: await orderService.getRelatedProducts(req.tenantId, req.user.customer_id, req.params.orderReference),
});

exports.getReviewItems = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Review items fetched successfully',
  data: await orderService.getReviewItems(req.tenantId, req.user.customer_id, req.params.orderReference),
});

exports.submitItemReview = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 201,
  message: 'Review submitted',
  data: await orderService.submitItemReview({
    tenantId: req.tenantId,
    customerId: req.user.customer_id,
    orderReference: req.params.orderReference,
    orderItemId: req.params.orderItemId,
    rating: req.body.rating,
    review: req.body.review,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }),
});
