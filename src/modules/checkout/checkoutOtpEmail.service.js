const { sendMail } = require('../../utils/smtpTransport');

const sendCheckoutOtp = async ({ to, code }) => sendMail({
  to,
  subject: 'Your Sagunthala checkout verification code',
  text: `Your verification code is ${code}. It expires in 10 minutes. Do not share this code.`,
});

module.exports = { sendCheckoutOtp };
