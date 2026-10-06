const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');

const source = (path) => readFileSync(require.resolve(path), 'utf8');

test('admin order and payment lists load historical item images in one bulk, tenant-scoped query', () => {
  for (const path of ['../src/modules/orders/adminOrder.service', '../src/modules/payments/adminPayment.service']) {
    const service = source(path);
    assert.match(service, /FROM ORDER_ITEMS oi/);
    assert.match(service, /oi\.tenant_id = \$1 AND oi\.order_id = ANY\(\$2::text\[\]\)/);
    assert.match(service, /oi\.image_url/);
    assert.match(service, /SUM\(oi\.quantity\)::int AS quantity/);
    assert.match(service, /items: row\.item_summaries \|\| \[\]/);
  }
  assert.match(source('../src/modules/orders/adminOrder.service'), /listItemSummaries\(tenantId, rows\.rows\.map\(\(row\) => row\.id\)\)/);
  assert.match(source('../src/modules/payments/adminPayment.service'), /listItemSummaries\(tenantId, \[\.\.\.new Set\(rows\.rows\.map\(\(row\) => row\.order_id\)\)\]\)/);
});

test('inventory list obtains only the current tenant-scoped primary catalog image', () => {
  const service = source('../src/modules/inventory/inventory.service');
  assert.match(service, /LEFT JOIN LATERAL \(/);
  assert.match(service, /FROM PRODUCT_IMAGES pi/);
  assert.match(service, /pi\.tenant_id = p\.tenant_id AND pi\.product_id = p\.id/);
  assert.match(service, /ORDER BY pi\.is_primary DESC, pi\.sort_order ASC, pi\.id ASC LIMIT 1/);
  assert.match(service, /imageUrl: row\.image_url \|\| null/);
});

test('admin tables keep images in their existing cells with lazy compact fallbacks', () => {
  const tableImages = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/components/admin/TableProductImages');
  const orders = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/app/admin/orders/page');
  const payments = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/app/admin/payments/page');
  const inventory = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/app/admin/inventory/page');

  assert.match(tableImages, /loading="lazy"/);
  assert.match(tableImages, /object-cover/);
  assert.match(tableImages, /h-10 w-10[\s\S]*sm:h-11 sm:w-11/);
  assert.match(tableImages, /visibleProducts = products\.slice\(0, 2\)/);
  assert.match(orders, /<TableProductImageStack items=\{order\.items\}/);
  assert.match(payments, /<TableProductImageStack items=\{payment\.items\}/);
  assert.match(inventory, /<TableProductThumbnail src=\{product\.imageUrl\}/);
});
