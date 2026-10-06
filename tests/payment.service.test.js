const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentService } = require('../src/modules/payments/payment.service');
const { createRazorpayOrderSchema, verifyRazorpayPaymentSchema } = require('../src/modules/payments/payment.validator');
const { requireCustomer } = require('../src/modules/payments/payment.routes');

const buildHarness = ({ inventory } = {}) => {
  const state = {
    order: {
      id: 'order-1', tenant_id: 't1', customer_id: 'customer-1', order_number: 'SGN-20260920-ORDERONE',
      status: 'CONFIRMED', payment_status: 'PENDING', total_amount: '125.75', currency: 'INR',
      full_name: 'Test Customer', email: 'customer@example.com', phone: '9876543210',
    },
    payment: null,
    providerCreates: 0, webhookEvents: new Set(), reconciliation: null, attemptEvents: [], paidTransitions: 0, paidNotificationEnqueues: 0,
  };
  let tail = Promise.resolve();
  const repository = {
    async withTransaction(work) {
      let release;
      const mine = new Promise((resolve) => { release = resolve; });
      const previous = tail;
      tail = mine;
      await previous;
      try { return await work({}); } finally { release(); }
    },
    async lockCustomerOrder(_client, tenantId, customerId, reference) {
      if (tenantId !== state.order.tenant_id || customerId !== state.order.customer_id
        || ![state.order.id, state.order.order_number].includes(reference)) return null;
      return { ...state.order };
    },
    async lockPaymentForOrder(_client, tenantId, orderId) {
      return state.payment && tenantId === state.order.tenant_id && orderId === state.order.id ? { ...state.payment } : null;
    },
    async lockPaymentByProviderOrder(_client, providerOrderId) {
      if (!state.payment || state.payment.razorpay_order_id !== providerOrderId) return null;
      return {
        ...state.payment,
        total_amount: state.order.total_amount,
        order_number: state.order.order_number,
        order_status: state.order.status,
        payment_status: state.order.payment_status,
        customer_id: state.order.customer_id,
      };
    },
    async saveProviderOrder(_client, { payment, order, providerOrderId, amount, currency }) {
      state.payment = {
        id: payment?.id || 'payment-1', tenant_id: order.tenant_id, order_id: order.id, gateway: 'RAZORPAY',
        razorpay_order_id: providerOrderId, razorpay_payment_id: null, status: 'CREATED', amount, currency,
      };
      return { ...state.payment };
    },
    async markPaymentPaid(_client, { payment, paymentId, method, providerEventId }) {
      state.paidTransitions += 1;
      state.paidNotificationEnqueues += 1;
      state.payment = { ...payment, razorpay_payment_id: paymentId, status: 'PAID', method, provider_event_id: providerEventId || null };
      state.order.payment_status = 'PAID';
      return { ...state.payment };
    },
    async markPaymentFailed(_client, { payment, paymentId }) {
      state.payment = { ...payment, razorpay_payment_id: paymentId, status: 'FAILED' };
      return { ...state.payment };
    },
    async markPaymentReconciliationRequired(_client, { payment, order, paymentId, reasonCode }) {
      state.payment = { ...payment, razorpay_payment_id: paymentId, status: 'REQUIRES_RECONCILIATION' };
      state.order.payment_status = 'REQUIRES_RECONCILIATION';
      state.reconciliation = { id: 'case-1', created: true, status: 'OPEN', reason_code: reasonCode || 'UNKNOWN' };
      return { ...state.payment, order, reconciliation: state.reconciliation };
    },
    async recordPaymentAttempt(_client, attempt) { state.attemptEvents.push({ ...attempt }); return { id: `attempt-${state.attemptEvents.length}`, ...attempt }; },
    async claimWebhookEvent(_client, { providerEventId }) { if (state.webhookEvents.has(providerEventId)) return false; state.webhookEvents.add(providerEventId); return true; },
    async completeWebhookEvent() {},
  };
  const provider = {
    getPublicKeyId: () => 'rzp_test_public',
    async createOrder({ amountPaise, currency }) {
      state.providerCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: 'order_rzp_1', amount: amountPaise, currency };
    },
    verifyPaymentSignature: ({ signature }) => signature === 'a'.repeat(64),
    async fetchPayment({ paymentId }) {
      return { id: paymentId, order_id: 'order_rzp_1', amount: 12575, currency: 'INR', status: 'captured', method: 'upi' };
    },
    verifyWebhookSignature: ({ signature }) => signature === 'valid-webhook-signature',
  };
  const integrations = {
    getEnabledRazorpayConfiguration: async () => ({ isEnabled: true, mode: 'TEST' }),
    getRazorpayConfiguration: async () => ({ isEnabled: true, mode: 'TEST' }),
  };
  return { state, provider, service: createPaymentService({ repository, provider, integrations, notifications: { dispatchSafely: () => {} }, inventory: inventory || { applyPaidOrderSale: async () => {} }, auditService: { write: async () => ({}) } }) };
};

