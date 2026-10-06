const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');

const Logger = require('../src/utils/logger');
const httpLogs = require('../src/services/httpLog.service');
const requestLogger = require('../src/middleware/requestLogger');

test('Razorpay webhook request logs contain only safe metadata after verification', async () => {
  const logged = []; const persisted = [];
  const originalInfo = Logger.info; const originalPersist = httpLogs.persist;
  Logger.info = (_message, context) => logged.push(context);
  httpLogs.persist = async (context) => persisted.push(context);
  try {
    const req = {
      method: 'POST', path: '/webhooks/razorpay', originalUrl: '/webhooks/razorpay',
      baseUrl: '/webhooks/razorpay', route: { path: '/' }, requestId: 'request-1',
      body: Buffer.from('{"email":"customer@example.test","contact":"9999999999"}'),
      get: () => 'test-agent',
    };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.locals = { razorpayWebhookLog: { provider: 'razorpay', eventType: 'payment.captured', eventId: 'evt_12***abcd' } };
    requestLogger(req, res, () => {});
    res.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(logged, [{
      method: 'POST', route: '/webhooks/razorpay/', statusCode: 200,
      durationMs: logged[0].durationMs, requestId: 'request-1', provider: 'razorpay',
      eventType: 'payment.captured', eventId: 'evt_12***abcd',
    }]);
    assert.deepEqual(persisted, logged);
    assert.doesNotMatch(JSON.stringify(logged), /customer@example|9999999999|\"0\":|requestBody|responseBody/);
  } finally {
    Logger.info = originalInfo;
    httpLogs.persist = originalPersist;
  }
});
