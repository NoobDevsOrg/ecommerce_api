const { ConflictError, NotFoundError, ValidationError } = require('../../utils/errors');
const paymentRepository = require('./payment.repository');
const inventoryService = require('../inventory/inventory.service');
const audit = require('../../services/audit.service');

const ACTIONS = Object.freeze({
  RESOLVE_AFTER_RESTOCK: 'RESOLVE_AFTER_RESTOCK',
  MANUAL_RESOLUTION: 'MANUAL_RESOLUTION',
  ESCALATE: 'ESCALATE',
});

const present = (row, { alreadyProcessed = false } = {}) => ({
  id: row.id,
  paymentReference: row.payment_id,
  orderReference: row.order_number,
  status: row.status,
  reasonCode: row.reason_code,
  reasonMessage: row.reason_message_sanitized,
  resolutionType: row.resolution_type || null,
  resolutionNote: row.resolution_note || null,
  resolvedAt: row.resolved_at || null,
  paymentStatus: row.payment_status,
  alreadyProcessed,
});

const requireNote = (action, note) => {
  const value = typeof note === 'string' ? note.trim() : '';
  if ((action === ACTIONS.MANUAL_RESOLUTION || action === ACTIONS.ESCALATE) && value.length < 2) {
    throw new ValidationError('A resolution note is required');
  }
  if (value.length > 500) throw new ValidationError('Resolution note is too long');
  return value || null;
};

const assertOpenPayment = (record) => {
  if (!record) throw new NotFoundError('Payment reconciliation');
  if (record.payment_status !== 'REQUIRES_RECONCILIATION' || record.payment_record_status !== 'REQUIRES_RECONCILIATION') {
    throw new ConflictError('This payment is not awaiting reconciliation');
  }
};

const createReconciliationService = ({ repository = paymentRepository, inventory = inventoryService, auditService = audit } = {}) => {
  const startReview = async ({ tenantId, paymentReference, actorId, requestId = null, ipAddress = null, userAgent = null }) => repository.withTransaction(async (client) => {
    const record = await repository.lockReconciliationByPaymentReference(client, { tenantId, paymentReference });
    assertOpenPayment(record);
    if (record.status === 'IN_REVIEW') return present(record, { alreadyProcessed: true });
    if (record.status !== 'OPEN' && record.status !== 'ESCALATED') throw new ConflictError('This reconciliation case is already resolved');
    const updated = await repository.updateReconciliationCase(client, {
      reconciliationId: record.id, tenantId, status: 'IN_REVIEW', resolvedBy: null,
    });
    await auditService.write(client, {
      tenantId, entityType: 'PAYMENT_RECONCILIATION', entityId: record.id, action: 'RECONCILIATION_REVIEW_STARTED',
      actorType: 'STAFF', actorId, beforeSnapshot: { status: record.status }, afterSnapshot: { status: updated.status },
      changedFields: ['status'], requestId, ipAddress, userAgent,
    });
    return present({ ...record, ...updated });
  });

  const resolve = async ({ tenantId, paymentReference, action, note, actorId, requestId = null, ipAddress = null, userAgent = null }) => {
    if (!Object.values(ACTIONS).includes(action)) throw new ValidationError('Reconciliation action is invalid');
    const resolutionNote = requireNote(action, note);
    return repository.withTransaction(async (client) => {
      const record = await repository.lockReconciliationByPaymentReference(client, { tenantId, paymentReference });
      if (!record) throw new NotFoundError('Payment reconciliation');
      if (record.status === 'RESOLVED') return present(record, { alreadyProcessed: true });
      assertOpenPayment(record);

      if (action === ACTIONS.ESCALATE) {
        const updated = await repository.updateReconciliationCase(client, {
          reconciliationId: record.id, tenantId, status: 'ESCALATED', resolutionType: action, resolutionNote, resolvedBy: null,
        });
        await auditService.write(client, {
          tenantId, entityType: 'PAYMENT_RECONCILIATION', entityId: record.id, action: 'RECONCILIATION_ESCALATED',
          actorType: 'STAFF', actorId, beforeSnapshot: { status: record.status }, afterSnapshot: { status: updated.status, resolutionNote },
          changedFields: ['status', 'resolutionNote'], requestId, ipAddress, userAgent,
        });
        return present({ ...record, ...updated });
      }

      if (action === ACTIONS.MANUAL_RESOLUTION) {
        // Recording an operational conclusion is not proof that the captured
        // money and inventory invariants are satisfied. Keep the order blocked.
        const updated = await repository.updateReconciliationCase(client, {
          reconciliationId: record.id, tenantId, status: 'RESOLVED', resolutionType: action, resolutionNote, resolvedBy: actorId,
        });
        await auditService.write(client, {
          tenantId, entityType: 'PAYMENT_RECONCILIATION', entityId: record.id, action: 'RECONCILIATION_RESOLVED',
          actorType: 'STAFF', actorId, beforeSnapshot: { status: record.status, paymentStatus: record.payment_status },
          afterSnapshot: { status: updated.status, paymentStatus: record.payment_status, resolutionType: action, resolutionNote },
          changedFields: ['status', 'resolutionType', 'resolutionNote'], requestId, ipAddress, userAgent,
        });
        return present({ ...record, ...updated });
      }

      if (record.reason_code !== 'INSUFFICIENT_STOCK') {
        throw new ConflictError('Only stock-related cases can be resolved after restock');
      }
      if (!record.razorpay_payment_id) throw new ConflictError('The trusted payment reference is unavailable');

      const inventoryProductIds = await inventory.applyPaidOrderSale(client, { tenantId, orderId: record.order_id, requestId });
      const paid = await repository.markPaymentPaid(client, {
        payment: { id: record.payment_id, tenant_id: tenantId },
        order: { id: record.order_id, tenant_id: tenantId },
        paymentId: record.razorpay_payment_id, method: record.method || null, actorId,
      });
      const updated = await repository.updateReconciliationCase(client, {
        reconciliationId: record.id, tenantId, status: 'RESOLVED', resolutionType: action, resolutionNote, resolvedBy: actorId,
      });
      await auditService.write(client, {
        tenantId, entityType: 'PAYMENT_RECONCILIATION', entityId: record.id, action: 'RECONCILIATION_RESOLVED',
        actorType: 'STAFF', actorId, beforeSnapshot: { status: record.status, paymentStatus: record.payment_status },
        afterSnapshot: { status: updated.status, paymentStatus: paid.status, resolutionType: action },
        changedFields: ['status', 'paymentStatus', 'resolutionType'], requestId, ipAddress, userAgent,
      });
      return { ...present({ ...record, ...updated, payment_status: paid.status }), inventoryProductIds, orderId: record.order_id };
    });
  };

  return { startReview, resolve };
};

module.exports = { ...createReconciliationService(), createReconciliationService, ACTIONS };
