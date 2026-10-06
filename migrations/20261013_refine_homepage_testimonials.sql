ALTER TABLE HOMEPAGE_TESTIMONIALS
  ADD COLUMN IF NOT EXISTS image_fit text NOT NULL DEFAULT 'cover' CHECK (image_fit IN ('cover', 'contain')),
  ADD COLUMN IF NOT EXISTS image_position_x integer NOT NULL DEFAULT 50 CHECK (image_position_x BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS image_position_y integer NOT NULL DEFAULT 50 CHECK (image_position_y BETWEEN 0 AND 100);

UPDATE HOMEPAGE_TESTIMONIAL_SETTINGS
SET subheading = 'Discover jewellery inspiration for every stage and celebration.', updated_at = now()
WHERE subheading LIKE 'Sample customer-story placeholders%';

WITH defaults(display_order, customer_name, customer_context, content) AS (
  VALUES
    (0, 'Priya', 'Parent of a Bharatanatyam student', 'The jewellery styling complemented the costume beautifully and was easy to coordinate for the performance.'),
    (1, 'Meena', 'Classical dance performer', 'The collection was easy to browse and helped me quickly find pieces that suited the stage look I had in mind.'),
    (2, 'Ananya', 'Dance student', 'I liked being able to compare different jewellery styles before choosing the pieces for my performance.'),
    (3, 'Kavya', 'Family celebration', 'I found it helpful to see different designs together while planning the jewellery styling for our family celebration.'),
    (4, 'Lakshmi', 'Dance teacher', 'The styles gave our class a clear starting point when we were discussing jewellery for the recital.')
)
UPDATE HOMEPAGE_TESTIMONIALS testimonial
SET customer_name = defaults.customer_name,
    customer_context = defaults.customer_context,
    content = defaults.content,
    rating = NULL,
    updated_at = now()
FROM defaults
WHERE testimonial.is_sample = true
  AND testimonial.display_order = defaults.display_order
  AND testimonial.customer_name LIKE 'Sample customer story%';
