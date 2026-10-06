const assert = require('node:assert/strict');
const test = require('node:test');

const smtpPath = require.resolve('../src/utils/smtpTransport');
const emailAdapterPath = require.resolve('../src/modules/auth/customerAuthVerificationEmail.service');
const nodemailerPath = require.resolve('nodemailer');

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

test('shared SMTP transport never derives a recipient from SMTP_FROM or SMTP_USER', async (t) => {
  const originalEnv = Object.fromEntries(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'host@example.test', SMTP_PASSWORD: 'not-logged', SMTP_FROM: 'sender@example.test' });
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const delivered = [];
  const smtp = withModule(t, nodemailerPath, { createTransport: () => ({ sendMail: async (message) => delivered.push(message), verify: async () => true }) }, () => {
    delete require.cache[smtpPath];
    return require('../src/utils/smtpTransport');
  });
  await assert.rejects(smtp.sendMail({ subject: 'No recipient' }), /temporarily unavailable/);
  await smtp.sendMail({ to: 'customer@example.com', subject: 'OTP', text: '482901' });
  assert.deepEqual(delivered[0], { from: 'sender@example.test', to: 'customer@example.com', subject: 'OTP', text: '482901' });
});
