const ResponseFormatter = require('../../utils/response');
const service = require('./customerDirectory.service');
const { csv } = require('../../utils/adminList');

exports.list = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Customers fetched successfully',
  data: await service.list(req.tenantId, req.query),
});

exports.getById = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Customer fetched successfully',
  data: await service.getById(req.tenantId, req.params.customerId),
});

exports.listOrders = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Customer orders fetched successfully',
  data: await service.listOrders(req.tenantId, req.params.customerId, req.query),
});
exports.report = async (req, res) => { const data = await service.list(req.tenantId, { ...req.query, page: 1, limit: 5000 }); const columns = [{ label: 'Customer Name', value: (c) => c.fullName }, { label: 'Email', value: (c) => c.email }, { label: 'Phone', value: (c) => c.phone }, { label: 'Order Count', value: (c) => c.orderCount }, { label: 'Total Paid Order Value', value: (c) => c.totalPaidOrderValue }, { label: 'Created At', value: (c) => c.createdAt }]; res.set('Content-Type', 'text/csv; charset=utf-8'); res.attachment('customers-report.csv'); return res.send(csv(columns, data.customers)); };
