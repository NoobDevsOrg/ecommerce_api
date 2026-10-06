const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../utils/errors');
const crypto = require('crypto');
const paymentRepository = require('./payment.repository');
const razorpayProvider = require('./providers/razorpay.provider');
const integrationConfigService = require('../integrations/integrationConfig.service');
const orderNotifications = require('../orders/orderNotification.service');
const inventoryService = require('../inventory/inventory.service');
const { invalidatePublicProductCache } = require('../products/product.controller');
const audit = require('../../services/audit.service');

const toPaise = (value, field) => {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) throw new ValidationError(`Trusted ${field} is invalid`);
  const fraction = (match[2] || '').padEnd(3, '0');
  let paise = BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2));
  if (fraction[2] >= '5') paise += 1n;
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError(`Trusted ${field} is too large`);
  return Number(paise);
};

const paiseToDecimal = (paise) => (paise / 100).toFixed(2);
const supportedMethods = new Set(['UPI', 'CARD', 'NETBANKING']);
const normalizeMethod = (method) => (supportedMethods.has(String(method || '').toUpperCase()) ? String(method).toUpperCase() : null);
const reconciliationReason = ({ amountMatches = true, currencyMatches = true } = {}) => {
  if (!amountMatches) return 'AMOUNT_MISMATCH';
  if (!currencyMatches) return 'CURRENCY_MISMATCH';
  return 'PROVIDER_MAPPING_MISMATCH';
};

const assertPaymentEligible = (order) => {
  if (!order) throw new NotFoundError('Order');
  if (order.payment_status === 'PAID') throw new ConflictError('This order has already been paid');
  if (order.status !== 'CONFIRMED' || order.payment_status !== 'PENDING' || order.currency !== 'INR') {
    throw new ConflictError('This order is not available for payment');
  }
  const amountPaise = toPaise(order.total_amount, 'order total');
  if (amountPaise <= 0) throw new ConflictError('This order is not available for payment');
  return amountPaise;
};

const safePrefill = (order) => ({
  name: order.full_name || undefined,
  email: order.email || undefined,
  contact: order.phone || undefined,
});

const presentCheckout = ({ order, payment, keyId, amountPaise }) => ({
  orderReference: order.order_number,
  razorpayOrderId: payment.razorpay_order_id,
  keyId,
  amount: amountPaise,
  currency: order.currency,
  prefill: safePrefill(order),
});

const assertProviderPayment = ({ providerPayment, payment, order, expectedAmountPaise }) => {
  if (!providerPayment || providerPayment.id !== payment.razorpay_payment_id
    || providerPayment.order_id !== payment.razorpay_order_id
    || Number(providerPayment.amount) !== expectedAmountPaise
    || providerPayment.currency !== order.currency) {
    throw new ValidationError('Payment response could not be verified');
  }
};

const webhookEventId = ({ event, rawBody, headerEventId }) => {
  if (typeof headerEventId === 'string' && /^[A-Za-z0-9_:-]{8,200}$/.test(headerEventId)) return headerEventId;
  const entity = event?.payload?.payment?.entity || {};
  return `derived:${crypto.createHash('sha256').update(`${event?.event || ''}|${entity.id || ''}|${entity.order_id || ''}|`).update(Buffer.from(rawBody)).digest('hex')}`;
};

const webhookPayment = (event) => event?.payload?.payment?.entity || null;
const capturedWebhookPayment = (event) => {
  const entity = webhookPayment(event);
  return entity?.status === 'captured' ? entity : null;
};
const safeWebhookEventId = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= 12 ? `${value.slice(0, 3)}***` : `${value.slice(0, 6)}***${value.slice(-4)}`;
};
const webhookResult = (data, eventType, providerEventId = null) => ({
  ...data,
  webhookLog: { provider: 'razorpay', eventType, eventId: safeWebhookEventId(providerEventId) },
});

