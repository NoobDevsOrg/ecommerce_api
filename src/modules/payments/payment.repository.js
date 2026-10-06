const crypto = require('crypto');
const pool = require('../../config/db');
const notifications = require('../orders/orderNotification.service');

const claimWebhookEvent = async (client, event) => {
  const result = await client.query(
    `INSERT INTO PAYMENT_WEBHOOK_EVENTS (id, provider, provider_event_id, event_type, provider_payment_id, provider_order_id, request_id)
     VALUES ($1, 'RAZORPAY', $2, $3, $4, $5, $6)
     ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), event.providerEventId, event.eventType, event.paymentId || null, event.orderId || null, event.requestId || null]
  );
  return Boolean(result.rows[0]);
};

const completeWebhookEvent = (client, { providerEventId, paymentId = null, orderId = null, ignored = false }) => client.query(
  `UPDATE PAYMENT_WEBHOOK_EVENTS SET payment_id = $2, order_id = $3, processing_status = $4, processed_at = now()
   WHERE provider = 'RAZORPAY' AND provider_event_id = $1`,
  [providerEventId, paymentId, orderId, ignored ? 'IGNORED' : 'PROCESSED']
);

const withTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const lockCustomerOrder = async (client, tenantId, customerId, orderReference) => {
  const result = await client.query(
    `SELECT o.id, o.tenant_id, o.customer_id, o.order_number, o.status, o.payment_status,
            o.total_amount, o.currency, c.full_name, c.email, c.phone
     FROM ORDERS o
     JOIN CUSTOMERS c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
     WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.is_deleted = false
       AND (o.id = $3 OR o.order_number = $3)
     FOR UPDATE OF o`,
    [tenantId, customerId, orderReference]
  );
  return result.rows[0] || null;
};

// Settlement always locks business rows in this order: ORDER, PAYMENT, then
// PAYMENT_RECONCILIATION (when one exists).  Do not replace these explicit
// locks with a joined FOR UPDATE query: PostgreSQL is free to choose a join
// execution order, which makes cross-path lock acquisition non-obvious.
const lockOrderById = async (client, tenantId, orderId) => {
  const result = await client.query(
    `SELECT id, tenant_id, customer_id, order_number, status, payment_status,
            total_amount, currency
     FROM ORDERS
     WHERE tenant_id = $1 AND id = $2 AND is_deleted = false
     FOR UPDATE`,
    [tenantId, orderId]
  );
  return result.rows[0] || null;
};

const lockPaymentForOrder = async (client, tenantId, orderId) => {
  const result = await client.query(
    `SELECT id, tenant_id, order_id, gateway, razorpay_order_id, razorpay_payment_id,
            method, status, amount, currency, verified_at, provider_event_id
     FROM PAYMENTS
     WHERE tenant_id = $1 AND order_id = $2 AND gateway = 'RAZORPAY' AND is_deleted = false
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [tenantId, orderId]
  );
  return result.rows[0] || null;
};

const lockPaymentById = async (client, tenantId, paymentId) => {
  const result = await client.query(
    `SELECT id, tenant_id, order_id, gateway, razorpay_order_id, razorpay_payment_id,
            method, status, amount, currency, verified_at, provider_event_id
     FROM PAYMENTS
     WHERE tenant_id = $1 AND id = $2 AND gateway = 'RAZORPAY' AND is_deleted = false
     FOR UPDATE`,
    [tenantId, paymentId]
  );
  return result.rows[0] || null;
};

const paymentByProviderOrder = async (client, providerOrderId) => {
  const result = await client.query(
    `SELECT id, tenant_id, order_id, razorpay_order_id
     FROM PAYMENTS
     WHERE razorpay_order_id = $1 AND gateway = 'RAZORPAY' AND is_deleted = false`,
    [providerOrderId]
  );
  return result.rows[0] || null;
};

