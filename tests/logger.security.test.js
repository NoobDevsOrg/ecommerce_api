const assert = require('node:assert/strict');
const test = require('node:test');

const Logger = require('../src/utils/logger');

test('logger masks customer authentication token and secret variants', () => {
  const masked = Logger.maskSensitive({
    password: 'password',
    refreshToken: 'refresh-token',
    idToken: 'google-id-token',
    clientSecret: 'client-secret',
    nested: { database_url: 'database-url' },
  });

  assert.deepEqual(masked, {
    password: '***',
    refreshToken: '***',
    idToken: '***',
    clientSecret: '***',
    nested: { database_url: '***' },
  });
});

test('logger never serializes Buffer-like request or response bodies', () => {
  const rawPayload = Buffer.from('{"email":"customer@example.test","contact":"9999999999"}');
  const masked = Logger.maskSensitive({ requestBody: rawPayload, responseBody: rawPayload, rawBody: rawPayload });
  assert.deepEqual(masked, { requestBody: '***', responseBody: '***', rawBody: '***' });
  assert.doesNotMatch(JSON.stringify(masked), /customer@example|9999999999|\"0\":/);

  assert.equal(Logger.maskSensitive(rawPayload), '[omitted binary payload]');
  assert.equal(Logger.maskSensitive({ type: 'Buffer', data: [...rawPayload] }), '[omitted binary payload]');
});