test('Razorpay order initiation is customer-scoped, authoritative, and concurrent retries reuse one provider order', async () => {
  const { state, service } = buildHarness();
  const request = { tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number };
  const [first, second] = await Promise.all([service.createRazorpayOrder(request), service.createRazorpayOrder(request)]);
  assert.equal(state.providerCreates, 1);
  assert.equal(first.razorpayOrderId, second.razorpayOrderId);
  assert.equal(first.amount, 12575);
  assert.deepEqual(state.attemptEvents, [{
    tenantId: 't1', paymentId: 'payment-1', orderId: 'order-1', eventType: 'PROVIDER_ORDER_ATTACHED',
    outcome: 'SUCCEEDED', providerOrderId: 'order_rzp_1',
  }]);
  await assert.rejects(
    service.createRazorpayOrder({ ...request, customerId: 'customer-2' }),
    (error) => error.statusCode === 404
  );
});

test('callback and webhook reconciliation are idempotent and serialize a single PAID transition', async () => {
  const { state, service } = buildHarness();
  const request = { tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number };
  await service.createRazorpayOrder(request);
  const rawWebhook = Buffer.from(JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_rzp_1', amount: 12575, currency: 'INR', method: 'upi', status: 'captured' } } },
  }));
  const [callback, webhook] = await Promise.all([
    service.verifyRazorpayCallback({ ...request, razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'a'.repeat(64) }),
    service.handleRazorpayWebhook({ rawBody: rawWebhook, signature: 'valid-webhook-signature', eventId: 'event-1' }),
  ]);
  assert.equal(state.order.payment_status, 'PAID');
  assert.equal(state.payment.status, 'PAID');
  assert.equal(state.payment.razorpay_payment_id, 'pay_1');
  assert.equal(state.paidTransitions, 1);
  assert.equal(state.paidNotificationEnqueues, 1);
  assert.equal([callback.paymentStatus, webhook.paymentStatus].every((value) => value === 'PAID'), true);

  const retry = await service.verifyRazorpayCallback({ ...request, razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'a'.repeat(64) });
  assert.equal(retry.alreadyProcessed, true);
});

test('the trusted PAID transition invokes inventory exactly once across callback, webhook, and replay', async () => {
  const calls = [];
  const { state, service } = buildHarness({ inventory: { applyPaidOrderSale: async (_client, input) => { calls.push(input); } } });
  const request = { tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number };
  await service.createRazorpayOrder(request);
  const webhook = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_rzp_1', amount: 12575, currency: 'INR', method: 'upi', status: 'captured' } } } }));
  await Promise.all([
    service.verifyRazorpayCallback({ ...request, razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'a'.repeat(64) }),
    service.handleRazorpayWebhook({ rawBody: webhook, signature: 'valid-webhook-signature', eventId: 'evt-1' }),
  ]);
  await service.handleRazorpayWebhook({ rawBody: webhook, signature: 'valid-webhook-signature', eventId: 'evt-1' });
  assert.deepEqual(calls, [{ tenantId: 't1', orderId: 'order-1' }]);
  assert.equal(state.attemptEvents.filter((event) => event.eventType === 'PAYMENT_CAPTURED').length, 1);
});

