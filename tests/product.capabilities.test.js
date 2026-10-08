const assert = require('node:assert/strict');
const test = require('node:test');

const { createProductSchema, updateProductSchema } = require('../src/modules/products/product.validator');
const { resolvePublicCapabilities } = require('../src/modules/products/productCapabilities');
const { authorize } = require('../src/middleware/auth');
const fs = require('node:fs');
const path = require('node:path');

const publicProductServiceSource = fs.readFileSync(path.join(__dirname, '../src/modules/products/product.service.js'), 'utf8');
const publicProductControllerSource = fs.readFileSync(path.join(__dirname, '../src/modules/products/product.controller.js'), 'utf8');
const publicProductRoutesSource = fs.readFileSync(path.join(__dirname, '../src/modules/products/product.routes.js'), 'utf8');

test('public product capabilities model buy-only, enquiry-only, both, and neither', () => {
  const buyOnly = resolvePublicCapabilities({ price: 1000, stock_qty: 1, is_purchasable: true, is_enquiry_enabled: false });
  assert.deepEqual(buyOnly, { isPurchasable: true, isEnquiryEnabled: false });

  const enquiryOnly = resolvePublicCapabilities({ price: 1000, stock_qty: 1, is_purchasable: false, is_enquiry_enabled: true });
  assert.deepEqual(enquiryOnly, { isPurchasable: false, isEnquiryEnabled: true });

  const both = resolvePublicCapabilities({ price: 1000, stock_qty: 1, is_purchasable: true, is_enquiry_enabled: true });
  assert.deepEqual(both, { isPurchasable: true, isEnquiryEnabled: true });

  const neither = resolvePublicCapabilities({ price: 1000, stock_qty: 1, is_purchasable: false, is_enquiry_enabled: false });
  assert.deepEqual(neither, { isPurchasable: false, isEnquiryEnabled: false });
});

test('an out-of-stock product is not publicly purchasable even when its commercial switch is enabled', () => {
  assert.deepEqual(resolvePublicCapabilities({ price: 1000, stock_qty: 0, is_purchasable: true, is_enquiry_enabled: true }), { isPurchasable: false, isEnquiryEnabled: true });
});

test('a configured purchase switch is not exposed publicly without a valid selling price', () => {
  assert.deepEqual(
    resolvePublicCapabilities({ price: null, is_purchasable: true, is_enquiry_enabled: true }),
    { isPurchasable: false, isEnquiryEnabled: true }
  );
  assert.deepEqual(
    resolvePublicCapabilities({ price: 0, is_purchasable: true, is_enquiry_enabled: false }),
    { isPurchasable: false, isEnquiryEnabled: false }
  );
});

test('admin product capability fields are validated for create and update', () => {
  const createResult = createProductSchema.validate({
    body: { name: 'Temple Necklace', slug: 'temple-necklace', price: 1250, is_purchasable: true, is_enquiry_enabled: false },
    params: {}, query: {},
  });
  assert.equal(createResult.error, undefined);

  const updateResult = updateProductSchema.validate({
    body: { is_purchasable: 'not-a-boolean' }, params: { productId: 'product-1' }, query: {},
  });
  assert.ok(updateResult.error);
});

test('a customer identity cannot pass the admin capability authorization policy', () => {
  const error = authorize({ roles: ['ADMIN'] })(
    { user: { id: 'auth-customer', customer_id: 'customer-1', staff_user_id: null, role_code: null } },
    {},
    (nextError) => nextError
  );
  assert.equal(error?.statusCode, 403);
});

test('public catalogue output retains tenant-scoped collection context for storefront merchandising', () => {
  assert.match(publicProductServiceSource, /LEFT JOIN collections col\s+ON col\.id = p\.collection_id AND col\.tenant_id = p\.tenant_id/);
  assert.match(publicProductServiceSource, /col\.name AS collection_name/);
  assert.match(publicProductControllerSource, /collection_id: product\.collection_id/);
  assert.match(publicProductControllerSource, /collection_name: product\.collection_name/);
});

test('public product detail uses the canonical tenant-scoped slug and hides non-production records', () => {
  assert.match(publicProductServiceSource, /exports\.getProductBySlug = async \(tenantId, slug\)/);
  assert.match(publicProductServiceSource, /WHERE p\.slug = \$1 AND p\.tenant_id = \$2 AND \$\{PUBLIC_PRODUCT_PREDICATE\}/);
  assert.match(publicProductServiceSource, /p\.is_deleted = false/);
  assert.match(publicProductServiceSource, /p\.is_published = true/);
  assert.match(publicProductServiceSource, /p\.slug ~ '\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$'/);
  assert.match(publicProductServiceSource, /p\.slug !~ '\(\^\|-\)\(abc\|demo\|test\)\(-\|\$\)'/);
  assert.match(publicProductControllerSource, /getPublicProductBySlug/);
  assert.match(publicProductControllerSource, /if \(!product\.is_published\) throw new NotFoundError\('Product'\)/);
  assert.match(publicProductRoutesSource, /\/public\/products\/slug\/:slug/);
});
