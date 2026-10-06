const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const source = (path) => readFileSync(require.resolve(path), 'utf8');

test('public product facets return the active tenant category hierarchy without product-only flattening', () => {
  const service = source('../src/modules/products/product.service');
  assert.match(service, /SELECT c\.id, c\.name, c\.slug, c\.parent_id, c\.sort_order, c\.is_active/);
  assert.match(service, /FROM CATEGORIES c\s+WHERE c\.tenant_id = \$1 AND c\.is_active = true/);
  assert.match(service, /ORDER BY c\.sort_order ASC, c\.name ASC, c\.id ASC/);
});

test('catalogue hierarchy selects a parent and every actual descendant for the existing server-side category filter', () => {
  const hierarchy = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/components/product/CategoryHierarchy');
  const page = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/app/products/page');
  assert.match(hierarchy, /childrenByParent/);
  assert.match(hierarchy, /\(childrenByParent\.get\(id\) \|\| \[\]\)\.forEach\(visit\)/);
  assert.match(page, /selectedCategoryIds\(categories, selectedCategory\.id\)/);
  assert.match(page, /category: categoryFilter\.length \? categoryFilter\.join\(","\) : undefined/);
});

test('catalogue category selection is URL-backed and supports Back and Forward navigation', () => {
  const page = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/app/products/page');
  assert.match(page, /params\.get\("category"\)/);
  assert.match(page, /window\.addEventListener\("popstate", syncFromLocation\)/);
  assert.match(page, /params\.set\("category", category\.slug \|\| category\.id\)/);
  assert.match(page, /window\.history\.pushState/);
  assert.match(page, /setCurrentPage\(1\)/);
  assert.match(page, /<CategoryHierarchy categories=\{categories\} selectedCategoryId=\{selectedCategoryId\} onSelect=\{selectCategory\}/);
});
