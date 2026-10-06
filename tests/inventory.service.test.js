const assert = require('node:assert/strict');
const test = require('node:test');
const { createInventoryService } = require('../src/modules/inventory/inventory.service');
const { adjustmentSchema } = require('../src/modules/inventory/inventory.validator');
const { authorize } = require('../src/middleware/auth');

const harness = ({ products = [{ id: 'p1', tenantId: 't1', stock: 5 }], items = [{ id: 'item1', orderId: 'o1', productId: 'p1', quantity: 2, tenantId: 't1' }] } = {}) => {
  const state = { products: products.map((p) => ({ ...p })), items: items.map((item) => ({ ...item })), transactions: [] };
  const query = async (sql, params = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM ORDER_ITEMS oi')) {
      const [tenantId, orderId] = params;
      return { rows: state.items.filter((item) => item.tenantId === tenantId && item.orderId === orderId).sort((a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id)).map((item) => ({ id: item.id, product_id: item.productId, quantity: item.quantity, stock_qty: state.products.find((p) => p.id === item.productId && p.tenantId === tenantId)?.stock })) };
    }
    if (sql.includes('SELECT id FROM INVENTORY_TRANSACTIONS')) return { rows: state.transactions.filter((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]).map((row) => ({ id: row.id })) };
    if (sql.includes('UPDATE PRODUCTS SET stock_qty = $1') && sql.includes("updated_by = 'payment-confirmation'")) {
      const [after, productId, tenantId, before] = params; const product = state.products.find((p) => p.id === productId && p.tenantId === tenantId);
      if (!product || product.stock !== before) return { rows: [] }; product.stock = after; return { rows: [{ stock_qty: after }] };
    }
    if (sql.includes('SELECT id, stock_qty FROM PRODUCTS')) { const product = state.products.find((p) => p.id === params[1] && p.tenantId === params[0]); return { rows: product ? [{ id: product.id, stock_qty: product.stock }] : [] }; }
    if (sql.includes('UPDATE PRODUCTS SET stock_qty = $1')) { const [after, actorId, tenantId, productId] = params; const product = state.products.find((p) => p.id === productId && p.tenantId === tenantId); if (product) { product.stock = after; product.actorId = actorId; } return { rows: [] }; }
    if (sql.includes('INSERT INTO INVENTORY_TRANSACTIONS')) {
      const isSale = sql.includes("'SALE'");
      const row = isSale
        ? { id: params[0], tenant_id: params[1], product_id: params[2], order_id: params[3], order_item_id: params[4], transaction_type: 'SALE', quantity_delta: params[5], before_quantity: params[6], after_quantity: params[7], reason: 'Trusted payment confirmation', actor_type: 'SYSTEM', actor_id: 'payment-confirmation', idempotency_key: params[8], created_at: '2026-10-04T00:00:00.000Z' }
        : { id: params[0], tenant_id: params[1], product_id: params[2], transaction_type: params[3], quantity_delta: params[4], before_quantity: params[5], after_quantity: params[6], reason: params[7], actor_type: params[8], actor_id: params[9], created_at: '2026-10-04T00:00:00.000Z' };
      state.transactions.push(row); return { rows: isSale ? [] : [row] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client };
  return { state, service: createInventoryService({ pool, auditService: { write: async () => ({}) } }), client };
};

test('a paid order deducts each authoritative order-item quantity exactly once and preserves snapshots', async () => {
  const orderItems = [{ id: 'item1', orderId: 'o1', productId: 'p1', quantity: 2, tenantId: 't1' }, { id: 'item2', orderId: 'o1', productId: 'p2', quantity: 3, tenantId: 't1' }];
  const { state, service, client } = harness({ products: [{ id: 'p1', tenantId: 't1', stock: 5 }, { id: 'p2', tenantId: 't1', stock: 4 }], items: orderItems });
  await service.applyPaidOrderSale(client, { tenantId: 't1', orderId: 'o1' });
  await service.applyPaidOrderSale(client, { tenantId: 't1', orderId: 'o1' });
  assert.deepEqual(state.products.map((p) => p.stock), [3, 1]);
  assert.equal(state.transactions.length, 2);
  assert.deepEqual(state.transactions.map((row) => row.quantity_delta), [-2, -3]);
  assert.deepEqual(orderItems.map((item) => item.quantity), [2, 3], 'historical order snapshots are never changed');
});

test('concurrent paid orders cannot drive stock negative and insufficient stock rolls back the losing sale', async () => {
  const { state, service, client } = harness({ products: [{ id: 'p1', tenantId: 't1', stock: 3 }], items: [{ id: 'item1', orderId: 'o1', productId: 'p1', quantity: 2, tenantId: 't1' }, { id: 'item2', orderId: 'o2', productId: 'p1', quantity: 2, tenantId: 't1' }] });
  const result = await Promise.allSettled([service.applyPaidOrderSale(client, { tenantId: 't1', orderId: 'o1' }), service.applyPaidOrderSale(client, { tenantId: 't1', orderId: 'o2' })]);
  assert.equal(result.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.ok(['INVENTORY_INSUFFICIENT_STOCK', 'RESOURCE_CONFLICT'].includes(result.find((entry) => entry.status === 'rejected').reason.errorCode));
  assert.equal(state.products[0].stock, 1);
  assert.equal(state.transactions.length, 1);
});

test('an exhausted product returns the explicit insufficient-stock result without a partial movement', async () => {
  const { state, service, client } = harness({ products: [{ id: 'p1', tenantId: 't1', stock: 3 }], items: [{ id: 'item1', orderId: 'o1', productId: 'p1', quantity: 2, tenantId: 't1' }, { id: 'item2', orderId: 'o2', productId: 'p1', quantity: 2, tenantId: 't1' }] });
  await service.applyPaidOrderSale(client, { tenantId: 't1', orderId: 'o1' });
  await assert.rejects(service.applyPaidOrderSale(client, { tenantId: 't1', orderId: 'o2' }), (error) => error.errorCode === 'INVENTORY_INSUFFICIENT_STOCK');
  assert.equal(state.products[0].stock, 1);
  assert.equal(state.transactions.length, 1);
});

test('admin restock and negative adjustment are ledgered, reason-required, tenant-scoped, and never negative', async () => {
  const { state, service } = harness({ products: [{ id: 'p1', tenantId: 't1', stock: 2 }] });
  assert.ok(adjustmentSchema.validate({ params: { productId: 'p1' }, query: {}, body: { quantityDelta: 1, reason: '' } }).error);
  const restock = await service.adjust({ tenantId: 't1', productId: 'p1', quantityDelta: 10, reason: 'New stock received', actorType: 'ADMIN', actorId: 'staff-1' });
  const damaged = await service.adjust({ tenantId: 't1', productId: 'p1', quantityDelta: -3, reason: 'Damaged piece', actorType: 'SUPPORT', actorId: 'staff-2' });
  assert.equal(restock.availableStock, 12); assert.equal(damaged.availableStock, 9);
  assert.deepEqual(state.transactions.map((row) => [row.transaction_type, row.quantity_delta, row.reason]), [['ADMIN_RESTOCK', 10, 'New stock received'], ['ADMIN_ADJUSTMENT', -3, 'Damaged piece']]);
  await assert.rejects(service.adjust({ tenantId: 't1', productId: 'p1', quantityDelta: -10, reason: 'Too much damage', actorType: 'ADMIN', actorId: 'staff-1' }), (error) => error.errorCode === 'INVENTORY_INSUFFICIENT_STOCK');
  await assert.rejects(service.adjust({ tenantId: 't2', productId: 'p1', quantityDelta: 1, reason: 'Cross tenant', actorType: 'ADMIN', actorId: 'staff-1' }), /Product not found/);
  assert.equal(state.products[0].stock, 9);
});

test('inventory is limited to ADMIN and SUPPORT identities', () => {
  const middleware = authorize({ roles: ['ADMIN', 'SUPPORT'] });
  assert.equal(middleware({ user: { role_code: 'ADMIN' } }, {}, (error) => error), undefined);
  assert.equal(middleware({ user: { role_code: 'SUPPORT' } }, {}, (error) => error), undefined);
  assert.equal(middleware({ user: { role_code: null, customer_id: 'customer-1' } }, {}, (error) => error).statusCode, 403);
});
