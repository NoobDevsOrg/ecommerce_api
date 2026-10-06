const defaultPool = require('../../config/db');
const { AppError } = require('../../utils/errors');
const { assertDateRange } = require('../../utils/adminList');

const ADMIN_TIME_ZONE = 'Asia/Kolkata';
const number = (value) => Number(value || 0);

const isoToday = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ADMIN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const shiftIsoDate = (value, days) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const resolveRange = ({ from, to } = {}) => {
  const end = to || isoToday();
  const start = from || shiftIsoDate(end, -29);
  assertDateRange({ from: start, to: end });
  const duration = (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000;
  if (duration > 366) throw new AppError('Dashboard date range cannot exceed 366 days', 400, 'INVALID_DATE_RANGE');
  return { from: start, to: end };
};

const range = (column) => `${column} >= ($2::date::timestamp AT TIME ZONE '${ADMIN_TIME_ZONE}') AND ${column} < (($3::date + interval '1 day')::timestamp AT TIME ZONE '${ADMIN_TIME_ZONE}')`;

const createDashboardService = ({ pool = defaultPool, lowStockThreshold = () => Math.max(0, Number(process.env.LOW_STOCK_THRESHOLD || 5)) } = {}) => {
  const overview = async (tenantId, query = {}) => {
    const { from, to } = resolveRange(query);
    const values = [tenantId, from, to];
    const orderRange = range('o.created_at');
    const paymentRange = range('p.created_at');
    const customerRange = range('c.created_at');
    const enquiryRange = range('e.created_at');
    const reviewRange = range('r.created_at');
    const threshold = lowStockThreshold();
    const duration = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000;
    const monthlyTrend = duration > 62;
    const salesTrendSql = monthlyTrend
      ? `WITH months AS (SELECT generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), interval '1 month')::date AS month)
         SELECT to_char(months.month, 'YYYY-MM-01') AS date,
                COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS revenue,
                COUNT(o.id) FILTER (WHERE o.payment_status = 'PAID')::int AS paid_orders
         FROM months LEFT JOIN ORDERS o ON o.tenant_id = $1 AND o.is_deleted = false
           AND date_trunc('month', o.created_at AT TIME ZONE '${ADMIN_TIME_ZONE}')::date = months.month
         GROUP BY months.month ORDER BY months.month ASC`
      : `WITH days AS (SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day)
         SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
                COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS revenue,
                COUNT(o.id) FILTER (WHERE o.payment_status = 'PAID')::int AS paid_orders
         FROM days LEFT JOIN ORDERS o ON o.tenant_id = $1 AND o.is_deleted = false
           AND (o.created_at AT TIME ZONE '${ADMIN_TIME_ZONE}')::date = days.day
         GROUP BY days.day ORDER BY days.day ASC`;

    const [kpiResult, salesResult, orderStatusResult, paymentStatusResult, topProductsResult, inventoryResult, enquiriesResult, reviewsResult, customersResult, alertsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS orders,
                COUNT(*) FILTER (WHERE o.payment_status = 'PAID')::int AS paid_orders,
                COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS revenue,
                COALESCE(SUM(o.subtotal) FILTER (WHERE o.payment_status = 'PAID'), 0) AS subtotal,
                COALESCE(SUM(o.gst_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS gst,
                COALESCE(SUM(o.shipping_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS shipping
         FROM ORDERS o WHERE o.tenant_id = $1 AND o.is_deleted = false AND ${orderRange}`,
        values
      ),
      pool.query(salesTrendSql, values),
      pool.query(
        `SELECT o.status, COUNT(*)::int AS count FROM ORDERS o
         WHERE o.tenant_id = $1 AND o.is_deleted = false AND o.status NOT IN ('CANCELLED', 'REFUNDED') AND ${orderRange}
         GROUP BY o.status ORDER BY o.status ASC`,
        values
      ),
      pool.query(
        `SELECT p.status, COUNT(*)::int AS count, COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAID'), 0) AS paid_amount
         FROM PAYMENTS p WHERE p.tenant_id = $1 AND p.is_deleted = false AND ${paymentRange}
         GROUP BY p.status ORDER BY p.status ASC`,
        values
      ),
      pool.query(
        `SELECT oi.product_id, MAX(oi.product_name) AS product_name, MAX(oi.image_url) AS image_url,
                SUM(oi.quantity)::int AS units_sold, COALESCE(SUM(oi.line_subtotal), 0) AS revenue
         FROM ORDER_ITEMS oi JOIN ORDERS o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
         WHERE oi.tenant_id = $1 AND oi.is_deleted = false AND o.is_deleted = false AND o.payment_status = 'PAID' AND ${orderRange}
         GROUP BY oi.product_id ORDER BY revenue DESC, units_sold DESC, oi.product_id ASC LIMIT 5`,
        values
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE p.stock_qty > $2)::int AS healthy,
                COUNT(*) FILTER (WHERE p.stock_qty > 0 AND p.stock_qty <= $2)::int AS low_stock,
                COUNT(*) FILTER (WHERE p.stock_qty = 0)::int AS out_of_stock,
                COALESCE((
                  SELECT json_agg(restock)
                  FROM (
                    SELECT r.id, r.name, r.sku, r.stock_qty
                    FROM PRODUCTS r
                    WHERE r.tenant_id = $1 AND r.is_deleted = false AND r.stock_qty <= $2
                    ORDER BY r.stock_qty ASC, r.name ASC LIMIT 6
                  ) restock
                ), '[]'::json) AS needs_restocking
         FROM PRODUCTS p WHERE p.tenant_id = $1 AND p.is_deleted = false`,
        [tenantId, threshold]
      ),
      pool.query(
        `SELECT e.status, COUNT(*)::int AS count FROM ENQUIRIES e
         WHERE e.tenant_id = $1 AND ${enquiryRange}
         GROUP BY e.status ORDER BY e.status ASC`,
        values
      ),
      pool.query(
        `SELECT COUNT(*)::int AS review_count, COUNT(*) FILTER (WHERE r.approved = false)::int AS pending_count,
                COALESCE(AVG(r.rating) FILTER (WHERE r.approved = true), 0) AS average_rating
         FROM product_reviews r WHERE r.tenant_id = $1 AND ${reviewRange}`,
        values
      ),
      pool.query(
        `SELECT COUNT(*)::int AS new_customers,
                (SELECT COUNT(*)::int FROM CUSTOMERS WHERE tenant_id = $1) AS total_customers,
                COALESCE(json_agg(recent ORDER BY recent.created_at DESC) FILTER (WHERE recent.id IS NOT NULL), '[]'::json) AS recent_customers
         FROM CUSTOMERS c
         LEFT JOIN LATERAL (
           SELECT c.id, c.full_name, c.email, c.created_at,
                  COUNT(o.id)::int AS order_count,
                  COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) AS paid_value
           FROM ORDERS o WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id AND o.is_deleted = false
         ) recent ON true
         WHERE c.tenant_id = $1 AND ${customerRange}`,
        values
      ),
      pool.query(
        `SELECT (SELECT COUNT(*)::int FROM PAYMENTS p WHERE p.tenant_id = $1 AND p.is_deleted = false AND p.status = 'REQUIRES_RECONCILIATION') AS reconciliation_count,
                (SELECT COUNT(*)::int FROM ENQUIRIES e WHERE e.tenant_id = $1 AND e.status = 'new') AS new_enquiry_count`,
        [tenantId]
      ),
    ]);

    const kpi = kpiResult.rows[0] || {};
    const inventory = inventoryResult.rows[0] || {};
    const alerts = alertsResult.rows[0] || {};
    const paidOrders = number(kpi.paid_orders);
    const inventoryAlerts = number(inventory.low_stock) + number(inventory.out_of_stock);
    const attention = [
      number(alerts.reconciliation_count) ? { type: 'RECONCILIATION', count: number(alerts.reconciliation_count), label: 'Payments require reconciliation', href: '/admin/payments?status=REQUIRES_RECONCILIATION' } : null,
      inventoryAlerts ? { type: 'INVENTORY', count: inventoryAlerts, label: 'Products need stock attention', href: '/admin/inventory' } : null,
      number(alerts.new_enquiry_count) ? { type: 'ENQUIRIES', count: number(alerts.new_enquiry_count), label: 'New customer enquiries', href: '/admin/enquiries?status=new' } : null,
    ].filter(Boolean);

    return {
      range: { from, to, timeZone: ADMIN_TIME_ZONE },
      kpis: { revenue: number(kpi.revenue), orders: number(kpi.orders), paidOrders, newCustomers: number(customersResult.rows[0]?.new_customers), averageOrderValue: paidOrders ? number(kpi.revenue) / paidOrders : 0 },
      revenueBreakdown: { subtotal: number(kpi.subtotal), gst: number(kpi.gst), shipping: number(kpi.shipping), totalPaid: number(kpi.revenue) },
      salesTrendGranularity: monthlyTrend ? 'MONTH' : 'DAY',
      salesTrend: salesResult.rows.map((row) => ({ date: row.date, revenue: number(row.revenue), paidOrders: number(row.paid_orders) })),
      orderStatus: orderStatusResult.rows.map((row) => ({ status: row.status, count: number(row.count) })),
      paymentStatus: paymentStatusResult.rows.map((row) => ({ status: row.status, count: number(row.count), paidAmount: number(row.paid_amount) })),
      topProducts: topProductsResult.rows.map((row) => ({ productId: row.product_id, productName: row.product_name || 'Product', imageUrl: row.image_url || null, unitsSold: number(row.units_sold), revenue: number(row.revenue) })),
      inventoryHealth: { threshold, healthy: number(inventory.healthy), lowStock: number(inventory.low_stock), outOfStock: number(inventory.out_of_stock), needsRestocking: inventory.needs_restocking || [] },
      customerSummary: { newCustomers: number(customersResult.rows[0]?.new_customers), totalCustomers: number(customersResult.rows[0]?.total_customers), recentCustomers: customersResult.rows[0]?.recent_customers || [] },
      enquirySummary: enquiriesResult.rows.map((row) => ({ status: row.status, count: number(row.count) })),
      reviewSummary: { reviewCount: number(reviewsResult.rows[0]?.review_count), pendingCount: number(reviewsResult.rows[0]?.pending_count), averageRating: number(reviewsResult.rows[0]?.average_rating) },
      alerts: attention,
      trafficAnalytics: { available: false, reason: 'Website traffic analytics unavailable because visitor and event tracking are not currently persisted.' },
    };
  };
  return { overview };
};

module.exports = { ...createDashboardService(), createDashboardService, resolveRange };