test('a captured payment with insufficient stock is marked for reconciliation without a false PAID transition', async () => {
  const { AppError } = require('../src/utils/errors');
  const { state, service } = buildHarness({ inventory: { applyPaidOrderSale: async () => { throw new AppError('Inventory is insufficient for this paid order', 409, 'INVENTORY_INSUFFICIENT_STOCK'); } } });
  const request = { tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number };
  await service.createRazorpayOrder(request);
  const result = await service.verifyRazorpayCallback({ ...request, razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'a'.repeat(64) });
  assert.equal(result.paymentStatus, 'REQUIRES_RECONCILIATION');
  assert.equal(state.order.payment_status, 'REQUIRES_RECONCILIATION');
  assert.equal(state.payment.status, 'REQUIRES_RECONCILIATION');
  assert.equal(state.reconciliation.reason_code, 'INSUFFICIENT_STOCK');
});

test('invalid callback or webhook signatures leave the trusted order pending', async () => {
  const { state, service } = buildHarness();
  const request = { tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number };
  await service.createRazorpayOrder(request);
  await assert.rejects(
    service.verifyRazorpayCallback({ ...request, razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'b'.repeat(64) }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    service.handleRazorpayWebhook({ rawBody: Buffer.from('{}'), signature: 'invalid', eventId: 'event-1' }),
    (error) => error.errorCode === 'PAYMENT_WEBHOOK_SIGNATURE_INVALID'
  );
  await assert.rejects(
    service.handleRazorpayWebhook({ rawBody: Buffer.from('{}'), signature: undefined, eventId: 'event-2' }),
    (error) => error.errorCode === 'PAYMENT_WEBHOOK_SIGNATURE_INVALID'
  );
  assert.equal(state.order.payment_status, 'PENDING');
});

test('payment request schemas strip browser-controlled money fields and customer middleware rejects staff identities', () => {
  const initiated = createRazorpayOrderSchema.validate({
    body: { orderReference: 'SGN-20260920-ORDERONE', amount: 1, currency: 'USD', customerId: 'other-customer' }, params: {}, query: {},
  }, { stripUnknown: true, allowUnknown: false });
  assert.equal(initiated.error, undefined);
  assert.deepEqual(initiated.value.body, { orderReference: 'SGN-20260920-ORDERONE' });
  assert.ok(verifyRazorpayPaymentSchema.validate({
    body: { orderReference: 'bad ref', razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'a'.repeat(64) }, params: {}, query: {},
  }).error);
  let rejection;
  requireCustomer({ user: { staff_user_id: 'staff-1', customer_id: null } }, {}, (error) => { rejection = error; });
  assert.equal(rejection.statusCode, 403);
});

test('a captured response with an incorrect provider amount cannot mark the order paid', async () => {
  const { state, provider, service } = buildHarness();
  await service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number });
  provider.fetchPayment = async ({ paymentId }) => ({
    id: paymentId, order_id: 'order_rzp_1', amount: 1, currency: 'INR', status: 'captured', method: 'upi',
  });
  await assert.rejects(
    service.verifyRazorpayCallback({
      tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number,
      razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'a'.repeat(64),
    }),
    (error) => error.statusCode === 400
  );
  assert.equal(state.order.payment_status, 'PENDING');
});

test('a provider lookup timeout records an unknown attempt without changing a pending payment or asking for another payment', async () => {
  const { state, provider, service } = buildHarness();
  const request = { tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number };
  await service.createRazorpayOrder(request);
  const error = Object.assign(new Error('timeout'), { errorCode: 'PAYMENT_PROVIDER_ERROR' });
  provider.fetchPayment = async () => { throw error; };
  await assert.rejects(
    service.verifyRazorpayCallback({ ...request, razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_timeout', razorpaySignature: 'a'.repeat(64) }),
    (received) => received === error,
  );
  assert.equal(state.order.payment_status, 'PENDING');
  assert.equal(state.payment.status, 'CREATED');
  assert.deepEqual(state.attemptEvents.at(-1), {
    tenantId: 't1', paymentId: 'payment-1', orderId: 'order-1', eventType: 'VERIFY_PROVIDER_LOOKUP_FAILED',
    outcome: 'UNKNOWN', providerOrderId: 'order_rzp_1', providerPaymentId: 'pay_timeout', requestId: null,
  });
});

const capturedWebhook = ({ event = 'payment.captured', id = 'pay_1', orderId = 'order_rzp_1', amount = 12575, currency = 'INR', status = 'captured' } = {}) => Buffer.from(JSON.stringify({
  event,
  payload: { payment: { entity: { id, order_id: orderId, amount, currency, method: 'upi', status } } },
}));

test('captured webhook settlement requires an explicitly captured payment entity', async () => {
  const { state, service } = buildHarness();
  await service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number });
  const result = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ status: 'authorized' }), signature: 'valid-webhook-signature', eventId: 'event-not-captured' });
  assert.deepEqual(result, {
    processed: false, ignored: true,
    webhookLog: { provider: 'razorpay', eventType: 'payment.captured', eventId: null },
  });
  assert.equal(state.order.payment_status, 'PENDING');
  assert.equal(state.payment.status, 'CREATED');
});

