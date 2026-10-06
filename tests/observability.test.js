const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('../src/utils/observabilitySanitizer');
const requestId = require('../src/middleware/requestId');
const { createHttpLogService, storageKey } = require('../src/services/httpLog.service');

test('observability sanitizer redacts nested credentials, verification codes, payment signatures, and PII', () => {
  const result = sanitize({ email: 'customer@example.test', nested: { password: 'secret', verificationCode: '123456', razorpay_signature: 'sig' }, entries: [{ phone: '9999999999', accessToken: 'jwt' }] });
  assert.equal(result.email, '[masked]'); assert.equal(result.nested.password, '***'); assert.equal(result.nested.verificationCode, '***');
  assert.equal(result.nested.razorpay_signature, '***'); assert.equal(result.entries[0].phone, '[masked]'); assert.equal(result.entries[0].accessToken, '***');
});

test('request IDs are server generated unless a trusted UUID is supplied and are exposed safely', () => {
  let header; const req = { get: () => 'untrusted-input' }; requestId(req, { setHeader: (_name, value) => { header = value; } }, () => {});
  assert.match(req.requestId, /^[a-f0-9-]{36}$/i); assert.equal(header, req.requestId);
});

test('small logs stay inline and oversized sanitized logs offload to private storage abstraction', async () => {
  const calls = []; const archived = []; const service = createHttpLogService({ database: { query: async (_sql, values) => { calls.push(values); return { rows: [] }; } }, uploadArchive: async (...args) => archived.push(args) });
  await service.persist({ requestId: 'a', method: 'GET', route: '/products', statusCode: 200, durationMs: 1, requestBody: {}, responseBody: { ok: true } });
  assert.equal(calls[0][14], 'INLINE');
  const original = process.env.LOG_INLINE_MAX_BYTES; process.env.LOG_INLINE_MAX_BYTES = '1024';
  try { await service.persist({ requestId: 'b', tenantId: 't1', method: 'GET', route: '/products', statusCode: 200, durationMs: 1, requestBody: {}, responseBody: { value: 'x'.repeat(5000) } }); }
  finally { if (original === undefined) delete process.env.LOG_INLINE_MAX_BYTES; else process.env.LOG_INLINE_MAX_BYTES = original; }
  assert.equal(calls[1][14], 'ARCHIVED'); assert.equal(archived.length, 1); assert.match(archived[0][0], /^system-logs\/t1\//);
});

test('archive object keys omit customer PII and use request IDs', () => {
  assert.equal(storageKey({ tenantId: 't1', requestId: 'request-1', now: new Date('2026-09-27T00:00:00Z') }), 'system-logs/t1/2026/09/27/request-1.json.gz');
});
