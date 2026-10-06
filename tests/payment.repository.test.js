const assert = require('node:assert/strict');
const test = require('node:test');

const repository = require('../src/modules/payments/payment.repository');

const payment = { id: 'payment-1', tenant_id: 'tenant-1', status: 'CREATED' };
const order = { id: 'order-1', tenant_id: 'tenant-1' };

test('repository refuses to reconcile a terminal PAID or reconciliation-required payment', async () => {
  let queryCount = 0;
  const client = { query: async () => { queryCount += 1; return { rows: [] }; } };
  for (const status of ['PAID', 'REQUIRES_RECONCILIATION']) {
    const result = await repository.markPaymentReconciliationRequired(client, {
      payment: { ...payment, status }, order, paymentId: 'pay_provider', actorId: 'system', reasonCode: 'AMOUNT_MISMATCH',
    });
    assert.equal(result.status, status);
    assert.equal(result.alreadyTerminal, true);
  }
  assert.equal(queryCount, 0);
});

test('repository stores the actual reconciliation reason code rather than an inventory message', async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('UPDATE PAYMENTS')) return { rows: [{ id: payment.id, razorpay_payment_id: 'pay_provider', status: 'REQUIRES_RECONCILIATION' }] };
      if (sql.includes('UPDATE ORDERS')) return { rows: [] };
      if (sql.includes('INSERT INTO PAYMENT_RECONCILIATIONS')) return { rows: [{ id: 'case-1', status: 'OPEN', reason_code: 'CURRENCY_MISMATCH', created: true }] };
      if (sql.includes('FROM ORDERS o JOIN CUSTOMERS')) return { rows: [] };
      if (sql.includes('INSERT INTO NOTIFICATIONS')) return { rows: [] };
      if (sql.includes('SELECT s.id')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await repository.markPaymentReconciliationRequired(client, {
    payment, order, paymentId: 'pay_provider', actorId: 'system', reasonCode: 'CURRENCY_MISMATCH',
  });
  const paymentUpdate = calls.find(({ sql }) => sql.includes('UPDATE PAYMENTS'));
  assert.ok(paymentUpdate);
  assert.ok(paymentUpdate.values.includes('CURRENCY_MISMATCH'));
  assert.equal(result.status, 'REQUIRES_RECONCILIATION');
});
