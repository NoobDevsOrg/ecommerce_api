const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

const provider = require('../src/modules/payments/providers/razorpay.provider');

test('webhook verification requires the dedicated webhook secret and never uses the API key secret', () => {
  const previousWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const previousKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const payload = Buffer.from('{"event":"payment.captured"}');

  try {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'df29da831c8c7e65d86668b54e65f0be3d92edf0e5b956efd1a5d75da82599a9';
    process.env.RAZORPAY_KEY_SECRET = 'qduLJO4v8KT31ggLS2Svej48';
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(payload).digest('hex');

    assert.equal(provider.verifyWebhookSignature({ rawBody: payload, signature }), true);
    assert.equal(provider.verifyWebhookSignature({ rawBody: payload, signature: '0'.repeat(64) }), false);
    assert.equal(provider.verifyWebhookSignature({ rawBody: payload, signature: undefined }), false);

    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.throws(
      () => provider.verifyWebhookSignature({ rawBody: payload, signature }),
      (error) => error?.errorCode === 'PAYMENT_CONFIGURATION_MISSING'
    );
  } finally {
    if (previousWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = previousWebhookSecret;
    if (previousKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = previousKeySecret;
  }
});