const paymentWithOrder = async (client, { paymentId, tenantId, providerOrderId }) => {
  const result = await client.query(
    `SELECT p.id, p.tenant_id, p.order_id, p.gateway, p.razorpay_order_id, p.razorpay_payment_id,
            p.method, p.status AS payment_record_status, p.amount, p.currency, p.verified_at,
            p.provider_event_id, o.order_number, o.status AS order_status, o.payment_status,
            o.total_amount, o.customer_id
     FROM PAYMENTS p
     JOIN ORDERS o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE p.id = $1 AND p.tenant_id = $2 AND p.razorpay_order_id = $3
       AND p.gateway = 'RAZORPAY' AND p.is_deleted = false
       AND o.is_deleted = false
    `,
    [paymentId, tenantId, providerOrderId]
  );
  return result.rows[0] || null;
};

const lockPaymentByProviderOrder = async (client, providerOrderId) => {
  const candidate = await paymentByProviderOrder(client, providerOrderId);
  if (!candidate) return null;
  const order = await lockOrderById(client, candidate.tenant_id, candidate.order_id);
  if (!order) return null;
  const payment = await lockPaymentById(client, candidate.tenant_id, candidate.id);
  if (!payment || payment.order_id !== order.id || payment.razorpay_order_id !== providerOrderId) return null;
  return paymentWithOrder(client, { paymentId: payment.id, tenantId: payment.tenant_id, providerOrderId });
};

const saveProviderOrder = async (client, { payment, order, providerOrderId, amount, currency, actorId }) => {
  if (payment) {
    const result = await client.query(
      `UPDATE PAYMENTS
       SET razorpay_order_id = $1, amount = $2, currency = $3, status = 'CREATED',
           failure_reason = NULL, updated_at = now(), updated_by = $4
       WHERE id = $5 AND tenant_id = $6
       RETURNING id, razorpay_order_id, amount, currency, status`,
      [providerOrderId, amount, currency, actorId, payment.id, order.tenant_id]
    );
    return result.rows[0];
  }
  const result = await client.query(
    `INSERT INTO PAYMENTS
       (id, tenant_id, order_id, gateway, razorpay_order_id, status, amount, currency, created_by, updated_by)
     VALUES ($1, $2, $3, 'RAZORPAY', $4, 'CREATED', $5, $6, $7, $7)
     RETURNING id, razorpay_order_id, amount, currency, status`,
    [crypto.randomUUID(), order.tenant_id, order.id, providerOrderId, amount, currency, actorId]
  );
  return result.rows[0];
};

const markPaymentPaid = async (client, { payment, order, paymentId, method, providerEventId, actorId }) => {
  const result = await client.query(
    `UPDATE PAYMENTS
     SET razorpay_payment_id = $1, method = $2, status = 'PAID', paid_at = COALESCE(paid_at, now()),
         verified_at = COALESCE(verified_at, now()), provider_event_id = COALESCE($3, provider_event_id),
         failure_reason = NULL, updated_at = now(), updated_by = $4
     WHERE id = $5 AND tenant_id = $6
     RETURNING id, razorpay_payment_id, status, paid_at, verified_at`,
    [paymentId, method, providerEventId || null, actorId, payment.id, order.tenant_id]
  );
  await client.query(
    `UPDATE ORDERS
     SET payment_status = 'PAID', payment_method = COALESCE($1, payment_method), updated_at = now(), updated_by = $2
     WHERE id = $3 AND tenant_id = $4`,
    [method, actorId, order.id, order.tenant_id]
  );
  await notifications.enqueueInTransaction(client, {
    tenantId: order.tenant_id,
    orderId: order.id,
    eventType: 'PAYMENT_CONFIRMED',
  });
  return result.rows[0];
};

const recordPaymentAttempt = async (client, {
  tenantId, paymentId, orderId, eventType, outcome, providerOrderId = null,
  providerPaymentId = null, requestId = null,
}) => {
  const result = await client.query(
    `INSERT INTO PAYMENT_ATTEMPT_EVENTS
       (id, tenant_id, payment_id, order_id, event_type, outcome, provider_order_id, provider_payment_id, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, event_type, outcome, created_at`,
    [crypto.randomUUID(), tenantId, paymentId, orderId, eventType, outcome, providerOrderId, providerPaymentId, requestId]
  );
  return result.rows[0];
};

