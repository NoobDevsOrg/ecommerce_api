const ResponseFormatter = require('../../utils/response');
const audit = require('../../services/audit.service');
const httpLogs = require('../../services/httpLog.service');
const { NotFoundError } = require('../../utils/errors');

exports.listAudit = async (req, res) => ResponseFormatter.send(res, { message: 'Audit events fetched successfully', data: await audit.list(req.tenantId, req.query) });
exports.getAudit = async (req, res) => {
  const event = await audit.get(req.tenantId, req.params.id); if (!event) throw new NotFoundError('Audit event');
  return ResponseFormatter.send(res, { message: 'Audit event fetched successfully', data: event });
};
exports.listSystem = async (req, res) => ResponseFormatter.send(res, { message: 'System logs fetched successfully', data: await httpLogs.list(req.tenantId, req.query) });
