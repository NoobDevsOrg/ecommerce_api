const nodemailer = require('nodemailer');
const { AppError } = require('./errors');
const Logger = require('./logger');
let transport;
const required = (name) => { const value = process.env[name]; if (!value) throw new AppError('Email verification is temporarily unavailable', 503, 'EMAIL_UNAVAILABLE'); return value; };
const requiredRecipient = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('Email verification is temporarily unavailable', 503, 'EMAIL_UNAVAILABLE');
  }
  return value.trim();
};
const elapsedMs = (startedAt) => Number((performance.now() - startedAt).toFixed(1));
const transporter = () => {
  const startedAt = performance.now();
  const reused = Boolean(transport);
  if (!transport) transport = nodemailer.createTransport({ host: required('SMTP_HOST'), port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE || 'false') === 'true', auth: { user: required('SMTP_USER'), pass: required('SMTP_PASSWORD') } });
  return { transport, reused, availabilityMs: elapsedMs(startedAt) };
};
const smtpFailureDetails = (error) => ({
  category: error?.code || error?.name || 'SMTP_ERROR',
  command: typeof error?.command === 'string' ? error.command.slice(0, 32) : undefined,
  responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
  message: String(error?.message || 'SMTP delivery failed').replace(/[\w.+-]+@[\w.-]+/g, '[redacted-email]').replace(/(password|pass|token|secret)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]').slice(0, 200),
});
const sendMail = async ({ to, ...message } = {}) => {
  // The recipient is deliberately required from the caller. SMTP credentials
  // and the configured sender are authentication/sender settings, never a
  // destination fallback.
  const recipient = requiredRecipient(to);
  const connection = transporter();
  const startedAt = performance.now();
  try {
    return await connection.transport.sendMail({ ...message, from: required('SMTP_FROM'), to: recipient });
  } finally {
    // Timings intentionally contain no recipient, message content, or secrets.
    Logger.info('SMTP delivery timing', {
      transporterAvailabilityMs: connection.availabilityMs,
      transporterReused: connection.reused,
      sendMailMs: elapsedMs(startedAt),
    });
  }
};
const verifyTransport = () => transporter().transport.verify();
module.exports = { sendMail, verifyTransport, smtpFailureDetails };
