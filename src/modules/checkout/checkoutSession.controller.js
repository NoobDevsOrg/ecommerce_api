const checkoutSessionService = require('./checkoutSession.service');
const ResponseFormatter = require('../../utils/response');

const customerIdFromRequest = (req) => (
  req.user?.customer_id && !req.user?.staff_user_id ? req.user.customer_id : null
);

exports.start = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 201,
  message: 'Checkout session started',
  data: await checkoutSessionService.start({
    tenantId: req.tenantId,
    customerId: customerIdFromRequest(req),
    items: req.body.items,
    idempotencyKey: req.body.idempotencyKey,
  }),
});

exports.resume = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Checkout session resumed',
  data: await checkoutSessionService.resume({
    tenantId: req.tenantId,
    resumeToken: req.checkoutResumeToken,
  }),
});

exports.updateDraft = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Checkout session updated',
  data: await checkoutSessionService.updateDraft({
    tenantId: req.tenantId,
    resumeToken: req.checkoutResumeToken,
    input: req.body,
  }),
});
