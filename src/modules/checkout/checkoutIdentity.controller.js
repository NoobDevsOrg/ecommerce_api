const checkoutIdentityService = require('./checkoutIdentity.service');
const ResponseFormatter = require('../../utils/response');
const { AuthenticationError } = require('../../utils/errors');

const assertNotStaff = (req) => {
  if (req.user?.staff_user_id) {
    throw new AuthenticationError('Invalid customer identity');
  }
};

const sendFinalization = async (req, res, finalize, message) => {
  assertNotStaff(req);
  const data = await finalize({
    tenantId: req.tenantId,
    resumeToken: req.checkoutResumeToken,
    ...req.body,
  });
  return ResponseFormatter.send(res, { statusCode: 200, message, data });
};

exports.password = async (req, res) => sendFinalization(
  req,
  res,
  checkoutIdentityService.finalizePassword,
  'Identity verified'
);

exports.currentCustomer = async (req, res) => sendFinalization(
  req,
  res,
  () => checkoutIdentityService.finalizeCurrentCustomer({
    tenantId: req.tenantId,
    resumeToken: req.checkoutResumeToken,
    customerId: req.user.customer_id,
  }),
  'Identity verified'
);

exports.register = async (req, res) => sendFinalization(
  req,
  res,
  checkoutIdentityService.finalizeRegistration,
  'Identity verified'
);

exports.google = async (req, res) => sendFinalization(
  req,
  res,
  checkoutIdentityService.finalizeGoogle,
  'Identity verified'
);

exports.sendEmailOtp = async (req, res) => {
  assertNotStaff(req);
  const data = await checkoutIdentityService.requestEmailOtp({
    tenantId: req.tenantId,
    resumeToken: req.checkoutResumeToken,
  });
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Verification code sent', data });
};

exports.verifyEmailOtp = async (req, res) => sendFinalization(
  req,
  res,
  checkoutIdentityService.verifyEmailOtp,
  'Email verified'
);
