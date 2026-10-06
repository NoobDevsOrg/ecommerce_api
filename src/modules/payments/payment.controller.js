const ResponseFormatter = require('../../utils/response');
const paymentService = require('./payment.service');

exports.createRazorpayOrder = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Payment session created',
  data: await paymentService.createRazorpayOrder({
    tenantId: req.tenantId, customerId: req.user.customer_id, orderReference: req.body.orderReference,
  }),
});

exports.verifyRazorpayPayment = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Payment verification completed',
  data: await paymentService.verifyRazorpayCallback({
    tenantId: req.tenantId,
    customerId: req.user.customer_id,
    requestId: req.requestId,
    ...req.body,
  }),
});

exports.getCustomerPaymentState = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Payment status fetched',
  data: await paymentService.getCustomerPaymentState({
    tenantId: req.tenantId, customerId: req.user.customer_id, orderReference: req.params.orderReference,
  }),
});

exports.handleRazorpayWebhook = async (req, res) => {
  const result = await paymentService.handleRazorpayWebhook({
    rawBody: req.body,
    signature: req.get('x-razorpay-signature'),
    eventId: req.get('x-razorpay-event-id') || null,
    requestId: req.requestId,
  });
  const { webhookLog, ...data } = result;
  if (webhookLog) res.locals.razorpayWebhookLog = webhookLog;
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Webhook received',
    data,
  });
};