const markPaymentFailed = async (client, { payment, paymentId, providerEventId, actorId }) => {
  if (!payment || ['PAID', 'REQUIRES_RECONCILIATION'].includes(payment.payment_record_status || payment.status)) return payment;
  const result = await client.query(
    `UPDATE PAYMENTS
     SET razorpay_payment_id = COALESCE(razorpay_payment_id, $1), status = 'FAILED',
         provider_event_id = COALESCE($2, provider_event_id), updated_at = now(), updated_by = $3
     WHERE id = $4 AND tenant_id = $5
     RETURNING id, razorpay_payment_id, status`,
    [paymentId || null, providerEventId || null, actorId, payment.id, payment.tenant_id]
  );
  return result.rows[0];
};

const markPaymentReconciliationRequired = async (client, { payment, order, paymentId, providerEventId, actorId, reasonCode, reasonMessage }) => {
  const originalStatus = payment?.payment_record_status || payment?.status;
  if (['PAID', 'REQUIRES_RECONCILIATION'].includes(originalStatus)) {
    return { ...payment, status: originalStatus, payment_record_status: originalStatus, reconciliation: null, alreadyTerminal: true };
  }
  const normalizedReasonCode = ['INSUFFICIENT_STOCK', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'PROVIDER_MAPPING_MISMATCH', 'UNKNOWN'].includes(reasonCode)
    ? reasonCode
    : 'UNKNOWN';
  const result = await client.query(
    `UPDATE PAYMENTS
     SET razorpay_payment_id = COALESCE(razorpay_payment_id, $1), status = 'REQUIRES_RECONCILIATION',
         provider_event_id = COALESCE($2, provider_event_id), failure_reason = $3,
         updated_at = now(), updated_by = $4
     WHERE id = $5 AND tenant_id = $6 AND status NOT IN ('PAID', 'REQUIRES_RECONCILIATION')
     RETURNING id, razorpay_payment_id, status`,
    [paymentId || null, providerEventId || null, normalizedReasonCode, actorId, payment.id, order.tenant_id]
  );
  if (!result.rows[0]) {
    const current = await client.query(
      `SELECT status FROM PAYMENTS WHERE id = $1 AND tenant_id = $2`,
      [payment.id, order.tenant_id]
    );
    const status = current.rows[0]?.status || originalStatus;
    return { ...payment, status, payment_record_status: status, reconciliation: null, alreadyTerminal: true };
  }
  await client.query(
    `UPDATE ORDERS SET payment_status = 'REQUIRES_RECONCILIATION', updated_at = now(), updated_by = $1
     WHERE id = $2 AND tenant_id = $3`,
    [actorId, order.id, order.tenant_id]
  );
  const reconciliation = await openReconciliationCase(client, {
    tenantId: order.tenant_id,
    paymentId: payment.id,
    orderId: order.id,
    reasonCode: normalizedReasonCode,
    reasonMessage,
  });
  await notifications.enqueueInTransaction(client, {
    tenantId: order.tenant_id, orderId: order.id, eventType: 'PAYMENT_REQUIRES_RECONCILIATION', paymentReference: payment.razorpay_payment_id || payment.id,
  });
  return { ...result.rows[0], reconciliation };
};

const reconciliationReasonMessages = Object.freeze({
  INSUFFICIENT_STOCK: 'We received the payment and need to review this order before fulfillment.',
  AMOUNT_MISMATCH: 'We received the payment and need to review this order before fulfillment.',
  CURRENCY_MISMATCH: 'We received the payment and need to review this order before fulfillment.',
  PROVIDER_MAPPING_MISMATCH: 'We received the payment and need to review this order before fulfillment.',
  UNKNOWN: 'We received the payment and need to review this order before fulfillment.',
});

