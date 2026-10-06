const assert = require('node:assert/strict');
const test = require('node:test');

const { updateGoogleConfigurationSchema } = require('../src/modules/integrations/integrationConfig.validator');

const validate = (body) => updateGoogleConfigurationSchema.validate(
  { body, params: {}, query: {} },
  { abortEarly: false, stripUnknown: true, allowUnknown: false }
);

test('Google integration can be enabled only with a valid web client ID', () => {
  const { error } = validate({
    isEnabled: true,
    mode: 'ONE_TAP',
    clientId: '1234567890-example.apps.googleusercontent.com',
  });

  assert.equal(error, undefined);
});

test('Google integration rejects an enabled configuration without a client ID', () => {
  const { error } = validate({ isEnabled: true, mode: 'ONE_TAP' });

  assert.ok(error);
  assert.ok(error.details.some((detail) => detail.path.join('.') === 'body.clientId'));
});

test('Google integration allows disabling without retaining a client ID', () => {
  const { error } = validate({ isEnabled: false, mode: 'ONE_TAP', clientId: null });

  assert.equal(error, undefined);
});

test('Google integration rejects unsupported modes and strips unrecognized settings', () => {
  const { error, value } = validate({
    isEnabled: false,
    mode: 'CUSTOM_SCRIPT',
    clientId: null,
    callbackUrl: 'https://untrusted.example',
  });

  assert.ok(error);
  assert.ok(error.details.some((detail) => detail.path.join('.') === 'body.mode'));
  assert.equal(value.body.callbackUrl, undefined);
});
