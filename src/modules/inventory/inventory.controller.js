const ResponseFormatter = require('../../utils/response');
const inventory = require('./inventory.service');

exports.list = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Inventory fetched successfully', data: await inventory.list(req.tenantId, req.query) });
exports.history = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Inventory history fetched successfully', data: await inventory.history(req.tenantId, req.params.productId, req.query) });
exports.adjust = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Inventory adjusted successfully', data: await inventory.adjust({ tenantId: req.tenantId, productId: req.params.productId, quantityDelta: req.body.quantityDelta, reason: req.body.reason, actorType: req.user.role_code, actorId: req.user.id, requestId: req.requestId, ipAddress: req.ip, userAgent: req.get('user-agent') }) });
