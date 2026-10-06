const assert = require('node:assert/strict');
const test = require('node:test');
const notifications = require('../src/modules/orders/orderNotification.service');

test('customer and operational notification templates deliberately diverge and use safe deep-link paths', () => {
  const customer = notifications.copyFor({ eventType: 'ORDER_PAID', audience: 'CUSTOMER', orderNumber: 'SGN-100' });
  const admin = notifications.copyFor({ eventType: 'ORDER_PAID', audience: 'ADMIN', orderNumber: 'SGN-100' });
  assert.notDeepEqual(customer, admin);
  assert.equal(notifications.actionFor({ eventType: 'ORDER_SHIPPED', audience: 'CUSTOMER', orderNumber: 'SGN-100' }), '/account/orders/SGN-100');
  assert.equal(notifications.actionFor({ eventType: 'ORDER_SHIPPED', audience: 'ADMIN', orderNumber: 'SGN-100' }), '/admin/orders/SGN-100');
  assert.equal(notifications.actionFor({ eventType: 'PAYMENT_REQUIRES_RECONCILIATION', audience: 'ADMIN', paymentReference: 'pay-1' }), '/admin/payments/pay-1');
  assert.equal(notifications.actionFor({ eventType: 'OUT_OF_STOCK', audience: 'SUPPORT', productId: 'product-1' }), '/admin/inventory?productId=product-1');
});