test('order.paid requires the captured payment evidence and settles when it is present', async () => {
  const { state, service } = buildHarness();
  await service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number });
  const ignored = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ event: 'order.paid', status: 'authorized' }), signature: 'valid-webhook-signature', eventId: 'event-order-pending' });
  assert.equal(ignored.ignored, true);
  const settled = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ event: 'order.paid' }), signature: 'valid-webhook-signature', eventId: 'event-order-captured' });
  assert.equal(settled.paymentStatus, 'PAID');
  assert.equal(state.order.payment_status, 'PAID');
});

test('payment.failed records an unpaid attempt without inventory or PAID state', async () => {
  const inventoryCalls = [];
  const { state, service } = buildHarness({ inventory: { applyPaidOrderSale: async (...args) => inventoryCalls.push(args) } });
  await service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number });
  const result = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ event: 'payment.failed', status: 'failed' }), signature: 'valid-webhook-signature', eventId: 'event-failed' });
  assert.equal(result.failed, true);
  assert.equal(state.payment.status, 'FAILED');
  assert.equal(state.order.payment_status, 'PENDING');
  assert.equal(inventoryCalls.length, 0);
  assert.equal(state.attemptEvents.at(-1).eventType, 'PAYMENT_FAILED');
});

test('late failed or mismatched webhooks never downgrade a PAID payment', async () => {
  const { state, service } = buildHarness();
  await service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: state.order.order_number });
  await service.handleRazorpayWebhook({ rawBody: capturedWebhook(), signature: 'valid-webhook-signature', eventId: 'event-paid' });
  const failed = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ event: 'payment.failed', id: 'pay_late', status: 'failed', amount: 1 }), signature: 'valid-webhook-signature', eventId: 'event-late-failed' });
  const currencyMismatch = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ id: 'pay_late_2', currency: 'USD' }), signature: 'valid-webhook-signature', eventId: 'event-late-currency' });
  assert.equal(failed.paymentStatus, 'PAID');
  assert.equal(currencyMismatch.paymentStatus, 'PAID');
  assert.equal(state.payment.status, 'PAID');
  assert.equal(state.order.payment_status, 'PAID');
});

test('unknown provider orders are acknowledged without attaching a payment', async () => {
  const { state, service } = buildHarness();
  const result = await service.handleRazorpayWebhook({ rawBody: capturedWebhook({ orderId: 'order_unknown' }), signature: 'valid-webhook-signature', eventId: 'event-unknown-order' });
  assert.equal(result.ignored, true);
  assert.equal(state.payment, null);
  assert.equal(state.order.payment_status, 'PENDING');
});

test('amount and currency mismatches open reconciliation with their actual reason codes', async () => {
  const amount = buildHarness();
  await amount.service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: amount.state.order.order_number });
  await amount.service.handleRazorpayWebhook({ rawBody: capturedWebhook({ amount: 1 }), signature: 'valid-webhook-signature', eventId: 'event-amount-mismatch' });
  assert.equal(amount.state.payment.status, 'REQUIRES_RECONCILIATION');
  assert.equal(amount.state.reconciliation.reason_code, 'AMOUNT_MISMATCH');

  const currency = buildHarness();
  await currency.service.createRazorpayOrder({ tenantId: 't1', customerId: 'customer-1', orderReference: currency.state.order.order_number });
  await currency.service.handleRazorpayWebhook({ rawBody: capturedWebhook({ currency: 'USD' }), signature: 'valid-webhook-signature', eventId: 'event-currency-mismatch' });
  assert.equal(currency.state.payment.status, 'REQUIRES_RECONCILIATION');
  assert.equal(currency.state.reconciliation.reason_code, 'CURRENCY_MISMATCH');
});
