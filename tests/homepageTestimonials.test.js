const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const source = (path) => readFileSync(require.resolve(path), 'utf8');

test('testimonial migrations create tenant-scoped settings, polished demo cards, and safe image defaults', () => {
  const migration = source('../migrations/20261012_add_homepage_testimonials.sql');
  const refinement = source('../migrations/20261013_refine_homepage_testimonials.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS HOMEPAGE_TESTIMONIAL_SETTINGS/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS HOMEPAGE_TESTIMONIALS/);
  assert.match(migration, /tenant_id text NOT NULL REFERENCES TENANTS/);
  assert.match(migration, /is_sample boolean NOT NULL DEFAULT false/);
  assert.match(migration, /'Priya'/);
  assert.match(migration, /'Meena'/);
  assert.match(migration, /'Ananya'/);
  assert.doesNotMatch(migration, /Sample customer story/);
  assert.match(migration, /image_fit text NOT NULL DEFAULT 'cover'/);
  assert.match(refinement, /image_position_x integer NOT NULL DEFAULT 50/);
  assert.match(refinement, /image_position_y integer NOT NULL DEFAULT 50/);
  assert.match(migration, /idx_homepage_testimonials_tenant_active_order/);
});

test('testimonial API is tenant scoped, ordered, active-aware, and uses a locked full-list reorder', () => {
  const service = source('../src/modules/products/testimonial.service');
  const routes = source('../src/modules/products/product.routes');
  assert.match(service, /tenant_id=\$1 AND is_active=true ORDER BY display_order ASC, id ASC LIMIT \$2/);
  assert.match(service, /WHERE tenant_id=\$1 ORDER BY display_order ASC FOR UPDATE/);
  assert.match(service, /Reorder request must contain every testimonial exactly once/);
  assert.match(service, /uploadToSupabase\(file, `homepage-testimonials/);
  assert.match(service, /MAX_IMAGE_BYTES/);
  assert.match(service, /MIN_IMAGE_DIMENSION/);
  assert.match(service, /image_position_x/);
  assert.match(routes, /\/admin\/testimonials/);
  assert.match(routes, /\/public\/testimonials/);
});

test('homepage rail supports lazy images, mouse drag, touch scrolling, and reduced motion', () => {
  const rail = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/components/home/Testimonials');
  const admin = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/components/home/TestimonialsManager');
  const card = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/components/home/TestimonialCard');
  const home = source('../../../ecommerce_store_front-main/ecommerce_store_front-main/src/app/page');
  assert.match(rail, /onPointerDown=\{dragStart\}/);
  assert.match(rail, /event\.pointerType !== "mouse"/);
  assert.match(rail, /snap-x snap-mandatory overflow-x-auto/);
  assert.match(card, /loading="lazy"/);
  assert.match(rail, /prefers-reduced-motion/);
  assert.match(card, /rounded-3xl/);
  assert.match(card, /hover:-translate-y-1/);
  assert.match(rail, /min\(25rem/);
  assert.match(home, /<Testimonials showcasePosition \/>/);
  assert.match(admin, /api\.products\.testimonials\.reorder/);
  assert.match(admin, /Demo/);
  assert.match(admin, /Live card preview/);
  assert.match(admin, /400/);
  assert.match(admin, /image_position_x/);
  assert.doesNotMatch(rail, /Sample content/);
  assert.doesNotMatch(rail, /customize these cards in Admin/i);
});
