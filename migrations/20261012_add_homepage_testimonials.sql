CREATE TABLE IF NOT EXISTS HOMEPAGE_TESTIMONIAL_SETTINGS (
  tenant_id text PRIMARY KEY REFERENCES TENANTS(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  heading text NOT NULL DEFAULT 'Loved by dancers and families',
  subheading text NOT NULL DEFAULT 'Discover jewellery inspiration for every stage and celebration.',
  max_cards integer NOT NULL DEFAULT 5 CHECK (max_cards BETWEEN 1 AND 20),
  card_size text NOT NULL DEFAULT 'standard' CHECK (card_size IN ('compact', 'standard', 'large')),
  spacing text NOT NULL DEFAULT 'standard' CHECK (spacing IN ('compact', 'standard', 'relaxed')),
  desktop_visible_count numeric NOT NULL DEFAULT 3 CHECK (desktop_visible_count IN (2, 3, 4)),
  tablet_visible_count numeric NOT NULL DEFAULT 2 CHECK (tablet_visible_count IN (1, 1.2, 2, 3)),
  mobile_visible_count numeric NOT NULL DEFAULT 1.2 CHECK (mobile_visible_count IN (1, 1.2, 2)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS HOMEPAGE_TESTIMONIALS (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES TENANTS(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_context text,
  content text NOT NULL,
  image_url text,
  image_storage_path text,
  image_fit text NOT NULL DEFAULT 'cover' CHECK (image_fit IN ('cover', 'contain')),
  image_position_x integer NOT NULL DEFAULT 50 CHECK (image_position_x BETWEEN 0 AND 100),
  image_position_y integer NOT NULL DEFAULT 50 CHECK (image_position_y BETWEEN 0 AND 100),
  rating integer CHECK (rating BETWEEN 1 AND 5),
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_homepage_testimonials_tenant_active_order
  ON HOMEPAGE_TESTIMONIALS(tenant_id, is_active, display_order ASC, id ASC);

INSERT INTO HOMEPAGE_TESTIMONIAL_SETTINGS (tenant_id)
SELECT id FROM TENANTS
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO HOMEPAGE_TESTIMONIALS (id, tenant_id, customer_name, customer_context, content, rating, display_order, is_active, is_sample)
SELECT md5(t.id || ':homepage-testimonial:' || sample.display_order::text), t.id, sample.customer_name, sample.customer_context, sample.content, NULL, sample.display_order, true, true
FROM TENANTS t
CROSS JOIN (VALUES
  (0, 'Priya', 'Parent of a Bharatanatyam student', 'The jewellery styling complemented the costume beautifully and was easy to coordinate for the performance.'),
  (1, 'Meena', 'Classical dance performer', 'The collection was easy to browse and helped me quickly find pieces that suited the stage look I had in mind.'),
  (2, 'Ananya', 'Dance student', 'I liked being able to compare different jewellery styles before choosing the pieces for my performance.'),
  (3, 'Kavya', 'Family celebration', 'I found it helpful to see different designs together while planning the jewellery styling for our family celebration.'),
  (4, 'Lakshmi', 'Dance teacher', 'The styles gave our class a clear starting point when we were discussing jewellery for the recital.')
) AS sample(display_order, customer_name, customer_context, content)
ON CONFLICT (id) DO NOTHING;