const createPaymentService = ({ repository = paymentRepository, provider = razorpayProvider, integrations = integrationConfigService, notifications = orderNotifications, inventory = inventoryService, auditService = audit } = {}) => {
  const recordAttempt = async (client, input) => {
    // Injectable test repositories created before attempt history intentionally
    // remain compatible; the production repository always persists this row.
    if (typeof repository.recordPaymentAttempt === 'function') {
      await repository.recordPaymentAttempt(client, input);
    }
  };

  const recordProviderLookupFailure = async ({ tenantId, customerId, orderReference, razorpayOrderId, razorpayPaymentId, requestId }) => {
    try {
      await repository.withTransaction(async (client) => {
        const order = await repository.lockCustomerOrder(client, tenantId, customerId, orderReference);
        const payment = order && await repository.lockPaymentForOrder(client, tenantId, order.id);
        if (!order || !payment || payment.razorpay_order_id !== razorpayOrderId) return;
        await recordAttempt(client, {
          tenantId, paymentId: payment.id, orderId: order.id,
          eventType: 'VERIFY_PROVIDER_LOOKUP_FAILED', outcome: 'UNKNOWN',
          providerOrderId: razorpayOrderId, providerPaymentId: razorpayPaymentId, requestId,
        });
      });
    } catch (_recordingError) {
      // Observation failure must never replace the original provider outcome.
    }
  };

  const createRazorpayOrder = async ({ tenantId, customerId, orderReference }) => {
    const configuration = await integrations.getEnabledRazorpayConfiguration(tenantId);
    const keyId = provider.getPublicKeyId(configuration.mode);

    return repository.withTransaction(async (client) => {
      const order = await repository.lockCustomerOrder(client, tenantId, customerId, orderReference);
      const amountPaise = assertPaymentEligible(order);
      const existing = await repository.lockPaymentForOrder(client, tenantId, order.id);
      if (existing?.razorpay_order_id) {
        return presentCheckout({ order, payment: existing, keyId, amountPaise });
      }

      // The Order row lock is shared across Express instances. It deliberately
      // covers this short provider call so two requests cannot create two
      // provider orders for one pending Sagunthala order.
      const providerOrder = await provider.createOrder({
        mode: configuration.mode,
        amountPaise,
        currency: order.currency,
        receipt: order.order_number.slice(0, 40),
        notes: { sagunthala_order: order.order_number },
      });
      const payment = await repository.saveProviderOrder(client, {
        payment: existing,
        order,
        providerOrderId: providerOrder.id,
        amount: paiseToDecimal(amountPaise),
        currency: order.currency,
        actorId: customerId,
      });
      await recordAttempt(client, {
        tenantId, paymentId: payment.id, orderId: order.id,
        eventType: 'PROVIDER_ORDER_ATTACHED', outcome: 'SUCCEEDED',
        providerOrderId: payment.razorpay_order_id,
      });
      return presentCheckout({ order, payment, keyId, amountPaise });
    });
  };

  const verifyRazorpayCallback = async ({ tenantId, customerId, orderReference, razorpayOrderId, razorpayPaymentId, razorpaySignature, requestId = null }) => {
    const configuration = await integrations.getRazorpayConfiguration(tenantId);
    const result = await repository.withTransaction(async (client) => {
      const order = await repository.lockCustomerOrder(client, tenantId, customerId, orderReference);
      if (!order) throw new NotFoundError('Order');
      const amountPaise = toPaise(order.total_amount, 'order total');
      const payment = await repository.lockPaymentForOrder(client, tenantId, order.id);
      if (!payment || payment.razorpay_order_id !== razorpayOrderId) {
        throw new ValidationError('Payment response could not be verified');
      }
      if (!provider.verifyPaymentSignature({
        mode: configuration.mode,
        providerOrderId: payment.razorpay_order_id,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
      })) {
        throw new ValidationError('Payment response could not be verified');
      }
      if (order.payment_status === 'PAID') {
        if (payment.razorpay_payment_id && payment.razorpay_payment_id !== razorpayPaymentId) {
          throw new ConflictError('This order has already been paid');
        }
        return { orderReference: order.order_number, paymentStatus: 'PAID', alreadyProcessed: true };
      }
      if (order.payment_status === 'REQUIRES_RECONCILIATION') {
        return { orderReference: order.order_number, paymentStatus: 'REQUIRES_RECONCILIATION', alreadyProcessed: true };
      }
      assertPaymentEligible(order);

      const providerPayment = await provider.fetchPayment({ mode: configuration.mode, paymentId: razorpayPaymentId });
      assertProviderPayment({
        providerPayment,
        payment: { ...payment, razorpay_payment_id: razorpayPaymentId },
        order,
        expectedAmountPaise: amountPaise,
      });
      if (providerPayment.status !== 'captured') {
        return { orderReference: order.order_number, paymentStatus: 'PENDING', alreadyProcessed: false };
      }
      const inventoryProductIds = await inventory.applyPaidOrderSale(client, { tenantId, orderId: order.id, ...(requestId ? { requestId } : {}) });
      const paid = await repository.markPaymentPaid(client, {
        payment,
        order,
        paymentId: razorpayPaymentId,
        method: normalizeMethod(providerPayment.method),
        actorId: customerId,
      });
      await recordAttempt(client, {
        tenantId, paymentId: payment.id, orderId: order.id,
        eventType: 'PAYMENT_CAPTURED', outcome: 'SUCCEEDED',
        providerOrderId: payment.razorpay_order_id, providerPaymentId: razorpayPaymentId, requestId,
      });
      await auditService.write(client, { tenantId, entityType: 'PAYMENT', entityId: payment.id, action: 'PAYMENT_CONFIRMED', actorType: 'CUSTOMER', actorId: customerId,
        beforeSnapshot: { status: payment.status, orderPaymentStatus: order.payment_status }, afterSnapshot: { status: paid.status, orderPaymentStatus: 'PAID' }, changedFields: ['status', 'orderPaymentStatus'], requestId });
      return { orderReference: order.order_number, paymentStatus: 'PAID', alreadyProcessed: false, orderId: order.id, inventoryProductIds };
    }).catch(async (error) => {
      if (error?.errorCode === 'PAYMENT_PROVIDER_ERROR') {
        await recordProviderLookupFailure({ tenantId, customerId, orderReference, razorpayOrderId, razorpayPaymentId, requestId });
      }
      if (error?.errorCode !== 'INVENTORY_INSUFFICIENT_STOCK') throw error;
      return repository.withTransaction(async (client) => {
        const order = await repository.lockCustomerOrder(client, tenantId, customerId, orderReference);
        const payment = order && await repository.lockPaymentForOrder(client, tenantId, order.id);
        if (!order || !payment) throw error;
        if (order.payment_status === 'PAID') return { orderReference: order.order_number, paymentStatus: 'PAID', alreadyProcessed: true };
        const reconciled = await repository.markPaymentReconciliationRequired(client, { payment, order, paymentId: razorpayPaymentId, actorId: customerId, reasonCode: 'INSUFFICIENT_STOCK' });
        await recordAttempt(client, {
          tenantId, paymentId: payment.id, orderId: order.id,
          eventType: 'PAYMENT_CAPTURED', outcome: 'SUCCEEDED',
          providerOrderId: payment.razorpay_order_id, providerPaymentId: razorpayPaymentId, requestId,
        });
        if (reconciled.reconciliation?.created) await auditService.write(client, { tenantId, entityType: 'PAYMENT_RECONCILIATION', entityId: reconciled.reconciliation.id, action: 'RECONCILIATION_OPENED', actorType: 'CUSTOMER', actorId: customerId, beforeSnapshot: null, afterSnapshot: { status: reconciled.reconciliation.status, reasonCode: reconciled.reconciliation.reason_code }, changedFields: ['status', 'reasonCode'], requestId });
        return { orderReference: order.order_number, paymentStatus: 'REQUIRES_RECONCILIATION', reconciliationRequired: true, orderId: order.id };
      });
    });
    if (result.orderId) { invalidatePublicProductCache(tenantId); notifications.dispatchSafely({ tenantId, orderId: result.orderId }); for (const productId of result.inventoryProductIds || []) notifications.dispatchSafely({ tenantId, entityId: productId }); }
    const { orderId: _orderId, inventoryProductIds: _inventoryProductIds, ...response } = result;
    return response;
  };

  const getCustomerPaymentState = async ({ tenantId, customerId, orderReference }) => repository.withTransaction(async (client) => {
    const order = await repository.lockCustomerOrder(client, tenantId, customerId, orderReference);
    if (!order) throw new NotFoundError('Order');
    return { orderReference: order.order_number, paymentStatus: order.payment_status, orderStatus: order.status };
  });

  const handleRazorpayWebhook = async ({ rawBody, signature, eventId, requestId = null }) => {
    if (!provider.verifyWebhookSignature({ rawBody, signature })) {
      throw new AppError('Invalid webhook signature', 400, 'PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
    let event;
    try {
      event = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch (_error) {
      throw new AppError('Invalid webhook payload', 400, 'PAYMENT_WEBHOOK_INVALID_PAYLOAD');
    }
    if (!['payment.captured', 'order.paid', 'payment.failed'].includes(event?.event)) {
      return webhookResult({ processed: false, ignored: true }, 'unsupported');
    }
    const entity = event.event === 'payment.failed' ? webhookPayment(event) : capturedWebhookPayment(event);
    if (!entity || typeof entity.order_id !== 'string' || typeof entity.id !== 'string') {
      // An order event alone, or an uncaptured payment entity, cannot establish
      // a trustworthy payment transition. A later captured event can retry.
      return webhookResult({ processed: false, ignored: true }, event.event);
    }
    const providerEventId = webhookEventId({ event, rawBody, headerEventId: eventId });

    const result = await repository.withTransaction(async (client) => {
      const claimed = await repository.claimWebhookEvent(client, { providerEventId, eventType: event.event, paymentId: entity.id, orderId: entity.order_id, requestId });
      if (!claimed) return { processed: true, duplicate: true };
      const payment = await repository.lockPaymentByProviderOrder(client, entity.order_id);
      if (!payment) { await repository.completeWebhookEvent(client, { providerEventId, ignored: true }); return { processed: false, ignored: true }; }
      const paymentStatus = payment.payment_record_status || payment.status;
      // Terminal business states win over every later provider notification,
      // including malformed/mismatched failure events.
      if (paymentStatus === 'PAID') {
        await repository.completeWebhookEvent(client, { providerEventId, paymentId: payment.id, orderId: payment.order_id });
        return { processed: true, paymentStatus: 'PAID', alreadyProcessed: true };
      }
      if (paymentStatus === 'REQUIRES_RECONCILIATION') {
        await repository.completeWebhookEvent(client, { providerEventId, paymentId: payment.id, orderId: payment.order_id });
        return { processed: true, paymentStatus: 'REQUIRES_RECONCILIATION', alreadyProcessed: true };
      }
      const expectedAmountPaise = toPaise(payment.total_amount, 'order total');
      if (Number(entity.amount) !== expectedAmountPaise || entity.currency !== payment.currency) {
        const reasonCode = reconciliationReason({ amountMatches: Number(entity.amount) === expectedAmountPaise, currencyMatches: entity.currency === payment.currency });
        const reconciled = await repository.markPaymentReconciliationRequired(client, { payment, order: { id: payment.order_id, tenant_id: payment.tenant_id }, paymentId: entity.id, providerEventId, actorId: 'razorpay-webhook', reasonCode });
        if (reconciled.reconciliation?.created) await auditService.write(client, { tenantId: payment.tenant_id, entityType: 'PAYMENT_RECONCILIATION', entityId: reconciled.reconciliation.id, action: 'RECONCILIATION_OPENED', actorType: 'SYSTEM', actorId: 'razorpay-webhook', beforeSnapshot: null, afterSnapshot: { status: reconciled.reconciliation.status, reasonCode: reconciled.reconciliation.reason_code }, changedFields: ['status', 'reasonCode'], requestId });
        await repository.completeWebhookEvent(client, { providerEventId, paymentId: payment.id, orderId: payment.order_id });
        return { processed: true, paymentStatus: 'REQUIRES_RECONCILIATION', reconciliationRequired: true, orderId: payment.order_id, tenantId: payment.tenant_id };
      }
      if (event.event === 'payment.failed') {
        const failed = await repository.markPaymentFailed(client, {
          payment,
          paymentId: entity.id,
          providerEventId,
          actorId: 'razorpay-webhook',
        });
        if ((failed.payment_record_status || failed.status) === 'FAILED') {
          await recordAttempt(client, {
            tenantId: payment.tenant_id, paymentId: payment.id, orderId: payment.order_id,
            eventType: 'PAYMENT_FAILED', outcome: 'FAILED',
            providerOrderId: payment.razorpay_order_id, providerPaymentId: entity.id, requestId,
          });
        }
        await repository.completeWebhookEvent(client, { providerEventId, paymentId: payment.id, orderId: payment.order_id });
        return { processed: true, paymentStatus: 'PENDING', failed: true };
      }
      const inventoryProductIds = await inventory.applyPaidOrderSale(client, { tenantId: payment.tenant_id, orderId: payment.order_id, ...(requestId ? { requestId } : {}) });
      const paid = await repository.markPaymentPaid(client, {
        payment,
        order: { id: payment.order_id, tenant_id: payment.tenant_id },
        paymentId: entity.id,
        method: normalizeMethod(entity.method),
        providerEventId,
        actorId: 'razorpay-webhook',
      });
      await recordAttempt(client, {
        tenantId: payment.tenant_id, paymentId: payment.id, orderId: payment.order_id,
        eventType: 'PAYMENT_CAPTURED', outcome: 'SUCCEEDED',
        providerOrderId: payment.razorpay_order_id, providerPaymentId: entity.id, requestId,
      });
      await auditService.write(client, { tenantId: payment.tenant_id, entityType: 'PAYMENT', entityId: payment.id, action: 'PAYMENT_CONFIRMED', actorType: 'SYSTEM', actorId: 'razorpay-webhook', beforeSnapshot: { status: payment.payment_record_status || payment.status }, afterSnapshot: { status: paid.status }, changedFields: ['status'], requestId });
      await repository.completeWebhookEvent(client, { providerEventId, paymentId: payment.id, orderId: payment.order_id });
      return { processed: true, paymentStatus: 'PAID', alreadyProcessed: false, orderId: payment.order_id, tenantId: payment.tenant_id, inventoryProductIds };
    }).catch(async (error) => {
      if (error?.errorCode !== 'INVENTORY_INSUFFICIENT_STOCK') throw error;
      return repository.withTransaction(async (client) => {
        const payment = await repository.lockPaymentByProviderOrder(client, entity.order_id);
        if (!payment) throw error;
        if (['PAID', 'REQUIRES_RECONCILIATION'].includes(payment.payment_record_status || payment.status)) {
          return { processed: true, paymentStatus: payment.payment_record_status || payment.status, alreadyProcessed: true };
        }
        const reconciled = await repository.markPaymentReconciliationRequired(client, {
          payment, order: { id: payment.order_id, tenant_id: payment.tenant_id }, paymentId: entity.id,
          providerEventId, actorId: 'razorpay-webhook', reasonCode: 'INSUFFICIENT_STOCK',
        });
        await recordAttempt(client, {
          tenantId: payment.tenant_id, paymentId: payment.id, orderId: payment.order_id,
          eventType: 'PAYMENT_CAPTURED', outcome: 'SUCCEEDED',
          providerOrderId: payment.razorpay_order_id, providerPaymentId: entity.id, requestId,
        });
        if (reconciled.reconciliation?.created) await auditService.write(client, { tenantId: payment.tenant_id, entityType: 'PAYMENT_RECONCILIATION', entityId: reconciled.reconciliation.id, action: 'RECONCILIATION_OPENED', actorType: 'SYSTEM', actorId: 'razorpay-webhook', beforeSnapshot: null, afterSnapshot: { status: reconciled.reconciliation.status, reasonCode: reconciled.reconciliation.reason_code }, changedFields: ['status', 'reasonCode'], requestId });
        await repository.completeWebhookEvent(client, { providerEventId, paymentId: payment.id, orderId: payment.order_id });
        return { processed: true, paymentStatus: 'REQUIRES_RECONCILIATION', reconciliationRequired: true, orderId: payment.order_id, tenantId: payment.tenant_id };
      });
    });
    if (result.orderId) { invalidatePublicProductCache(result.tenantId); notifications.dispatchSafely({ tenantId: result.tenantId, orderId: result.orderId }); for (const productId of result.inventoryProductIds || []) notifications.dispatchSafely({ tenantId: result.tenantId, entityId: productId }); }
    const { orderId: _orderId, tenantId: _tenantId, inventoryProductIds: _inventoryProductIds, ...response } = result;
    return webhookResult(response, event.event, providerEventId);
  };

  return { createRazorpayOrder, verifyRazorpayCallback, getCustomerPaymentState, handleRazorpayWebhook };
};

const service = createPaymentService();
module.exports = { ...service, createPaymentService, toPaise };
