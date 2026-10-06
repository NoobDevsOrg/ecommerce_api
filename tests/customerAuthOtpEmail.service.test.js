const assert = require('node:assert/strict');
const test = require('node:test');

const smtpPath = require.resolve('../src/utils/smtpTransport');
const emailAdapterPath = require.resolve('../src/modules/auth/customerAuthVerificationEmail.service');
const brevoPath = require.resolve('@getbrevo/brevo');

const withModule = (t, modulePath, exports, load) => {
  const original = require.cache[modulePath];
  delete require.cache[modulePath];
  require.cache[modulePath] = { exports };
  t.after(() => {
    delete require.cache[modulePath];
    if (original) require.cache[modulePath] = original;
  });
  return load();
};

test('customer auth mail adapter sends the exact normalized recipient and raw OTP', async (t) => {
  const sent = [];
  const adapter = withModule(t, smtpPath, { sendMail: async (message) => sent.push(message) }, () => {
    delete require.cache[emailAdapterPath];
    return require('../src/modules/auth/customerAuthVerificationEmail.service');
  });
  t.after(() => delete require.cache[emailAdapterPath]);

  await adapter.sendCustomerAuthOtp({ to: ' Customer@Example.com ', code: '482901', purpose: 'CUSTOMER_LOGIN' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'customer@example.com');
  assert.match(sent[0].text, /482901/);
  assert.doesNotMatch(sent[0].text, /000000/);
});

test('customer auth mail adapter fails closed when the OTP is absent', async (t) => {
  const adapter = withModule(t, smtpPath, { sendMail: async () => assert.fail('mail must not be sent') }, () => {
    delete require.cache[emailAdapterPath];
    return require('../src/modules/auth/customerAuthVerificationEmail.service');
  });
  t.after(() => delete require.cache[emailAdapterPath]);
  assert.throws(() => adapter.sendCustomerAuthOtp({ to: 'customer@example.com', purpose: 'CUSTOMER_LOGIN' }), /temporarily unavailable/);
});

test('shared Brevo transport preserves plain-text and HTML messages without SMTP fallback', async (t) => {
  const originalEnv = Object.fromEntries(['BREVO_API_KEY', 'EMAIL_FROM', 'EMAIL_FROM_NAME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'test-key-not-logged', EMAIL_FROM: 'sender@example.test' });
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const delivered = [];
  const clientOptions = [];
  class BrevoClient {
    constructor(options) {
      clientOptions.push(options);
      this.transactionalEmails = { sendTransacEmail: async (message, options) => delivered.push({ message, options }) };
    }
  }
  const smtp = withModule(t, brevoPath, { BrevoClient }, () => {
    delete require.cache[smtpPath];
    return require('../src/utils/smtpTransport');
  });
  await assert.rejects(smtp.sendMail({ subject: 'No recipient' }), /temporarily unavailable/);
  await smtp.sendMail({ to: 'customer@example.com', subject: 'OTP', text: '482901', html: '<strong>482901</strong>' });
  assert.deepEqual(delivered[0], {
    message: {
      sender: { email: 'sender@example.test', name: 'Sagunthala Dance Jewellers' },
      to: [{ email: 'customer@example.com' }],
      subject: 'OTP',
      textContent: '482901',
      htmlContent: '<strong>482901</strong>',
    },
    options: { timeoutInSeconds: 15, maxRetries: 1 },
  });
  assert.deepEqual(clientOptions, [{ apiKey: 'test-key-not-logged', timeoutInSeconds: 15, maxRetries: 1 }]);
  assert.deepEqual(await smtp.verifyTransport(), { available: true, provider: 'brevo' });
});

test('shared Brevo transport normalizes provider failures to EMAIL_UNAVAILABLE', async (t) => {
  const originalEnv = Object.fromEntries(['BREVO_API_KEY', 'EMAIL_FROM'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'test-key-not-logged', EMAIL_FROM: 'sender@example.test' });
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  class BrevoClient {
    constructor() {
      this.transactionalEmails = {
        sendTransacEmail: async () => {
          const error = new Error('provider response must not escape');
          error.statusCode = 503;
          throw error;
        },
      };
    }
  }
  const smtp = withModule(t, brevoPath, { BrevoClient }, () => {
    delete require.cache[smtpPath];
    return require('../src/utils/smtpTransport');
  });
  await assert.rejects(
    smtp.sendMail({ to: 'customer@example.com', subject: 'OTP', text: '482901' }),
    (error) => error.errorCode === 'EMAIL_UNAVAILABLE' && error.statusCode === 503,
  );
});

test('shared Brevo failure details exclude message bodies and secrets', (t) => {
  const smtp = withModule(t, brevoPath, { BrevoClient: class BrevoClient {} }, () => {
    delete require.cache[smtpPath];
    return require('../src/utils/smtpTransport');
  });
  const error = new Error('customer@example.com OTP 482901 apiKey=private-value');
  error.statusCode = 503;
  assert.deepEqual(smtp.emailFailureDetails(error), {
    provider: 'brevo',
    category: 'DELIVERY_FAILURE',
    statusCode: 503,
  });
});
