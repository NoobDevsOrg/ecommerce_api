const ResponseFormatter = require('../../utils/response');
const dashboard = require('./dashboard.service');

exports.overview = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Dashboard overview fetched successfully',
  data: await dashboard.overview(req.tenantId, req.query),
});
