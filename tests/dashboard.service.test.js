const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { createDashboardService, resolveRange } = require('../src/modules/dashboard/dashboard.service');

const responses = (sql) => {
  if (sql.includes('reconciliation_count')) return { rows: [{ reconciliation_count: 1, new_enquiry_count: 2 }] };
  if (sql.includes('AS paid_orders') && sql.includes('FROM ORDERS o')) return { rows: [{ orders: 4, paid_orders: 2, revenue: '2400', subtotal: '2000', gst: '300', shipping: '100' }] };
  if (sql.includes('WITH months AS')) return { rows: [{ date: '2026-07-01', revenue: '1200', paid_orders: 1 }, { date: '2026-08-01', revenue: '1200', paid_orders: 1 }] };
  if (sql.includes('WITH days AS')) return { rows: [{ date: '2026-09-01', revenue: '1200', paid_orders: 1 }, { date: '2026-09-02', revenue: '1200', paid_orders: 1 }] };
  if (sql.includes('o.status NOT IN')) return { rows: [{ status: 'CONFIRMED', count: 1 }, { status: 'SHIPPED', count: 2 }] };
  if (sql.includes('paid_amount')) return { rows: [{ status: 'PAID', count: 2, paid_amount: '2400' }, { status: 'FAILED', count: 1, paid_amount: '0' }] };
  if (sql.includes('FROM ORDER_ITEMS oi')) return { rows: [{ product_id: 'p1', product_name: 'Temple Necklace', image_url: 'https://images.example/necklace.jpg', units_sold: 3, revenue: '1800' }] };
  if (sql.includes('AS healthy')) return { rows: [{ healthy: 4, low_stock: 1, out_of_stock: 1, needs_restocking: [{ id: 'p2', name: 'Ear chain', stock_qty: 0 }] }] };
  if (sql.includes('FROM ENQUIRIES e')) return { rows: [{ status: 'new', count: 2 }, { status: 'closed', count: 1 }] };
  if (sql.includes('FROM product_reviews r')) return { rows: [{ review_count: 4, pending_count: 1, average_rating: '4.5' }] };
  if (sql.includes('AS new_customers')) return { rows: [{ new_customers: 2, total_customers: 10, recent_customers: [{ id: 'c1', full_name: 'Customer', email: 'customer@example.com', order_count: 2, paid_value: 2400, created_at: '2026-09-02T00:00:00.000Z' }] }] };
  throw new Error(`Unhandled dashboard query: ${sql}`);
};

test('dashboard overview maps authoritative tenant-scoped aggregates and excludes unsuccessful revenue', async () => {
  const calls = [];
  const service = createDashboardService({ pool: { query: async (sql, params) => { calls.push({ sql, params }); return responses(sql); } }, lowStockThreshold: () => 5 });
  const result = await service.overview('tenant-a', { from: '2026-09-01', to: '2026-09-02' });

  assert.equal(result.kpis.revenue, 2400);
  assert.equal(result.kpis.orders, 4);
  assert.equal(result.kpis.averageOrderValue, 1200);
  assert.deepEqual(result.revenueBreakdown, { subtotal: 2000, gst: 300, shipping: 100, totalPaid: 2400 });
  assert.deepEqual(result.topProducts[0], { productId: 'p1', productName: 'Temple Necklace', imageUrl: 'https://images.example/necklace.jpg', unitsSold: 3, revenue: 1800 });
  assert.equal(result.inventoryHealth.lowStock, 1);
  assert.ok(result.alerts.some((alert) => alert.type === 'RECONCILIATION'));
  assert.equal(result.trafficAnalytics.available, false);
  assert.equal(calls.length, 10);
  assert.ok(calls.every((call) => call.params[0] === 'tenant-a'));
  assert.match(calls[0].sql, /payment_status = 'PAID'/);
});

test('dashboard range defaults to a bounded inclusive Admin calendar window and rejects invalid ranges', () => {
  assert.deepEqual(resolveRange({ from: '2026-09-01', to: '2026-09-01' }), { from: '2026-09-01', to: '2026-09-01' });
  assert.throws(() => resolveRange({ from: '2026-09-03', to: '2026-09-02' }), (error) => error.errorCode === 'INVALID_DATE_RANGE');
  assert.throws(() => resolveRange({ from: '2025-01-01', to: '2026-09-02' }), (error) => error.errorCode === 'INVALID_DATE_RANGE');
});

test('dashboard groups longer selected windows by month', async () => {
  const calls = [];
  const service = createDashboardService({ pool: { query: async (sql, params) => { calls.push(sql); return responses(sql); } }, lowStockThreshold: () => 5 });
  const result = await service.overview('tenant-a', { from: '2026-06-01', to: '2026-09-02' });
  assert.equal(result.salesTrendGranularity, 'MONTH');
  assert.ok(calls.some((sql) => sql.includes('WITH months AS')));
});

test('dashboard API is mounted once and requires Admin or Support authorization', () => {
  const routes = readFileSync(require.resolve('../src/modules/dashboard/dashboard.routes'), 'utf8');
  const app = readFileSync(require.resolve('../src/app'), 'utf8');
  assert.match(routes, /authorize\(\{ roles: \['ADMIN', 'SUPPORT'\] \}\)/);
  assert.match(routes, /router\.get\('\/overview'/);
  assert.match(app, /app\.use\('\/admin\/dashboard', dashboardRoutes\)/);
});
