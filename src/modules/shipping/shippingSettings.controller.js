const ResponseFormatter = require('../../utils/response');
const service = require('./shippingSettings.service');

exports.list = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Shipping settings fetched', data: await service.listZones(req.tenantId) });
exports.listZones = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Shipping zones fetched', data: (await service.listZones(req.tenantId)).zones });
exports.createZone = async (req, res) => ResponseFormatter.send(res, { statusCode: 201, message: 'Shipping zone created', data: await service.createZone(req.tenantId, req.user.id, req.body) });
exports.updateZone = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Shipping zone updated', data: await service.updateZone(req.tenantId, req.user.id, req.params.zoneId, req.body) });
exports.updatePolicy = async (req, res) => ResponseFormatter.send(res, { statusCode: 200, message: 'Shipping policy updated', data: await service.updatePolicy(req.tenantId, req.user.id, req.body) });
