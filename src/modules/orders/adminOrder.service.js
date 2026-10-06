const pool = require('../../config/db');
const { NotFoundError } = require('../../utils/errors');
const orderService = require('./order.service');
const notifications = require('./orderNotification.service');
const { addInclusiveDateRange } = require('../../utils/adminList');

const money = (value) => Number(value || 0);
const summary = (row) => ({
  orderReference: row.order_number, status: row.status, paymentStatus: row.payment_status, totalAmount: money(row.total_amount),
  currency: row.currency, subtotal: money(row.subtotal), taxAmount: money(row.gst_amount), shippingAmount: money(row.shipping_amount), createdAt: row.created_at, customer: { id: row.customer_id, fullName: row.full_name || null, email: row.email, phone: row.phone || null },
  items: row.item_summaries || [],
});

const listItemSummaries = async (tenantId, orderIds) => {
  if (!orderIds.length) return new Map();
  const result = await pool.query(
    `SELECT oi.order_id, oi.product_id, oi.product_name, oi.image_url, SUM(oi.quantity)::int AS quantity, MIN(oi.created_at) AS first_created_at
     FROM ORDER_ITEMS oi
     WHERE oi.tenant_id = $1 AND oi.order_id = ANY($2::text[]) AND oi.is_deleted = false
     GROUP BY oi.order_id, oi.product_id, oi.product_name, oi.image_url
     ORDER BY oi.order_id, MIN(oi.created_at), oi.product_id, oi.product_name`,
    [tenantId, orderIds]
  );
  return result.rows.reduce((itemsByOrder, item) => {
    const items = itemsByOrder.get(item.order_id) || [];
    items.push({ productId: item.product_id || null, name: item.product_name || 'Product', imageUrl: item.image_url || null, quantity: Number(item.quantity) });
    itemsByOrder.set(item.order_id, items);
    return itemsByOrder;
  }, new Map());
};

const list = async (tenantId, { page, limit, search, status, paymentStatus, from, to }) => {
  const where = ['o.tenant_id = $1', 'o.is_deleted = false']; const values = [tenantId];
  if (search) { values.push(`%${search}%`); where.push(`(o.order_number ILIKE $${values.length} OR c.full_name ILIKE $${values.length} OR c.email ILIKE $${values.length})`); }
  if (status) { values.push(status); where.push(`o.status = $${values.length}`); }
  if (paymentStatus) { values.push(paymentStatus); where.push(`o.payment_status = $${values.length}`); }
  addInclusiveDateRange(where, values, 'o.created_at', { from, to });
  const whereClause = where.join(' AND '); const offset = (page - 1) * limit;
  const [countResult, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM ORDERS o JOIN CUSTOMERS c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id WHERE ${whereClause}`, values),
    pool.query(`SELECT o.id, o.order_number, o.status, o.payment_status, o.subtotal, o.gst_amount, o.shipping_amount, o.total_amount, o.currency, o.created_at, o.customer_id, c.full_name, c.email, c.phone
      FROM ORDERS o JOIN CUSTOMERS c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id WHERE ${whereClause}
      ORDER BY o.created_at DESC, o.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
  ]);
  const total = countResult.rows[0]?.total || 0;
  const itemsByOrder = await listItemSummaries(tenantId, rows.rows.map((row) => row.id));
  return { orders: rows.rows.map((row) => summary({ ...row, item_summaries: itemsByOrder.get(row.id) || [] })), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrevious: page > 1 } };
};

