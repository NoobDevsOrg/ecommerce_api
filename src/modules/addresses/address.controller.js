const addressService = require('./address.service');
const ResponseFormatter = require('../../utils/response');

const customerId = (req) => req.user.customer_id;

exports.list = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Addresses fetched successfully',
  data: await addressService.list(req.tenantId, customerId(req)),
});

exports.create = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 201,
  message: 'Address added successfully',
  data: await addressService.create(req.tenantId, customerId(req), req.body),
});

exports.update = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Address updated successfully',
  data: await addressService.update(req.tenantId, customerId(req), req.params.id, req.body),
});

exports.remove = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Address removed successfully',
  data: await addressService.remove(req.tenantId, customerId(req), req.params.id),
});

exports.setDefault = async (req, res) => ResponseFormatter.send(res, {
  statusCode: 200,
  message: 'Default address updated successfully',
  data: await addressService.setDefault(req.tenantId, customerId(req), req.params.id),
});
