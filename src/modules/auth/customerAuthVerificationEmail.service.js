const { sendMail } = require('../../utils/smtpTransport');
const { AppError } = require('../../utils/errors');
const { normalizeEmail } = require('./identity');
const label = (purpose) => purpose === 'PASSWORD_RESET' ? 'password reset' : 'sign-in';
const sendCustomerAuthOtp = ({ to, code, purpose } = {}) => {
  // A missing code must be an operational failure, never a template fallback.
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new AppError('Email verification is temporarily unavailable', 503, 'CUSTOMER_AUTH_OTP_UNAVAILABLE');
  }
  const recipient = normalizeEmail(to);
  if (!recipient) {
    throw new AppError('Email verification is temporarily unavailable', 503, 'CUSTOMER_AUTH_OTP_UNAVAILABLE');
  }
  return sendMail({ to: recipient, subject: `Your Sagunthala ${label(purpose)} code`, text: `Your ${label(purpose)} verification code is ${code}. It expires in 10 minutes. Do not share this code.` });
};
module.exports = { sendCustomerAuthOtp };