const getByReference = async (tenantId, orderReference) => {
  const header = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.subtotal, o.discount_amount, o.gst_amount, o.shipping_amount, o.total_amount, o.currency,
      o.shipping_address_snapshot, o.courier_name, o.tracking_number, o.tracking_url, o.dispatched_at, o.expected_delivery_date, o.created_at,
      c.id AS customer_id, c.full_name, c.email, c.phone
     FROM ORDERS o JOIN CUSTOMERS c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
     WHERE o.tenant_id = $1 AND o.order_number = $2 AND o.is_deleted = false`, [tenantId, orderReference]
  );
  const order = header.rows[0]; if (!order) throw new NotFoundError('Order');
  const [items, history, payment] = await Promise.all([
    pool.query(`SELECT product_id, product_name, product_sku, unit_price, quantity, line_subtotal, image_url FROM ORDER_ITEMS WHERE tenant_id = $1 AND order_id = $2 AND is_deleted = false ORDER BY created_at ASC, id ASC`, [tenantId, order.id]),
    pool.query(`SELECT from_status, to_status, notes, actor_type, created_by, metadata, created_at FROM ORDER_STATUS_HISTORY WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at ASC, id ASC`, [tenantId, order.id]),
    pool.query(`SELECT p.id,p.gateway,p.method,p.status,p.amount,p.currency,p.paid_at,p.verified_at,r.id AS reconciliation_id,r.status AS reconciliation_status,r.reason_code,r.reason_message_sanitized,r.resolution_type,r.resolution_note,r.resolved_at
      FROM PAYMENTS p LEFT JOIN PAYMENT_RECONCILIATIONS r ON r.payment_id=p.id AND r.tenant_id=p.tenant_id
      WHERE p.tenant_id = $1 AND p.order_id = $2 AND p.is_deleted = false ORDER BY p.created_at DESC, p.id DESC LIMIT 1`, [tenantId, order.id]),
  ]);
  const snapshot = typeof order.shipping_address_snapshot === 'object' ? order.shipping_address_snapshot : JSON.parse(order.shipping_address_snapshot || 'null');
  return {
    ...summary(order), subtotal: money(order.subtotal), discountAmount: money(order.discount_amount), taxAmount: money(order.gst_amount), shippingAmount: money(order.shipping_amount),
    deliveryAddress: snapshot, fulfillment: { courierName: order.courier_name || null, trackingNumber: order.tracking_number || null, trackingUrl: order.tracking_url || null, dispatchedAt: order.dispatched_at || null, expectedDeliveryDate: order.expected_delivery_date || null },
    items: items.rows.map((item) => ({ productId: item.product_id, productName: item.product_name, productSku: item.product_sku || null, unitPrice: money(item.unit_price), quantity: Number(item.quantity), lineSubtotal: money(item.line_subtotal), imageUrl: item.image_url || null })),
    payment: payment.rows[0] ? { reference: payment.rows[0].id, gateway: payment.rows[0].gateway, method: payment.rows[0].method || null, status: payment.rows[0].status, amount: money(payment.rows[0].amount), currency: payment.rows[0].currency, paidAt: payment.rows[0].paid_at || null, verifiedAt: payment.rows[0].verified_at || null, reconciliation: payment.rows[0].reconciliation_id ? { id: payment.rows[0].reconciliation_id, status: payment.rows[0].reconciliation_status, reasonCode: payment.rows[0].reason_code, reasonMessage: payment.rows[0].reason_message_sanitized, resolutionType: payment.rows[0].resolution_type || null, resolutionNote: payment.rows[0].resolution_note || null, resolvedAt: payment.rows[0].resolved_at || null } : null } : null,
    statusHistory: history.rows.map((entry) => ({ fromStatus: entry.from_status || null, toStatus: entry.to_status, notes: entry.notes || null, actorType: entry.actor_type || null, actorId: entry.created_by || null, metadata: entry.metadata || {}, createdAt: entry.created_at })),
  };
};

const transition = async ({ tenantId, orderReference, actorId, fulfillment, toStatus, requestId, ipAddress, userAgent }) => {
  const found = await pool.query(`SELECT id FROM ORDERS WHERE tenant_id = $1 AND order_number = $2 AND is_deleted = false`, [tenantId, orderReference]);
  if (!found.rows[0]) throw new NotFoundError('Order');
  return orderService.transitionStatus({ tenantId, orderId: found.rows[0].id, toStatus, actorId, actorType: 'STAFF', fulfillment, requestId, ipAddress, userAgent });
};
const retryNotifications = async ({ tenantId, orderReference }) => {
  const found = await pool.query(`SELECT id FROM ORDERS WHERE tenant_id = $1 AND order_number = $2 AND is_deleted = false`, [tenantId, orderReference]);
  if (!found.rows[0]) throw new NotFoundError('Order');
  return notifications.dispatchForOrder({ tenantId, orderId: found.rows[0].id });
};
module.exports = { list, getByReference, transition, retryNotifications };
