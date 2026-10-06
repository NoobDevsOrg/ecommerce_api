const pool = require('../../config/db');
const { NotFoundError } = require('../../utils/errors');
const { addInclusiveDateRange } = require('../../utils/adminList');

const present = (row) => ({
  paymentReference: row.id, orderReference: row.order_number, customer: { id: row.customer_id, fullName: row.full_name || null, email: row.email }, provider: row.gateway,
  providerOrderId: row.razorpay_order_id || null, providerPaymentId: row.razorpay_payment_id || null, amount: Number(row.amount || 0), currency: row.currency,
  paymentStatus: row.status, method: row.method || null, createdAt: row.created_at, paidAt: row.paid_at || null,
  items: row.item_summaries || [],
  reconciliation: row.reconciliation_id ? { id: row.reconciliation_id, status: row.reconciliation_status, reasonCode: row.reason_code, reasonMessage: row.reason_message_sanitized, resolutionType: row.resolution_type || null, resolutionNote: row.resolution_note || null, resolvedAt: row.resolved_at || null } : null,
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

const query = async (tenantId, { page = 1, limit = 20, search = '', status, from, to, exportAll = false }) => {
  const values = [tenantId]; const where = ['p.tenant_id = $1', 'p.is_deleted = false'];
  if (search) { values.push(`%${search}%`); where.push(`(p.id ILIKE $${values.length} OR o.order_number ILIKE $${values.length} OR c.full_name ILIKE $${values.length} OR c.email ILIKE $${values.length} OR p.razorpay_order_id ILIKE $${values.length} OR p.razorpay_payment_id ILIKE $${values.length})`); }
  if (status) { values.push(status); where.push(`p.status = $${values.length}`); }
  addInclusiveDateRange(where, values, 'p.created_at', { from, to });
  const clause = where.join(' AND '); const base = `FROM PAYMENTS p JOIN ORDERS o ON o.id=p.order_id AND o.tenant_id=p.tenant_id JOIN CUSTOMERS c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id LEFT JOIN PAYMENT_RECONCILIATIONS r ON r.payment_id=p.id AND r.tenant_id=p.tenant_id WHERE ${clause}`;
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS total ${base}`, values)).rows[0]?.total || 0);
  const boundedLimit = exportAll ? 5000 : limit; const offset = exportAll ? 0 : (page - 1) * limit;
  const rows = await pool.query(`SELECT p.id,p.gateway,p.razorpay_order_id,p.razorpay_payment_id,p.method,p.status,p.amount,p.currency,p.created_at,p.paid_at,o.id AS order_id,o.order_number,c.id AS customer_id,c.full_name,c.email,r.id AS reconciliation_id,r.status AS reconciliation_status,r.reason_code,r.reason_message_sanitized,r.resolution_type,r.resolution_note,r.resolved_at ${base} ORDER BY p.created_at DESC,p.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, boundedLimit, offset]);
  const itemsByOrder = await listItemSummaries(tenantId, [...new Set(rows.rows.map((row) => row.order_id))]);
  return { payments: rows.rows.map((row) => present({ ...row, item_summaries: itemsByOrder.get(row.order_id) || [] })), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: !exportAll && page * limit < total, hasPrevious: !exportAll && page > 1 } };
};
const getByReference = async (tenantId, paymentReference) => {
  const result = await pool.query(
    `SELECT p.id,p.gateway,p.razorpay_order_id,p.razorpay_payment_id,p.method,p.status,p.amount,p.currency,p.created_at,p.paid_at,
            o.order_number,c.id AS customer_id,c.full_name,c.email,r.id AS reconciliation_id,r.status AS reconciliation_status,
            r.reason_code,r.reason_message_sanitized,r.resolution_type,r.resolution_note,r.resolved_at
     FROM PAYMENTS p JOIN ORDERS o ON o.id=p.order_id AND o.tenant_id=p.tenant_id
     JOIN CUSTOMERS c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
     LEFT JOIN PAYMENT_RECONCILIATIONS r ON r.payment_id=p.id AND r.tenant_id=p.tenant_id
     WHERE p.tenant_id=$1 AND p.id=$2 AND p.is_deleted=false AND o.is_deleted=false`,
    [tenantId, paymentReference]
  );
  if (!result.rows[0]) throw new NotFoundError('Payment');
  return present(result.rows[0]);
};
module.exports = { query, getByReference };
