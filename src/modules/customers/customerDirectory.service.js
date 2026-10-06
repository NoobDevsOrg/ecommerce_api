const pool = require('../../config/db');
const { NotFoundError } = require('../../utils/errors');
const { addInclusiveDateRange } = require('../../utils/adminList');

const presentCustomer = (row) => ({
  id: row.id,
  fullName: row.full_name || null,
  email: row.email,
  phone: row.phone || null,
  createdAt: row.created_at,
  status: row.auth_is_active === false ? 'INACTIVE' : row.auth_id ? 'ACTIVE' : 'UNAVAILABLE',
  addressCount: Number(row.address_count || 0),
  orderCount: Number(row.order_count || 0),
  totalPaidOrderValue: Number(row.total_paid_order_value || 0),
  authMethod: row.auth_id ? (row.google_subject_present ? 'GOOGLE' : 'PASSWORD') : 'UNAVAILABLE',
});

const presentAddress = (row) => ({
  id: row.id,
  fullName: row.full_name || null,
  phone: row.phone || null,
  addressLine1: row.line1,
  addressLine2: row.line2 || null,
  landmark: row.landmark || null,
  city: row.city || null,
  state: row.state_code || null,
  pincode: row.pincode || null,
  country: row.country_code || null,
  isDefault: Boolean(row.is_default),
});

const presentCustomerDetail = (row) => ({
  ...presentCustomer(row),
  latestOrderDate: row.latest_order_date || null,
});

const presentOrder = (row) => ({
  orderReference: row.order_number,
  orderDate: row.created_at,
  paymentStatus: row.payment_status,
  status: row.status,
  totalAmount: Number(row.total_amount || 0),
  currency: row.currency,
});

const list = async (tenantId, { page, limit, search, from, to }) => {
  const offset = (page - 1) * limit;
  const values = [tenantId];
  const where = ['c.tenant_id = $1'];

  if (search) {
    values.push(`%${search}%`);
    where.push(`(c.full_name ILIKE $2 OR c.email ILIKE $2 OR COALESCE(c.phone, '') ILIKE $2)`);
  }
  addInclusiveDateRange(where, values, 'c.created_at', { from, to });

  const whereClause = where.join(' AND ');
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM CUSTOMERS c WHERE ${whereClause}`, values);
  const queryValues = [...values, limit, offset];
  const limitIndex = queryValues.length - 1;
  const offsetIndex = queryValues.length;
  const result = await pool.query(
    `SELECT c.id, c.full_name, c.email, c.phone, c.created_at,
            auth.id AS auth_id, auth.is_active AS auth_is_active,
            (auth.google_subject IS NOT NULL) AS google_subject_present,
            COALESCE(address_counts.address_count, 0)::int AS address_count,
            order_metrics.order_count, order_metrics.total_paid_order_value
     FROM CUSTOMERS c
     LEFT JOIN LATERAL (
       SELECT id, is_active, google_subject
       FROM AUTH
       WHERE tenant_id = c.tenant_id AND customer_id = c.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) auth ON true
     LEFT JOIN (
       SELECT customer_id, COUNT(*)::int AS address_count
       FROM ADDRESSES
       WHERE tenant_id = $1 AND is_deleted = false
       GROUP BY customer_id
     ) address_counts ON address_counts.customer_id = c.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS total_paid_order_value
       FROM ORDERS o WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id AND o.is_deleted = false
     ) order_metrics ON true
     WHERE ${whereClause}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    queryValues
  );

  const total = countResult.rows[0]?.total || 0;
  return {
    customers: result.rows.map(presentCustomer),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
  };
};

const getById = async (tenantId, customerId) => {
  const customerResult = await pool.query(
    `SELECT c.id, c.full_name, c.email, c.phone, c.created_at,
            auth.id AS auth_id, auth.is_active AS auth_is_active,
            (auth.google_subject IS NOT NULL) AS google_subject_present,
            COALESCE(address_counts.address_count, 0)::int AS address_count,
            order_metrics.order_count, order_metrics.total_paid_order_value, order_metrics.latest_order_date
     FROM CUSTOMERS c
     LEFT JOIN LATERAL (
       SELECT id, is_active, google_subject
       FROM AUTH
       WHERE tenant_id = c.tenant_id AND customer_id = c.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) auth ON true
     LEFT JOIN (
       SELECT customer_id, COUNT(*)::int AS address_count
       FROM ADDRESSES
       WHERE tenant_id = $1 AND is_deleted = false
       GROUP BY customer_id
     ) address_counts ON address_counts.customer_id = c.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS total_paid_order_value,
              MAX(o.created_at) AS latest_order_date
       FROM ORDERS o
       WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id AND o.is_deleted = false
     ) order_metrics ON true
     WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, customerId]
  );

  const customer = customerResult.rows[0];
  if (!customer) throw new NotFoundError('Customer');

  const addressResult = await pool.query(
    `SELECT id, full_name, phone, line1, line2, landmark, city, state_code,
            country_code, pincode, is_default
     FROM ADDRESSES
     WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false
     ORDER BY is_default DESC, updated_at DESC, id DESC`,
    [tenantId, customerId]
  );

  return {
    ...presentCustomerDetail(customer),
    addresses: addressResult.rows.map(presentAddress),
  };
};

const listOrders = async (tenantId, customerId, { page, limit }) => {
  const customer = await pool.query(
    'SELECT id FROM CUSTOMERS WHERE tenant_id = $1 AND id = $2',
    [tenantId, customerId]
  );
  if (!customer.rows[0]) throw new NotFoundError('Customer');

  const offset = (page - 1) * limit;
  const [countResult, ordersResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM ORDERS
       WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false`,
      [tenantId, customerId]
    ),
    pool.query(
      `SELECT order_number, created_at, payment_status, status, total_amount, currency
       FROM ORDERS
       WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, customerId, limit, offset]
    ),
  ]);

  const total = countResult.rows[0]?.total || 0;
  return {
    orders: ordersResult.rows.map(presentOrder),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
  };
};

module.exports = { list, getById, listOrders, presentCustomer };