const openReconciliationCase = async (client, { tenantId, paymentId, orderId, reasonCode = 'UNKNOWN', reasonMessage }) => {
  const code = reconciliationReasonMessages[reasonCode] ? reasonCode : 'UNKNOWN';
  const message = reconciliationReasonMessages[code] || reasonMessage || reconciliationReasonMessages.UNKNOWN;
  const inserted = await client.query(
    `INSERT INTO PAYMENT_RECONCILIATIONS
       (id, tenant_id, payment_id, order_id, reason_code, reason_message_sanitized)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (payment_id) DO NOTHING
     RETURNING id, status, reason_code, reason_message_sanitized, created_at`,
    [crypto.randomUUID(), tenantId, paymentId, orderId, code, message]
  );
  if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
  const existing = await client.query(
    `SELECT id, status, reason_code, reason_message_sanitized, created_at
     FROM PAYMENT_RECONCILIATIONS WHERE tenant_id = $1 AND payment_id = $2`,
    [tenantId, paymentId]
  );
  return existing.rows[0] ? { ...existing.rows[0], created: false } : null;
};

const lockReconciliationByPaymentReference = async (client, { tenantId, paymentReference }) => {
  const candidateResult = await client.query(
    `SELECT id, payment_id, order_id
     FROM PAYMENT_RECONCILIATIONS
     WHERE tenant_id = $1 AND payment_id = $2`,
    [tenantId, paymentReference]
  );
  const candidate = candidateResult.rows[0];
  if (!candidate) return null;
  const order = await lockOrderById(client, tenantId, candidate.order_id);
  if (!order) return null;
  const payment = await lockPaymentById(client, tenantId, candidate.payment_id);
  if (!payment || payment.order_id !== order.id) return null;
  const reconciliation = await client.query(
    `SELECT id FROM PAYMENT_RECONCILIATIONS WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, candidate.id]
  );
  if (!reconciliation.rows[0]) return null;
  const result = await client.query(
    `SELECT r.id,r.tenant_id,r.payment_id,r.order_id,r.reason_code,r.reason_message_sanitized,r.status,
            r.resolution_type,r.resolution_note,r.resolved_by,r.resolved_at,r.created_at,r.updated_at,
            p.status AS payment_record_status,p.razorpay_payment_id,p.method,p.amount,p.currency,
            o.order_number,o.payment_status
     FROM PAYMENT_RECONCILIATIONS r
     JOIN PAYMENTS p ON p.id=r.payment_id AND p.tenant_id=r.tenant_id AND p.is_deleted=false
     JOIN ORDERS o ON o.id=r.order_id AND o.tenant_id=r.tenant_id AND o.is_deleted=false
     WHERE r.tenant_id=$1 AND r.id=$2`,
    [tenantId, candidate.id]
  );
  return result.rows[0] || null;
};

const updateReconciliationCase = async (client, { reconciliationId, tenantId, status, resolutionType = null, resolutionNote = null, resolvedBy = null }) => {
  const result = await client.query(
    `UPDATE PAYMENT_RECONCILIATIONS
     SET status=$3, resolution_type=$4, resolution_note=$5, resolved_by=$6,
         resolved_at=CASE WHEN $3='RESOLVED' THEN COALESCE(resolved_at, now()) ELSE NULL END,
         updated_at=now()
     WHERE id=$1 AND tenant_id=$2
     RETURNING id,status,resolution_type,resolution_note,resolved_by,resolved_at,updated_at`,
    [reconciliationId, tenantId, status, resolutionType, resolutionNote, resolvedBy]
  );
  return result.rows[0];
};

module.exports = {
  withTransaction,
  lockCustomerOrder,
  lockOrderById,
  lockPaymentForOrder,
  lockPaymentById,
  lockPaymentByProviderOrder,
  saveProviderOrder,
  markPaymentPaid,
  markPaymentFailed,
  recordPaymentAttempt,
  markPaymentReconciliationRequired,
  openReconciliationCase,
  lockReconciliationByPaymentReference,
  updateReconciliationCase,
  claimWebhookEvent,
  completeWebhookEvent,
};
