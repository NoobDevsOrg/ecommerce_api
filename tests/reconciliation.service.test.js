const assert = require('node:assert/strict');
const test = require('node:test');
const { createReconciliationService } = require('../src/modules/payments/reconciliation.service');

const harness = ({ stockAvailable = true, tenantId = 't1' } = {}) => {
  const state = {
    inventoryCalls: 0, paidCalls: 0, notificationSets: 0, audits: [],
    record: {
      id: 'case-1', tenant_id: tenantId, payment_id: 'payment-1', order_id: 'order-1', order_number: 'SGN-20260927-ORDERONE',
      reason_code: 'INSUFFICIENT_STOCK', reason_message_sanitized: 'We received the payment and need to review this order before fulfillment.',
      status: 'OPEN', payment_status: 'REQUIRES_RECONCILIATION', payment_record_status: 'REQUIRES_RECONCILIATION',
      razorpay_payment_id: 'pay_1', method: 'UPI', resolution_type: null, resolution_note: null, resolved_at: null,
    },
  };
  let tail = Promise.resolve();
  const repository = {
    async withTransaction(work) { const previous = tail; let release; tail = new Promise((resolve) => { release = resolve; }); await previous; try { return await work({}); } finally { release(); } },
    async lockReconciliationByPaymentReference(_client, { tenantId: requestedTenant, paymentReference }) { return requestedTenant === state.record.tenant_id && paymentReference === state.record.payment_id ? { ...state.record } : null; },
    async updateReconciliationCase(_client, update) { Object.assign(state.record, { status: update.status, resolution_type: update.resolutionType || null, resolution_note: update.resolutionNote || null, resolved_by: update.resolvedBy || null, resolved_at: update.status === 'RESOLVED' ? '2026-09-27T10:00:00.000Z' : null }); return { id: state.record.id, status: state.record.status, resolution_type: state.record.resolution_type, resolution_note: state.record.resolution_note, resolved_by: state.record.resolved_by, resolved_at: state.record.resolved_at }; },
    async markPaymentPaid() { state.paidCalls += 1; state.notificationSets += 1; state.record.payment_status = 'PAID'; state.record.payment_record_status = 'PAID'; return { status: 'PAID' }; },
  };
  const inventory = { async applyPaidOrderSale() { state.inventoryCalls += 1; if (!stockAvailable) { const error = new Error('insufficient'); error.errorCode = 'INVENTORY_INSUFFICIENT_STOCK'; throw error; } return ['product-1']; } };
  const auditService = { async write(_client, entry) { state.audits.push(entry); } };
  return { state, service: createReconciliationService({ repository, inventory, auditService }) };
};

test('Admin can start review and safely resolve an insufficient-stock case after restock', async () => {
  const { state, service } = harness();
  const reviewing = await service.startReview({ tenantId: 't1', paymentReference: 'payment-1', actorId: 'staff-1', requestId: 'req-1' });
  assert.equal(reviewing.status, 'IN_REVIEW');
  const resolved = await service.resolve({ tenantId: 't1', paymentReference: 'payment-1', action: 'RESOLVE_AFTER_RESTOCK', actorId: 'staff-1', requestId: 'req-2' });
  assert.equal(resolved.paymentStatus, 'PAID');
  assert.equal(state.inventoryCalls, 1);
  assert.equal(state.paidCalls, 1);
  assert.equal(state.notificationSets, 1);
  assert.deepEqual(state.audits.map((entry) => entry.action), ['RECONCILIATION_REVIEW_STARTED', 'RECONCILIATION_RESOLVED']);
});

test('repeating a successful restock resolution cannot sell inventory or notify twice', async () => {
  const { state, service } = harness();
  await service.resolve({ tenantId: 't1', paymentReference: 'payment-1', action: 'RESOLVE_AFTER_RESTOCK', actorId: 'staff-1' });
  const retry = await service.resolve({ tenantId: 't1', paymentReference: 'payment-1', action: 'RESOLVE_AFTER_RESTOCK', actorId: 'staff-1' });
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(state.inventoryCalls, 1);
  assert.equal(state.paidCalls, 1);
  assert.equal(state.notificationSets, 1);
});

test('manual resolution and escalation cannot bypass trusted inventory/payment invariants', async () => {
  const { state, service } = harness({ stockAvailable: false });
  await assert.rejects(service.resolve({ tenantId: 't1', paymentReference: 'payment-1', action: 'RESOLVE_AFTER_RESTOCK', actorId: 'staff-1' }), (error) => error.errorCode === 'INVENTORY_INSUFFICIENT_STOCK');
  assert.equal(state.record.payment_status, 'REQUIRES_RECONCILIATION');
  const escalated = await service.resolve({ tenantId: 't1', paymentReference: 'payment-1', action: 'ESCALATE', note: 'Awaiting supplier confirmation', actorId: 'staff-1' });
  assert.equal(escalated.status, 'ESCALATED');
  const manual = await service.resolve({ tenantId: 't1', paymentReference: 'payment-1', action: 'MANUAL_RESOLUTION', note: 'Documented for finance review', actorId: 'staff-1' });
  assert.equal(manual.status, 'RESOLVED');
  assert.equal(manual.paymentStatus, 'REQUIRES_RECONCILIATION');
  assert.equal(state.paidCalls, 0);
});

test('reconciliation records remain tenant-scoped', async () => {
  const { service } = harness();
  await assert.rejects(service.startReview({ tenantId: 't2', paymentReference: 'payment-1', actorId: 'staff-2' }), (error) => error.statusCode === 404);
});
