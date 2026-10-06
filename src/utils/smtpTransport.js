const { BrevoClient } = require('@getbrevo/brevo');
const { AppError } = require('./errors');
const Logger = require('./logger');

const BREVO_TIMEOUT_SECONDS = 15;
const BREVO_MAX_RETRIES = 1;
const DEFAULT_SENDER_NAME = 'Sagunthala Dance Jewellers';
let client;

const unavailable = () => new AppError('Email verification is temporarily unavailable', 503, 'EMAIL_UNAVAILABLE');
const required = (name) => {
  const value = process.env[name];
  if (!value) throw unavailable();
  return value;
};
const requiredRecipient = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw unavailable();
  return value.trim();
};
const elapsedMs = (startedAt) => Number((performance.now() - startedAt).toFixed(1));

const brevoClient = () => {
  const startedAt = performance.now();
  const reused = Boolean(client);
  if (!client) {
    client = new BrevoClient({
      apiKey: required('BREVO_API_KEY'),
      timeoutInSeconds: BREVO_TIMEOUT_SECONDS,
      maxRetries: BREVO_MAX_RETRIES,
    });
  }
  return { client, reused, availabilityMs: elapsedMs(startedAt) };
};

const sender = () => ({
  email: required('EMAIL_FROM'),
  name: process.env.EMAIL_FROM_NAME || DEFAULT_SENDER_NAME,
});

const replyTo = (value) => {
  if (typeof value === 'string' && value.trim()) return { email: value.trim() };
  if (value && typeof value === 'object') {
    const email = value.email || value.address;
    if (typeof email === 'string' && email.trim()) {
      return value.name ? { email: email.trim(), name: String(value.name) } : { email: email.trim() };
    }
  }
  return undefined;
};

const recipientList = (value) => {
  const entries = Array.isArray(value) ? value : [value];
  const recipients = entries
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((email) => ({ email: email.trim() }));
  return recipients.length ? recipients : undefined;
};

const toBrevoMessage = ({ to, subject, text, html, replyTo: replyToValue, cc, bcc } = {}) => ({
  sender: sender(),
  to: [{ email: requiredRecipient(to) }],
  ...(typeof subject === 'string' ? { subject } : {}),
  ...(typeof text === 'string' ? { textContent: text } : {}),
  ...(typeof html === 'string' ? { htmlContent: html } : {}),
  ...(replyTo(replyToValue) ? { replyTo: replyTo(replyToValue) } : {}),
  ...(recipientList(cc) ? { cc: recipientList(cc) } : {}),
  ...(recipientList(bcc) ? { bcc: recipientList(bcc) } : {}),
});

// Deliberately exclude provider message/body/headers: they can contain a
// recipient, OTP, rendered HTML, API credentials, or other sensitive data.
const emailFailureDetails = (error) => ({
  provider: 'brevo',
  category: error?.name === 'BrevoTimeoutError' ? 'TIMEOUT' : 'DELIVERY_FAILURE',
  statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : undefined,
});

const sendMail = async ({ to, ...message } = {}) => {
  const connection = brevoClient();
  const startedAt = performance.now();
  try {
    return await connection.client.transactionalEmails.sendTransacEmail(
      toBrevoMessage({ to, ...message }),
      { timeoutInSeconds: BREVO_TIMEOUT_SECONDS, maxRetries: BREVO_MAX_RETRIES },
    );
  } catch (error) {
    Logger.warn('Transactional email delivery failed', emailFailureDetails(error));
    throw unavailable();
  } finally {
    // Timings intentionally contain no recipient, message content, or secrets.
    Logger.info('Transactional email delivery timing', {
      provider: 'brevo',
      clientAvailabilityMs: connection.availabilityMs,
      clientReused: connection.reused,
      sendMailMs: elapsedMs(startedAt),
    });
  }
};

// Brevo is an HTTPS API rather than a persistent SMTP connection. Validate the
// runtime configuration without an outbound probe or a test email.
const verifyTransport = async () => {
  brevoClient();
  sender();
  return { available: true, provider: 'brevo' };
};

module.exports = {
  sendMail,
  verifyTransport,
  emailFailureDetails,
  // Keep this export as a compatibility alias for callers not yet renamed.
  smtpFailureDetails: emailFailureDetails,
};
