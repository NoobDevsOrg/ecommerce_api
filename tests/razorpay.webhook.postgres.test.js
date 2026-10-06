const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');

// This suite intentionally requires an explicitly supplied, disposable database.
// It never falls back to DATABASE_URL, which might be a developer or deployment
// database. Provision the schema plus all migrations, then run:
// WEBHOOK_TEST_DATABASE_URL=postgresql://... node --test tests/razorpay.webhook.postgres.test.js
const testDatabaseUrl = process.env.WEBHOOK_TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  test('PostgreSQL webhook replay and callback race suite', { skip: 'WEBHOOK_TEST_DATABASE_URL is not configured' }, () => {});
} else {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DB_SSL = 'false';

  const database = require('../src/config/db');
  const repository = require('../src/modules/payments/payment.repository');
  const { createPaymentService } = require('../src/modules/payments/payment.service');
  const { createInventoryService } = require('../src/modules/inventory/inventory.service');

  const ids = () => ({
    tenantId: `webhook-test-${crypto.randomUUID()}`,
    customerId: crypto.randomUUID(), staffId: crypto.randomUUID(), roleId: crypto.randomUUID(),
    productId: crypto.randomUUID(), orderId: crypto.randomUUID(), itemId: crypto.randomUUID(), paymentId: crypto.randomUUID(),
    providerOrderId: `order_${crypto.randomUUID().replaceAll('-', '')}`,
    providerPaymentId: `pay_${crypto.randomUUID().replaceAll('-', '')}`,
  });

  const cleanup = async (fixture) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM PAYMENT_WEBHOOK_EVENTS WHERE provider_order_id = $1', [fixture.providerOrderId]);
      await client.query('DELETE FROM PAYMENT_ATTEMPT_EVENTS WHERE payment_id = $1', [fixture.paymentId]);
      await client.query('DELETE FROM INVENTORY_TRANSACTIONS WHERE order_id = $1', [fixture.orderId]);
      await client.query('DELETE FROM NOTIFICATION_DELIVERIES WHERE tenant_id = $1', [fixture.tenantId]);
      await client.query('DELETE FROM NOTIFICATIONS WHERE tenant_id = $1', [fixture.tenantId]);
      await client.query('DELETE FROM PAYMENTS WHERE id = $1', [fixture.paymentId]);
      await client.query('DELETE FROM ORDER_ITEMS WHERE order_id = $1', [fixture.orderId]);
      await client.query('DELETE FROM ORDERS WHERE id = $1', [fixture.orderId]);
      await client.query('DELETE FROM PRODUCTS WHERE id = $1', [fixture.productId]);
      await client.query('DELETE FROM STAFF_USERS WHERE id = $1', [fixture.staffId]);
      await client.query('DELETE FROM ROLES WHERE id = $1', [fixture.roleId]);
      await client.query('DELETE FROM CUSTOMERS WHERE id = $1', [fixture.customerId]);
      await client.query('DELETE FROM TENANTS WHERE id = $1', [fixture.tenantId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };

  const seed = async (fixture) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO TENANTS (id,name,slug,currency) VALUES ($1,'Webhook Test','webhook-${fixture.tenantId}','INR')`, [fixture.tenantId]);
      await client.query(`INSERT INTO CUSTOMERS (id,tenant_id,email,full_name,phone) VALUES ($1,$2,$3,'Webhook Customer','9999999999')`, [fixture.customerId, fixture.tenantId, `${fixture.customerId}@example.test`]);
      await client.query(`INSERT INTO ROLES (id,tenant_id,code,label) VALUES ($1,$2,'ADMIN','Admin')`, [fixture.roleId, fixture.tenantId]);
      await client.query(`INSERT INTO STAFF_USERS (id,tenant_id,role_id,email,full_name,is_active) VALUES ($1,$2,$3,$4,'Webhook Admin',true)`, [fixture.staffId, fixture.tenantId, fixture.roleId, `${fixture.staffId}@example.test`]);
      await client.query(`INSERT INTO PRODUCTS (id,tenant_id,name,slug,sku,price,stock_qty,is_published,is_purchasable) VALUES ($1,$2,'Webhook Product',$3,$4,125.75,2,true,true)`, [fixture.productId, fixture.tenantId, `webhook-${fixture.productId}`, `WEBHOOK-${fixture.productId}`]);
      await client.query(`INSERT INTO ORDERS (id,tenant_id,customer_id,order_number,status,payment_status,total_amount,currency) VALUES ($1,$2,$3,$4,'CONFIRMED','PENDING',125.75,'INR')`, [fixture.orderId, fixture.tenantId, fixture.customerId, `SGN-${fixture.orderId.slice(0, 8)}`]);
      await client.query(`INSERT INTO ORDER_ITEMS (id,tenant_id,order_id,product_id,product_name,product_sku,unit_price,quantity) VALUES ($1,$2,$3,$4,'Webhook Product',$5,125.75,1)`, [fixture.itemId, fixture.tenantId, fixture.orderId, fixture.productId, `WEBHOOK-${fixture.productId}`]);
      await client.query(`INSERT INTO PAYMENTS (id,tenant_id,order_id,gateway,razorpay_order_id,status,amount,currency) VALUES ($1,$2,$3,'RAZORPAY',$4,'CREATED',125.75,'INR')`, [fixture.paymentId, fixture.tenantId, fixture.orderId, fixture.providerOrderId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };

  test('PostgreSQL replay and every callback/webhook ordering create one payment, sale, and logical notification set', async (t) => {
    t.after(async () => { await database.end(); });
    const runCase = async (name, execute) => {
      const fixture = ids();
      await seed(fixture);
      try {
        const inventory = createInventoryService({ pool: database, auditService: { write: async () => ({}) } });
        const service = createPaymentService({
          repository, inventory, auditService: { write: async () => ({}) }, notifications: { dispatchSafely: () => {} },
          integrations: { getRazorpayConfiguration: async () => ({ mode: 'TEST' }) },
          provider: {
            verifyPaymentSignature: () => true,
            fetchPayment: async () => ({ id: fixture.providerPaymentId, order_id: fixture.providerOrderId, amount: 12575, currency: 'INR', status: 'captured', method: 'upi' }),
            verifyWebhookSignature: ({ signature }) => signature === 'valid',
          },
        });
        const callback = () => service.verifyRazorpayCallback({ tenantId: fixture.tenantId, customerId: fixture.customerId, orderReference: fixture.orderId, razorpayOrderId: fixture.providerOrderId, razorpayPaymentId: fixture.providerPaymentId, razorpaySignature: 'browser-valid' });
        const rawWebhook = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
          id: fixture.providerPaymentId, order_id: fixture.providerOrderId, amount: 12575, currency: 'INR', method: 'upi', status: 'captured',
        } } } }));
        const webhook = (eventId) => service.handleRazorpayWebhook({ rawBody: rawWebhook, signature: 'valid', eventId });
        await execute({ callback, webhook });

        const [payment, order, events, sales, stock, notifications, reconciliations] = await Promise.all([
          database.query('SELECT COUNT(*)::int AS count, MAX(status) AS status FROM PAYMENTS WHERE order_id=$1', [fixture.orderId]),
          database.query('SELECT COUNT(*)::int AS count, MAX(payment_status) AS status FROM ORDERS WHERE id=$1', [fixture.orderId]),
          database.query('SELECT COUNT(*)::int AS count FROM PAYMENT_WEBHOOK_EVENTS WHERE provider_order_id=$1', [fixture.providerOrderId]),
          database.query(`SELECT COUNT(*)::int AS count FROM INVENTORY_TRANSACTIONS WHERE order_item_id=$1 AND transaction_type='SALE'`, [fixture.itemId]),
          database.query('SELECT stock_qty FROM PRODUCTS WHERE id=$1', [fixture.productId]),
          database.query(`SELECT COUNT(*)::int AS recipients, COUNT(DISTINCT event_type)::int AS logical_events FROM NOTIFICATIONS WHERE tenant_id=$1 AND entity_id=$2 AND event_type='ORDER_PAID'`, [fixture.tenantId, fixture.orderId]),
          database.query('SELECT COUNT(*)::int AS count FROM PAYMENT_RECONCILIATIONS WHERE payment_id=$1', [fixture.paymentId]),
        ]);
        assert.equal(payment.rows[0].count, 1, `${name}: payment row count`);
        assert.equal(payment.rows[0].status, 'PAID', `${name}: payment status`);
        assert.equal(order.rows[0].count, 1, `${name}: order row count`);
        assert.equal(order.rows[0].status, 'PAID', `${name}: order status`);
        assert.equal(events.rows[0].count, 1, `${name}: durable event claim count`);
        assert.equal(sales.rows[0].count, 1, `${name}: sale count`);
        assert.equal(stock.rows[0].stock_qty, 1, `${name}: final stock`);
        assert.equal(notifications.rows[0].logical_events, 1, `${name}: logical paid notifications`);
        assert.equal(notifications.rows[0].recipients, 2, `${name}: notification recipients`);
        assert.equal(reconciliations.rows[0].count, 0, `${name}: reconciliation cases`);
      } finally {
        await cleanup(fixture);
      }
    };

    await runCase('callback first, webhook second', async ({ callback, webhook }) => { await callback(); await webhook('evt_callback_first'); });
    await runCase('webhook first, callback second', async ({ callback, webhook }) => { await webhook('evt_webhook_first'); await callback(); });
    await runCase('callback and webhook concurrently', async ({ callback, webhook }) => { await Promise.all([callback(), webhook('evt_concurrent')]); });
    await runCase('duplicate webhook replay', async ({ webhook }) => { await webhook('evt_replay'); await webhook('evt_replay'); });
  });
}
