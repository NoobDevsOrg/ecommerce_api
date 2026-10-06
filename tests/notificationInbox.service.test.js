const assert = require('node:assert/strict');
const test = require('node:test');

const pool = require('../src/config/db');
const inbox = require('../src/modules/notifications/notification.service');

test('Admin unread counts are constrained to the active tenant and staff recipient', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('read_at IS NULL')) return { rows: [{ total: '2' }] };
    if (sql.includes('LIMIT')) return { rows: [{ id: 'notification-a', event_type: 'ORDER_PAID', title: 'Paid', message: 'Order paid', action_url: null, read_at: null, created_at: '2026-09-27T12:00:00.000Z' }] };
    return { rows: [{ total: '4' }] };
  };
  try {
    const result = await inbox.list({ tenantId: 'tenant-a', audience: 'ADMIN', user: { staff_user_id: 'staff-a' }, page: 1, limit: 20 });
    assert.equal(result.unreadCount, 2);
    assert.equal(result.pagination.total, 4);
    assert.equal(result.notifications[0].id, 'notification-a');
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.match(call.sql, /n\.tenant_id=\$1/);
      assert.match(call.sql, /n\.audience_type IN \('ADMIN','SUPPORT'\) AND n\.staff_id=\$2/);
      assert.deepEqual(call.values.slice(0, 2), ['tenant-a', 'staff-a']);
    }
  } finally {
    pool.query = originalQuery;
  }
});

test('customer mark-all-read is scoped to the active tenant and customer identity', async () => {
  const originalQuery = pool.query;
  let call;
  pool.query = async (sql, values) => {
    call = { sql, values };
    return { rowCount: 3 };
  };
  try {
    assert.deepEqual(
      await inbox.markAllRead({ tenantId: 'tenant-a', audience: 'CUSTOMER', user: { customer_id: 'customer-a' } }),
      { markedRead: 3 },
    );
    assert.match(call.sql, /n\.tenant_id=\$1/);
    assert.match(call.sql, /n\.audience_type='CUSTOMER' AND n\.customer_id=\$2/);
    assert.deepEqual(call.values, ['tenant-a', 'customer-a']);
  } finally {
    pool.query = originalQuery;
  }
});