test('premium email layout is HTML-safe and includes a plain-text fallback without secrets', () => {
  const message = notifications.emailLayout({ brandName: 'Demo Store', logo: 'https://assets.example/sagunthala-logo.png', title: 'Your jewellery is on the way', message: '<private>', actionUrl: 'https://shop.example/account/orders/SGN-1', actionLabel: 'View your order', order: { order_number: 'SGN-1', total_amount: 1234, tracking_number: 'TRACK-1', tracking_url: 'https://courier.example/track/1' }, items: [{ product_name: 'Gold, "Temple"', quantity: 1, image_url: 'https://cdn.example/products/temple.jpg' }] });
  assert.match(message.html, /&lt;private&gt;/);
  assert.match(message.html, /Gold, &quot;Temple&quot;/);
  assert.match(message.text, /View your order/);
  assert.match(message.html, /background:#faf8f4/);
  assert.match(message.html, /Sagunthala Dance Jewellers/);
  assert.doesNotMatch(message.html, /Demo Store/);
  assert.match(message.html, /https:\/\/assets\.example\/sagunthala-logo\.png/);
  assert.match(message.html, /https:\/\/cdn\.example\/products\/temple\.jpg/);
  assert.match(message.html, /Track your shipment/);
  assert.match(message.html, /https:\/\/courier\.example\/track\/1/);
  assert.doesNotMatch(message.html, /password|razorpay_signature|refresh_token/i);
});

test('email media rejects local and non-HTTPS URLs while a tracking number without a URL remains plain text', () => {
  const message = notifications.emailLayout({ title: 'Update', message: 'Message', order: { order_number: 'SGN-2', total_amount: 10, tracking_number: 'TRACK-2', tracking_url: 'file:///private/track' }, items: [{ product_name: 'Piece', quantity: 1, image_url: 'http://localhost:3000/private.jpg' }] });
  assert.doesNotMatch(message.html, /localhost|file:\/\/\/private/);
  assert.match(message.html, /Tracking: TRACK-2/);
  assert.doesNotMatch(message.html, /Track your shipment/);
});

test('customer-facing template never emits demo tenant names and uses the Sagunthala fallback', () => {
  assert.equal(notifications.displayBrandName('Demo Store', 'Demo Tenant'), 'Sagunthala Dance Jewellers');
  assert.equal(notifications.displayBrandName('Sagunthala Dance Jewellers'), 'Sagunthala Dance Jewellers');
});

test('notification email recipients keep customers distinct from the configured Admin inbox', () => {
  const previous = process.env.ADMIN_NOTIFICATION_EMAIL;
  try {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'sagunthalajewellers@gmail.com';
    assert.equal(notifications.recipientFor({ audience_type: 'CUSTOMER', customer_email: 'customer@example.com', staff_email: 'staff@example.com' }), 'customer@example.com');
    assert.equal(notifications.recipientFor({ audience_type: 'ADMIN', customer_email: 'customer@example.com', staff_email: 'staff@example.com' }), 'sagunthalajewellers@gmail.com');
    assert.notEqual(
      notifications.recipientFor({ audience_type: 'CUSTOMER', customer_email: 'customer@example.com' }),
      notifications.recipientFor({ audience_type: 'ADMIN', staff_email: 'staff@example.com' }),
    );
  } finally {
    if (previous === undefined) delete process.env.ADMIN_NOTIFICATION_EMAIL;
    else process.env.ADMIN_NOTIFICATION_EMAIL = previous;
  }
});

test('an Admin delivery without explicit configuration fails closed and never falls back to SMTP sender settings', () => {
  const previous = process.env.ADMIN_NOTIFICATION_EMAIL;
  const previousUser = process.env.SMTP_USER; const previousFrom = process.env.SMTP_FROM;
  try {
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
    process.env.SMTP_USER = 'smtp-user@example.com'; process.env.SMTP_FROM = 'sender@example.com';
    assert.throws(() => notifications.recipientFor({ audience_type: 'ADMIN', staff_email: 'staff@example.com' }), (error) => error.code === 'NOTIFICATION_RECIPIENT_NOT_CONFIGURED');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_NOTIFICATION_EMAIL;
    else process.env.ADMIN_NOTIFICATION_EMAIL = previous;
    if (previousUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousUser;
    if (previousFrom === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = previousFrom;
  }
});

test('stale PROCESSING deliveries become retryable with bounded backoff using the durable outbox fields', async () => {
  const statements = [];
  const client = {
    async query(sql, parameters) {
      statements.push({ sql, parameters });
      return { rows: [] };
    },
    release() {},
  };
  const previous = {
    max: process.env.NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
    base: process.env.NOTIFICATION_DELIVERY_RETRY_BASE_SECONDS,
    ceiling: process.env.NOTIFICATION_DELIVERY_RETRY_MAX_SECONDS,
    stale: process.env.NOTIFICATION_DELIVERY_STALE_PROCESSING_SECONDS,
  };
  try {
    process.env.NOTIFICATION_DELIVERY_MAX_ATTEMPTS = '3';
    process.env.NOTIFICATION_DELIVERY_RETRY_BASE_SECONDS = '15';
    process.env.NOTIFICATION_DELIVERY_RETRY_MAX_SECONDS = '60';
    process.env.NOTIFICATION_DELIVERY_STALE_PROCESSING_SECONDS = '120';
    assert.deepEqual(notifications.deliveryRetryPolicy(), { maxAttempts: 3, baseDelaySeconds: 15, maxDelaySeconds: 60, staleProcessingSeconds: 120 });
    const delivery = await notifications.claimNext({ tenantId: 'tenant-1', entityId: 'order-1', database: { connect: async () => client } });
    assert.equal(delivery, null);
    const claim = statements.find(({ sql }) => sql.includes('FROM NOTIFICATION_DELIVERIES'));
    assert.match(claim.sql, /d\.status='PROCESSING'/);
    assert.match(claim.sql, /d\.attempts < \$3/);
    assert.match(claim.sql, /power\(2, GREATEST\(d\.attempts - 1, 0\)\)/);
    assert.deepEqual(claim.parameters, ['tenant-1', 'order-1', 3, 15, 60, 120]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = ({ max: 'NOTIFICATION_DELIVERY_MAX_ATTEMPTS', base: 'NOTIFICATION_DELIVERY_RETRY_BASE_SECONDS', ceiling: 'NOTIFICATION_DELIVERY_RETRY_MAX_SECONDS', stale: 'NOTIFICATION_DELIVERY_STALE_PROCESSING_SECONDS' })[key];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
