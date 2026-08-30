const pool = require('../../config/db');
const { v4: uuidv4 } = require('uuid');
const Logger = require('../../utils/logger');
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');
const { uploadToSupabase } = require('../../services/uploadService');
const { supabase } = require('../../config/supabase');
const crypto = require("crypto");
// const { sendAdminEmail, sendUserEmail } = require("../services/email.service");

const ALLOWED_SORT_COLUMNS = new Set(['created_at', 'name', 'price']);
const ALLOWED_SORT_ORDERS = new Set(['asc', 'desc']);

// Maps the storefront's single `sort` query value to an actual column/order.
// NOTE: `rating` and `popularity` fall back to `created_at DESC` because the
// schema currently has no rating/review_count column or reviews table. Once
// a review aggregate exists, point these at it instead of newest-first.
const PUBLIC_SORT_MAP = {
  'newest': { column: 'p.created_at', order: 'DESC' },
  'price-asc': { column: 'p.price', order: 'ASC' },
  'price-desc': { column: 'p.price', order: 'DESC' },
  'name-asc': { column: 'p.name', order: 'ASC' },
  'name-desc': { column: 'p.name', order: 'DESC' },
  'rating': { column: 'p.created_at', order: 'DESC' },
  'popularity': { column: 'p.created_at', order: 'DESC' },
};

exports.createProduct = async (tenantId, productData, imageFiles = []) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productId = uuidv4();
    const {
      name,
      slug,
      sku,
      description,
      price,
      compare_price,
      stock_qty,
      category_id,
      collection_id,
      is_published,
      is_featured,
      is_best_sell,
      tags,
      attributes,
      meta_title,
      meta_desc,
    } = productData;

    // Auto-generate SKU from slug when the frontend omits it.
    // Guards:
    //   - sku may be undefined, null, or "" (FormData sends "" for empty fields)
    //   - slug is always present (validated by Joi before we reach here)
    //   - Math.random() can be 0, making toString(16) = "0" with only 1 char after "0."
    //     so we pad with a second random call to guarantee 4 chars.
    const skuBase = String(slug || '')
      .toUpperCase()
      .replace(/-/g, '_')
      .substring(0, 20);

    const skuSuffix = uuidv4().slice(0, 6).toUpperCase();

    const generatedSku = (sku && String(sku).trim())
      ? String(sku).trim()
      : `${skuBase}_${skuSuffix}`;
    // Validate category exists if provided
    if (category_id) {
      const categoryResult = await client.query(
        'SELECT id FROM CATEGORIES WHERE id = $1 OR tenant_id = $2',
        [category_id, tenantId]
      );
      if (categoryResult.rows.length === 0) {
        throw new NotFoundError('Category');
      }
    }

    // Validate collection exists if provided
    if (collection_id) {
      const collectionResult = await client.query(
        'SELECT id FROM COLLECTIONS WHERE id = $1 AND tenant_id = $2',
        [collection_id, tenantId]
      );
      if (collectionResult.rows.length === 0) {
        throw new NotFoundError('Collection');
      }
    }

    // Insert product
    const productResult = await client.query(
      `INSERT INTO PRODUCTS (
        id, tenant_id, category_id, collection_id, name, slug, sku,
        description, price, compare_price, stock_qty, is_published,
        is_featured,is_best_sell, tags, attributes, meta_title, meta_desc, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      ) RETURNING *`,
      [
        productId,
        tenantId,
        category_id || null,
        collection_id || null,
        name,
        slug,
        generatedSku,
        description || null,
        price || null,
        compare_price || null,
        stock_qty || 0,
        is_published || false,
        is_featured || false,
        is_best_sell || false,
        tags || null,
        attributes || null,
        meta_title || null,
        meta_desc || null,
        'system',
      ]
    );

    const product = productResult.rows[0];

    // Handle image uploads (Supabase)
    if (imageFiles && imageFiles.length > 0) {
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        const imageId = uuidv4();

        try {
          const { url, path: storagePath } = await uploadToSupabase(
            file,
            `products/${tenantId}/${productId}`
          );

          await client.query(
            `INSERT INTO PRODUCT_IMAGES (
              id, tenant_id, product_id, base_url, storage_path, is_primary, sort_order, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              imageId,
              tenantId,
              productId,
              url,
              storagePath,
              i === 0,
              i,
              'system',
            ]
          );

          Logger.info('Image uploaded (Supabase)', { imageId, productId });
        } catch (error) {
          Logger.error('Supabase upload failed', { message: error.message });
          throw error;
        }
      }
    }

    await client.query('COMMIT');

    Logger.info('Product created', { productId, slug, tenantId });

    return exports.getProductById(tenantId, productId);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      throw new ConflictError('Product slug or SKU already exists');
    }
    Logger.error('Create product error', {
      message: error.message,
      slug: productData.slug,
    });
    throw error;
  } finally {
    client.release();
  }
};

exports.processEnquiry = async (enquiryData) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const enquiryId = uuidv4();

    const {
      name,
      email,
      phone,
      message,
      products,
      whatsapp_number,
      tenant_id,
    } = enquiryData;

    console.log("Processing enquiry", enquiryData);

    // 🔹 Insert enquiry
    const result = await client.query(
      `INSERT INTO ENQUIRIES (
    id,
    name,
    email,
    phone,
    whatsapp_number,
    message,
    tenant_id,
    created_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,NOW()
  )
  RETURNING *`,
      [
        enquiryId,
        name,
        email,
        phone,
        whatsapp_number || null,
        message || null,
        tenant_id || null,
      ]
    );

    const enquiry = result.rows[0];

    // Insert selected products
    for (const item of products) {
      await client.query(
        `INSERT INTO enquiry_products (
      id,
      enquiry_id,
      product_id,
      quantity,
      tenant_id,
      created_by,
      updated_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          uuidv4(),
          enquiryId,
          item.product_id,
          item.quantity || 1,
          enquiryData.tenant_id || null,
          "system",
          "system",
        ]
      );
    }

    // 🔹 Send emails (non-blocking optional)
    // try {
    //   // await Promise.all([
    //   //   sendAdminEmail(enquiry),
    //   //   sendUserEmail(enquiry),
    //   // ]);
    // } catch (emailError) {
    //   // Don't fail enquiry if email fails
    //   Logger.error("Email sending failed", {
    //     enquiryId,
    //     message: emailError.message,
    //   });
    // }

    await client.query("COMMIT");

    Logger.info("Enquiry created", {
      enquiryId,
      productCount: products.length,
      email,
    });

    return enquiry;

  } catch (error) {
    await client.query("ROLLBACK");

    Logger.error("Create enquiry error", {
      message: error.message,
      email: enquiryData?.email,
    });

    throw error;
  } finally {
    client.release();
  }
};

exports.getProductList = async (tenantId, filters = {}) => {
  // console.log("filters", filters);

  try {
    const { whereClause, values, nextIndex } =
      extractFilters(tenantId, filters);

    //COUNT
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM PRODUCTS p
       WHERE ${whereClause}`,
      values
    );

    const total = countResult.rows[0]?.total || 0;

    const sortBy = ALLOWED_SORT_COLUMNS.has(filters.sort_by)
      ? filters.sort_by
      : "created_at";

    const sortOrder = ALLOWED_SORT_ORDERS.has(
      String(filters.sort_order || "").toLowerCase()
    )
      ? filters.sort_order.toUpperCase()
      : "DESC";

    //pagination
    const limit = Number(filters.limit || 20);
    const page = Number(filters.page || 1);
    const offset = (page - 1) * limit;

    // MAIN QUERY
    const query = `
      SELECT 
        p.*,
        c.name AS category_name,
COALESCE(ROUND(AVG(pr.rating), 1), 0) AS average_rating,
COUNT(DISTINCT pr.id) AS review_count,
        MAX(pi.base_url) FILTER (WHERE pi.is_primary = true) AS primary_image_url,

        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', pi.id,
            'url', pi.base_url,
            'is_primary', pi.is_primary,
            'is_featured', p.is_featured,
            'is_best_sell', p.is_best_sell
          )
        ) FILTER (WHERE pi.id IS NOT NULL) AS image_urls

      FROM PRODUCTS p
LEFT JOIN CATEGORIES c
    ON p.category_id = c.id

LEFT JOIN PRODUCT_IMAGES pi
    ON p.id = pi.product_id

LEFT JOIN PRODUCT_REVIEWS pr
    ON p.id = pr.product_id
    AND pr.approved = true

      WHERE ${whereClause}

      GROUP BY p.id, c.name

      ORDER BY p.${sortBy} ${sortOrder}
      LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
    `;

    const result = await pool.query(query, [
      ...values,
      limit,
      offset,
    ]);

    // console.log("Executed getProductList query", result.rows);

    return {
      data: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    Logger.error("Get product list error", {
      message: error.message,
      tenantId,
    });
    throw error;
  }
};

// Storefront listing: search + filter + sort + paginate, always scoped to
// published, non-deleted products for the tenant. Kept separate from the
// admin getProductList above because the filter set and defaults differ
// (shoppers never see is_published/is_featured toggles, etc.).
exports.getPublicProductList = async (tenantId, filters = {}) => {
  try {
    const {
      page = 1,
      limit = 12,
      search,
      category,
      inStock,
      minPrice,
      maxPrice,
      rating,
      sort = 'newest',
      // `rating` is accepted for forward compatibility but is currently a
      // no-op — see PUBLIC_SORT_MAP comment above for why.
    } = filters;

    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 100);
    const offset = (safePage - 1) * safeLimit;

    const whereParts = [`p.tenant_id = $1`, `p.is_deleted = false`, `p.is_published = true`];
    const values = [tenantId];
    let idx = 2;

    const trimmedSearch = search ? String(search).trim() : '';
    if (trimmedSearch) {
      whereParts.push(`(p.name ILIKE $${idx} OR p.slug ILIKE $${idx} OR p.description ILIKE $${idx})`);
      values.push(`%${trimmedSearch}%`);
      idx++;
    }

    // Supports a single category id or a comma-separated list (?category=a,b)
    if (category) {
      const categoryIds = String(category)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

      if (categoryIds.length === 1) {
        whereParts.push(`p.category_id = $${idx}`);
        values.push(categoryIds[0]);
        idx++;
      } else if (categoryIds.length > 1) {
        const placeholders = categoryIds.map(() => `$${idx++}`);
        whereParts.push(`p.category_id IN (${placeholders.join(', ')})`);
        values.push(...categoryIds);
      }
    }

    if (inStock === true || inStock === 'true') {
      whereParts.push(`p.stock_qty > 0`);
    }

    if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
      whereParts.push(`p.price >= $${idx}`);
      values.push(Number(minPrice));
      idx++;
    }

    if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
      whereParts.push(`p.price <= $${idx}`);
      values.push(Number(maxPrice));
      idx++;
    }

    const whereClause = whereParts.join(' AND ');
    let havingClause = "";
    const countQuery = `
SELECT COUNT(*)::int AS total
FROM (
    SELECT
        p.id
    FROM products p

    LEFT JOIN (
        SELECT
            product_id,
            ROUND(AVG(rating)::numeric,1) AS average_rating
        FROM product_reviews
        WHERE approved = true
        GROUP BY product_id
    ) pr
        ON p.id = pr.product_id

    WHERE ${whereClause}

    GROUP BY
        p.id,
        pr.average_rating

    ${havingClause}
) x
`;

    const countResult = await pool.query(countQuery, values);
    const total = countResult.rows[0]?.total || 0;

    const { column: sortColumn, order: sortOrder } = PUBLIC_SORT_MAP[sort] || PUBLIC_SORT_MAP.newest;

    // Tiebreaker keeps pagination stable when many rows share the same
    // sort value (e.g. several products created in the same second).
    const orderClause = sortColumn === 'p.created_at'
      ? `${sortColumn} ${sortOrder}, p.id ${sortOrder}`
      : `${sortColumn} ${sortOrder}, p.created_at DESC, p.id DESC`;

    const dataValues = [...values, safeLimit, offset];



    if (rating) {
      havingClause = `
    HAVING COALESCE(pr.average_rating, 0) >= ${Number(rating)}
  `;
    }

    const query = `
SELECT
    p.*,
    c.name AS category_name,

    COALESCE(pr.average_rating,0) AS average_rating,
    COALESCE(pr.review_count,0) AS review_count,

    MAX(pi.base_url)
        FILTER (WHERE pi.is_primary = true)
        AS primary_image_url,

    JSON_AGG(
        DISTINCT JSONB_BUILD_OBJECT(
            'id', pi.id,
            'url', pi.base_url,
            'is_primary', pi.is_primary,
            'is_featured', p.is_featured,
            'is_best_sell', p.is_best_sell
        )
    ) FILTER (WHERE pi.id IS NOT NULL) AS image_urls

FROM products p

LEFT JOIN categories c
    ON c.id = p.category_id

LEFT JOIN product_images pi
    ON pi.product_id = p.id

LEFT JOIN (
    SELECT
        product_id,
        COUNT(*)::int AS review_count,
        ROUND(AVG(rating)::numeric,1) AS average_rating
    FROM product_reviews
    WHERE approved = true
    GROUP BY product_id
) pr
    ON pr.product_id = p.id

WHERE ${whereClause}

GROUP BY
    p.id,
    c.name,
    pr.average_rating,
    pr.review_count

${havingClause}

ORDER BY ${orderClause}

LIMIT $${idx}
OFFSET $${idx + 1}
`;

    const result = await pool.query(query, dataValues);

    return {
      data: result.rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalProducts: total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        hasNext: safePage * safeLimit < total,
        hasPrevious: safePage > 1,
      },
    };
  } catch (error) {
    Logger.error('Get public product list error', {
      message: error.message,
      tenantId,
    });
    throw error;
  }
};

// Facets for the storefront sidebar: the full category list and price
// bounds for the tenant's published catalog, independent of pagination —
// so the filter UI stays stable no matter which page the shopper is on.
exports.getPublicProductFilters = async (tenantId) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT DISTINCT c.id, c.name
       FROM PRODUCTS p
       JOIN CATEGORIES c ON c.id = p.category_id
       WHERE p.tenant_id = $1 AND p.is_deleted = false AND p.is_published = true
       ORDER BY c.name ASC`,
      [tenantId]
    );

    const priceResult = await pool.query(
      `SELECT MIN(price)::float AS min_price, MAX(price)::float AS max_price
       FROM PRODUCTS
       WHERE tenant_id = $1 AND is_deleted = false AND is_published = true`,
      [tenantId]
    );

    const { min_price: minPrice, max_price: maxPrice } = priceResult.rows[0] || {};

    return {
      categories: categoriesResult.rows,
      priceRange: [Number(minPrice) || 0, Number(maxPrice) || 0],
    };
  } catch (error) {
    Logger.error('Get public product filters error', {
      message: error.message,
      tenantId,
    });
    throw error;
  }
};

exports.getProductById = async (tenantId, productId) => {
  try {
    const productResult = await pool.query(
      `SELECT p.*, c.name as category_name
       FROM PRODUCTS p
       LEFT JOIN CATEGORIES c ON p.category_id = c.id
       WHERE p.id = $1 AND p.tenant_id = $2 AND p.is_deleted = false`,
      [productId, tenantId]
    );

    if (productResult.rows.length === 0) {
      throw new NotFoundError('Product');
    }

    const product = productResult.rows[0];

    const imagesResult = await pool.query(
      `SELECT id, base_url, storage_path, alt_text, is_primary, sort_order
       FROM PRODUCT_IMAGES
       WHERE product_id = $1 AND tenant_id = $2
       ORDER BY sort_order ASC`,
      [productId, tenantId]
    );

    product.images = imagesResult.rows;

    return product;
  } catch (error) {
    Logger.error('Get product by ID error', {
      productId,
      tenantId,
      message: error.message,
    });
    throw error;
  }
};

// FIX: Added newImageFiles parameter. When the edit form includes new image
// files (multipart request), they are forwarded here from the controller and
// appended to the product via updateProductImages — reusing the same upload
// + insert logic already tested for that flow.
exports.updateProduct = async (tenantId, productId, updateData, newImageFiles = []) => {
  try {
    const {
      name,
      slug,
      sku,
      description,
      price,
      compare_price,
      stock_qty,
      category_id,
      collection_id,
      is_published,
      is_featured,
      is_best_sell,
      tags,
      attributes,
      meta_title,
      meta_desc,
    } = updateData;

    // Validate category exists if provided
    if (category_id !== undefined && category_id) {
      const categoryResult = await pool.query(
        'SELECT id FROM CATEGORIES WHERE id = $1 AND tenant_id = $2',
        [category_id, tenantId]
      );
      if (categoryResult.rows.length === 0) {
        throw new NotFoundError('Category');
      }
    }

    // Validate collection exists if provided
    if (collection_id !== undefined && collection_id) {
      const collectionResult = await pool.query(
        'SELECT id FROM COLLECTIONS WHERE id = $1 AND tenant_id = $2',
        [collection_id, tenantId]
      );
      if (collectionResult.rows.length === 0) {
        throw new NotFoundError('Collection');
      }
    }

    const updates = [];
    const values = [productId, tenantId];
    let paramIndex = 3;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(name);
      paramIndex++;
    }
    if (slug !== undefined) {
      updates.push(`slug = $${paramIndex}`);
      values.push(slug);
      paramIndex++;
    }
    // sku is immutable after creation — intentionally not updated
    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }
    if (price !== undefined) {
      updates.push(`price = $${paramIndex}`);
      values.push(price);
      paramIndex++;
    }
    if (compare_price !== undefined) {
      updates.push(`compare_price = $${paramIndex}`);
      values.push(compare_price);
      paramIndex++;
    }
    if (stock_qty !== undefined) {
      updates.push(`stock_qty = $${paramIndex}`);
      values.push(stock_qty);
      paramIndex++;
    }
    if (category_id !== undefined) {
      updates.push(`category_id = $${paramIndex}`);
      values.push(category_id);
      paramIndex++;
    }
    if (collection_id !== undefined) {
      updates.push(`collection_id = $${paramIndex}`);
      values.push(collection_id);
      paramIndex++;
    }
    if (is_published !== undefined) {
      updates.push(`is_published = $${paramIndex}`);
      values.push(is_published);
      paramIndex++;
    }
    if (is_featured !== undefined) {
      updates.push(`is_featured = $${paramIndex}`);
      values.push(is_featured);
      paramIndex++;
    }
    if (is_best_sell !== undefined) {
      updates.push(`is_best_sell = $${paramIndex}`);
      values.push(is_best_sell);
      paramIndex++;
    }
    if (tags !== undefined) {
      updates.push(`tags = $${paramIndex}`);
      values.push(tags);
      paramIndex++;
    }
    if (attributes !== undefined) {
      updates.push(`attributes = $${paramIndex}`);
      values.push(attributes);
      paramIndex++;
    }
    if (meta_title !== undefined) {
      updates.push(`meta_title = $${paramIndex}`);
      values.push(meta_title);
      paramIndex++;
    }
    if (meta_desc !== undefined) {
      updates.push(`meta_desc = $${paramIndex}`);
      values.push(meta_desc);
      paramIndex++;
    }

    updates.push(`updated_at = now()`);
    updates.push(`updated_by = 'system'`);

    if (updates.length === 2) {
      // No actual field updates — skip the UPDATE query but still handle images below
    } else {
      const query = `
        UPDATE PRODUCTS
        SET ${updates.join(', ')}
        WHERE id = $1 AND tenant_id = $2 AND is_deleted = false
        RETURNING *
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        throw new NotFoundError('Product');
      }
    }

    // FIX: If new image files were included in the request, upload and append
    // them to this product using the existing updateProductImages logic.
    if (newImageFiles.length > 0) {
      await exports.updateProductImages(tenantId, productId, newImageFiles, null);
    }

    Logger.info('Product updated', { productId, tenantId });

    return exports.getProductById(tenantId, productId);
  } catch (error) {
    if (error.code === '23505') {
      throw new ConflictError('Product slug or SKU already exists');
    }
    Logger.error('Update product error', {
      productId,
      tenantId,
      message: error.message,
    });
    throw error;
  }
};

exports.updateProductImages = async (tenantId, productId, newImageFiles = [], primaryImageId = null) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify product exists
    const productResult = await client.query(
      'SELECT slug FROM PRODUCTS WHERE id = $1 AND tenant_id = $2 AND is_deleted = false',
      [productId, tenantId]
    );

    if (productResult.rows.length === 0) {
      throw new NotFoundError('Product');
    }

    // Handle new image uploads
    if (newImageFiles && newImageFiles.length > 0) {
      const maxSort = await client.query(
        'SELECT MAX(sort_order) as max_sort FROM PRODUCT_IMAGES WHERE product_id = $1',
        [productId]
      );

      let sortOrder = (maxSort.rows[0].max_sort ?? -1) + 1;

      for (const file of newImageFiles) {
        const imageId = uuidv4();

        try {
          const { url, path: storagePath } = await uploadToSupabase(
            file,
            `products/${tenantId}/${productId}`
          );

          await client.query(
            `INSERT INTO PRODUCT_IMAGES (
              id, tenant_id, product_id, base_url, storage_path, is_primary, sort_order, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              imageId,
              tenantId,
              productId,
              url,
              storagePath,
              false,
              sortOrder,
              'system',
            ]
          );

          sortOrder++;
        } catch (error) {
          throw error;
        }
      }
    }

    // Update primary image if provided
    if (primaryImageId) {
      const imageExists = await client.query(
        'SELECT id FROM PRODUCT_IMAGES WHERE id = $1 AND product_id = $2 AND tenant_id = $3',
        [primaryImageId, productId, tenantId]
      );

      if (imageExists.rows.length === 0) {
        throw new NotFoundError('Product image');
      }

      // Reset all to non-primary
      await client.query(
        'UPDATE PRODUCT_IMAGES SET is_primary = false WHERE product_id = $1',
        [productId]
      );

      // Set selected as primary
      await client.query(
        'UPDATE PRODUCT_IMAGES SET is_primary = true WHERE id = $1',
        [primaryImageId]
      );

      Logger.info('Primary image updated', { primaryImageId, productId });
    }

    await client.query('COMMIT');
    return exports.getProductById(tenantId, productId);
  } catch (error) {
    await client.query('ROLLBACK');
    Logger.error('Update product images error', {
      productId,
      tenantId,
      message: error.message,
    });
    throw error;
  } finally {
    client.release();
  }
};

exports.deleteProductImage = async (tenantId, productId, imageId) => {
  try {
    const imageResult = await pool.query(
      'SELECT base_url, storage_path, is_primary FROM PRODUCT_IMAGES WHERE id = $1 AND product_id = $2 AND tenant_id = $3',
      [imageId, productId, tenantId]
    );

    const image = imageResult.rows[0];

    // Delete from Supabase storage
    if (image.storage_path) {
      await supabase.storage
        .from('products')
        .remove([image.storage_path]);
    }

    // Delete from DB
    await pool.query(
      'DELETE FROM PRODUCT_IMAGES WHERE id = $1',
      [imageId]
    );

    // If this was primary, promote the next image
    if (image.is_primary) {
      const nextImage = await pool.query(
        'SELECT id FROM PRODUCT_IMAGES WHERE product_id = $1 ORDER BY sort_order ASC LIMIT 1',
        [productId]
      );
      if (nextImage.rows.length > 0) {
        await pool.query(
          'UPDATE PRODUCT_IMAGES SET is_primary = true WHERE id = $1',
          [nextImage.rows[0].id]
        );
      }
    }

    Logger.info('Image deleted', { imageId, productId });
    return { id: imageId, message: 'Image deleted successfully' };
  } catch (error) {
    Logger.error('Delete product image error', {
      productId,
      imageId,
      tenantId,
      message: error.message,
    });
    throw error;
  }
};

exports.deleteProduct = async (tenantId, productId) => {
  try {
    const result = await pool.query(
      `UPDATE PRODUCTS
       SET is_deleted = true, updated_at = now(), updated_by = 'system'
       WHERE id = $1 AND tenant_id = $2 AND is_deleted = false
       RETURNING id`,
      [productId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Product');
    }

    Logger.info('Product deleted', { productId, tenantId });

    return {
      id: productId,
      message: 'Product deleted successfully',
    };
  } catch (error) {
    if (error.code === '23503') {
      throw new AppError('Product cannot be deleted because it is referenced by other records', 409, 'PRODUCT_IN_USE');
    }
    Logger.error('Delete product error', {
      productId,
      tenantId,
      message: error.message,
    });
    throw error;
  }
};

const PRODUCT_COLUMNS = new Set([
  "id",
  "tenant_id",
  "category_id",
  "collection_id",
  "name",
  "slug",
  "sku",
  "description",
  "price",
  "compare_price",
  "stock_qty",
  "is_published",
  "is_featured",
  "is_best_sell",
  "tags",
  "attributes",
  "meta_title",
  "meta_desc",
  "created_at",
  "updated_at",
]);

exports.getEnquiries = async ({
  page = 1,
  limit = 20,
  search = "",
  status,
}) => {
  const client = await pool.connect();

  try {
    const safeLimit = Math.min(Number(limit) || 20, 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    let whereClauses = [];
    let values = [];
    let index = 1;

    // Clean search
    const trimmedSearch = search?.trim();

    // Search (enquiry + product table)
    if (trimmedSearch) {
      whereClauses.push(`(
        e.name ILIKE $${index} OR
        e.email ILIKE $${index} OR
        p.name ILIKE $${index}
      )`);

      values.push(`%${trimmedSearch}%`);
      index++;
    }

    //Status filter
    if (status && status !== "all") {
      whereClauses.push(`e.status = $${index}`);
      values.push(status);
      index++;
    }

    const whereQuery = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    //Count query
    const countQuery = `
  SELECT COUNT(DISTINCT e.id)
  FROM enquiries e
  LEFT JOIN enquiry_products ep
    ON ep.enquiry_id = e.id
  LEFT JOIN products p
    ON p.id = ep.product_id
  ${whereQuery}
`;

    const countResult = await client.query(countQuery, values);

    const total = Number(countResult.rows[0].count);

    // Data query values
    const dataValues = [...values, safeLimit, offset];

    // Fetch enquiry + product info
    const dataQuery = `
SELECT
    e.*,

    COALESCE(
        JSON_AGG(
            JSON_BUILD_OBJECT(
                'product_id', p.id,
                'product_name', p.name,
                'product_slug', p.slug,
                'quantity', ep.quantity
            )
        ) FILTER (WHERE p.id IS NOT NULL),
        '[]'
    ) AS products

FROM enquiries e

LEFT JOIN enquiry_products ep
    ON ep.enquiry_id = e.id

LEFT JOIN products p
    ON p.id = ep.product_id

${whereQuery}

GROUP BY e.id

ORDER BY e.created_at DESC

LIMIT $${index}
OFFSET $${index + 1}
`;

    const dataResult = await client.query(dataQuery, dataValues);

    return {
      data: dataResult.rows,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };

  } catch (error) {
    Logger.error("Get enquiries error", {
      message: error.message,
    });

    throw error;
  } finally {
    client.release();
  }
};

// Get Count (for bell icon)
exports.getEnquiryCount = async ({ status = "new" }) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM enquiries WHERE status = $1`,
      [status]
    );

    return {
      count: Number(result.rows[0].count),
    };
  } catch (error) {
    Logger.error("Get enquiry count error", { message: error.message });
    throw error;
  }
};

// Update Status
exports.updateEnquiryStatus = async (id, status) => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `UPDATE enquiries
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      throw new Error("Enquiry not found");
    }

    Logger.info("Enquiry status updated", { id, status });

    return result.rows[0];

  } catch (error) {
    Logger.error("Update enquiry status error", {
      id,
      message: error.message,
    });
    throw error;
  } finally {
    client.release();
  }
};


exports.getAdminReviews = async (
  tenantId,
  page = 1,
  limit = 20,
  status = "pending"
) => {

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from("product_reviews")
    .select(
      `
            *,
            products (
                id,
                name,
                product_images (
                    base_url,
                    storage_path,
                    alt_text,
                    is_primary
                )
            ),
            enquiries (
                id,
                name,
                phone,
                email
            )
        `,
      { count: "exact" }
    )
    .eq("tenant_id", tenantId);

  switch (status) {
    case "pending":
      query = query.eq("approved", false);
      break;

    case "approved":
      query = query.eq("approved", true);
      break;

    case "all":
    default:
      break;
  }

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.log("Supabase Error:", error);
    throw new AppError(error.message || "Unknown error", 500);
  }

  return {
    reviews: data.map((review) => ({
      id: review.id,
      rating: review.rating,
      review: review.review,
      approved: review.approved,
      approvedAt: review.approved_at,
      createdAt: review.created_at,

      product: {
        id: review.products?.id,
        name: review.products?.name,
        image:
          review.products?.product_images?.find(
            (img) => img.is_primary
          )?.base_url || null,
      },

      customer: {
        id: review.enquiries?.id,
        name: review.enquiries?.name,
        email: review.enquiries?.email,
        phone: review.enquiries?.phone,
      },
    })),

    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil((count || 0) / limit),
    },
  };
};

exports.generateReviewInvitations = async (tenantId, enquiryId) => {
  // 1. Get enquiry
  const { data: enquiry, error: enquiryError } = await supabase
    .from("enquiries")
    .select("*")
    .eq("id", enquiryId)
    .eq("tenant_id", tenantId)
    .single();

  if (enquiryError || !enquiry) {
    throw new AppError("Enquiry not found.", 404);
  }

  // 2. Validate enquiry status
  if (enquiry.status !== "closed") {
    throw new AppError("Review invitations can only be generated for closed enquiries.", 400);
  }

  // 3. Load enquiry products
  const { data: enquiryProducts, error: productError } = await supabase
    .from("enquiry_products")
    .select(`
    product_id,
    products (
        id,
        name
    )
`)
    .eq("tenant_id", tenantId)
    .eq("enquiry_id", enquiryId);

  if (productError) {
    throw productError;
  }

  if (!enquiryProducts || enquiryProducts.length === 0) {
    throw new AppError("No products found for this enquiry.", 404);
  }

  const invitations = [];

  // 4. Create invitation for each product
  for (const item of enquiryProducts) {

    const inviteCode = crypto.randomBytes(32).toString("hex");

    const {
      data: existingInvitation,
      error: existingInvitationError,
    } = await supabase
      .from("review_invitations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("enquiry_id", enquiry.id)
      .eq("product_id", item.product_id)
      .in("status", ["pending", "sent"])
      .maybeSingle();

    if (existingInvitationError) {
      throw existingInvitationError;
    }

    if (existingInvitation) {
      invitations.push({
        invitationId: existingInvitation.id,
        productId: item.product_id,
        productName: item.products?.name,
        inviteCode: existingInvitation.invite_code,
        reviewUrl: `${process.env.FRONTEND_URL}/review/${existingInvitation.invite_code}`,
      });

      continue;
    }

    const now = new Date();

    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { data: invitation, error: invitationError } = await supabase
      .from("review_invitations")
      .insert({
        tenant_id: tenantId,
        enquiry_id: enquiry.id,
        product_id: item.product_id,
        invite_code: inviteCode,
        status: "pending",
        expires_at: expiresAt.toISOString(),
        last_upd_at: now.toISOString(),
      })
      .select()
      .single();

    if (invitationError) {
      throw invitationError;
    }

    invitations.push({
      invitationId: invitation.id,
      productId: item.product_id,
      productName: item.products?.name,
      inviteCode,
      reviewUrl: `${process.env.FRONTEND_URL}/review/${inviteCode}`,
    });
  }

  return invitations;
};

exports.getReviewInvitation = async (inviteCode) => {
  // 1. Fetch review invitation
  const {
    data: invitation,
    error: invitationError,
  } = await supabase
    .from("review_invitations")
    .select("*")
    .eq("invite_code", inviteCode)
    .single();

  console.log("Invite Code:", inviteCode);
  console.log("Invitation:", invitation);
  console.log("Invitation Error:", invitationError);

  if (invitationError || !invitation) {
    throw new AppError("Review invitation not found.", 404);
  }


  // 2. Check expiry
  if (
    invitation.expires_at &&
    new Date(invitation.expires_at) < new Date()
  ) {
    throw new AppError(
      "This review invitation has expired.",
      400
    );
  }


  // 3. Check invitation status
  if (!["pending", "sent"].includes(invitation.status)) {
    throw new AppError(
      "Review invitation is not in a valid state.",
      400
    );
  }


  // 4. Fetch product
  const {
    data: product,
    error: productError,
  } = await supabase
    .from("products")
    .select(`
            id,
            name
        `)
    .eq("id", invitation.product_id)
    .single();


  console.log("Product:", product);
  console.log("Product Error:", productError);


  if (productError || !product) {
    throw new AppError("Product not found.", 404);
  }


  // 5. Fetch product images
  const {
    data: productImages,
    error: imagesError,
  } = await supabase
    .from("product_images")
    .select(`
            base_url,
            storage_path,
            alt_text,
            is_primary
        `)
    .eq("product_id", product.id);


  console.log("Product Images:", productImages);
  console.log("Images Error:", imagesError);



  // 6. Fetch customer enquiry
  const {
    data: enquiry,
    error: enquiryError,
  } = await supabase
    .from("enquiries")
    .select(`
            id,
            name,
            email,
            phone
        `)
    .eq("id", invitation.enquiry_id)
    .single();


  console.log("Enquiry:", enquiry);
  console.log("Enquiry Error:", enquiryError);


  if (enquiryError || !enquiry) {
    throw new AppError("Customer not found.", 404);
  }


  // 7. Return response
  return {
    invitationId: invitation.id,

    enquiryId: invitation.enquiry_id,

    status: invitation.status,

    expiresAt: invitation.expires_at,

    product: {
      id: product.id,
      name: product.name,
      image: product.thumbnail_url,
      images: productImages || [],
    },

    customer: {
      name: enquiry.name,
      email: enquiry.email,
      phone: enquiry.phone,
    },
  };
};

exports.submitProductReview = async (
  inviteCode,
  rating,
  review
) => {

  const { data: invitation, error } = await supabase
    .from("review_invitations")
    .select("*")
    .eq("invite_code", inviteCode)
    .single();

  if (error || !invitation) {
    throw new AppError("Review invitation not found.", 404);
  }

  if (
    invitation.expires_at &&
    new Date(invitation.expires_at) < new Date()
  ) {
    throw new AppError("Review invitation has expired.", 400);
  }

  if (!["pending", "sent"].includes(invitation.status)) {
    throw new AppError(
      "Review invitation is not in a valid state.",
      400
    );
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError("Rating must be between 1 and 5.", 400);
  }

  const now = new Date().toISOString();

  const {
    data: enquiry,
    error: enquiryError,
  } = await supabase
    .from("enquiries")
    .select("id, name, email, phone")
    .eq("id", invitation.enquiry_id)
    .single();

  if (enquiryError || !enquiry) {
    throw new AppError("Customer not found.", 404);
  }


  const { data: productReview, error: reviewError } =
    await supabase
      .from("product_reviews")
      .insert({
        tenant_id: invitation.tenant_id,

        product_id: invitation.product_id,

        enquiry_id: invitation.enquiry_id,

        review_invitation_id: invitation.id,

        customer_name: enquiry.name,

        rating,

        review: review?.trim() || null,

        approved: false,

        created_at: now,

        last_upd_at: now,
      })
      .select()
      .single();

  if (reviewError) {
    console.error("Review Insert Error:", reviewError);
    throw new AppError(reviewError.message, 500);
  }
  const { error: updateError } = await supabase
    .from("review_invitations")
    .update({
      status: "submitted",
      submitted_at: now,
      last_upd_at: now,
    })
    .eq("id", invitation.id);

  if (updateError) {
    throw new AppError("Failed to update review invitation.", 500);
  }

  return {
    reviewId: productReview.id,
    rating: productReview.rating,
    review: productReview.review,
    status: "submitted",
  };

};


exports.approveReview = async (tenantId, reviewId, adminUserId) => {

  // 1. Find review
  const { data: review, error } = await supabase
    .from("product_reviews")
    .select("*")
    .eq("id", reviewId)
    .eq("tenant_id", tenantId)
    .single();

  if (error || !review) {
    throw new AppError("Review not found.", 404);
  }

  // 2. Already approved?
  if (review.approved) {
    throw new AppError("Review is already approved.", 400);
  }

  // 3. Update review
  const now = new Date().toISOString();

  const { data: updatedReview, error: updateError } =
    await supabase
      .from("product_reviews")
      .update({
        approved: true,
        approved_at: now,
        approved_by: adminUserId,
        last_upd_at: now,
      })
      .eq("id", reviewId)
      .select()
      .single();

  if (updateError) {
    throw new AppError("Failed to approve review.", 500);
  }

  return {
    reviewId: updatedReview.id,
    approved: updatedReview.approved,
    approvedAt: updatedReview.approved_at,
  };
};

exports.getProductReviews = async (productId) => {

  // NOTE: previously there were two `getProductReviews` exports in this
  // file — the second silently overwrote the first (so the aggregation
  // below was dead code), and it joined a `customers` table that reviews
  // aren't actually related to. `product_reviews.customer_name` is
  // already stored on the row at submission time (see
  // submitProductReview), so we read it directly instead of joining.
  const { data: reviews, error } = await supabase
    .from("product_reviews")
    .select(`
            id,
            rating,
            review,
            customer_name,
            created_at
        `)
    .eq("product_id", productId)
    .eq("approved", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.log("Supabase Error:", error);
    throw new AppError(error.message, 500);
  }

  const totalReviews = reviews.length;
  const breakdown = {
    5: 0,
    4: 0,
    3: 0,
    2: 0,
    1: 0,
  };

  reviews.forEach((review) => {
    breakdown[review.rating]++;
  });
  const averageRating =
    totalReviews === 0
      ? 0
      : Number(
        (
          reviews.reduce(
            (sum, item) => sum + item.rating,
            0
          ) / totalReviews
        ).toFixed(1)
      );

  return {
    averageRating,
    totalReviews,
    breakdown,

    reviews: reviews.map((item) => ({
      id: item.id,
      rating: item.rating,
      review: item.review,
      customerName: item.customer_name ?? "Anonymous",
      reviewedAt: item.created_at,
    })),
  };
};

exports.updateReviewStatus = async (reviewId, approved) => {

  if (typeof approved !== "boolean") {
    throw new AppError("Invalid review status", 400);
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("product_reviews")
    .update({
      approved,
      approved_at: approved ? now : null,
      last_upd_at: now,
    })
    .eq("id", reviewId)
    .select()
    .single();

  if (error) {
    throw new AppError("Failed to update review status", 500);
  }

  return {
    id: data.id,
    status: data.approved ? "approved" : "pending",
  };
};

exports.updateReview = async (
  reviewId,
  rating,
  review
) => {

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("product_reviews")
    .update({
      rating,
      review: review?.trim() || null,
      last_upd_at: now,
    })
    .eq("id", reviewId)
    .select()
    .single();

  if (error) {
    throw new AppError(error.message, 500);
  }

  if (!data) {
    throw new AppError("Review not found.", 404);
  }

  return {
    id: data.id,
    rating: data.rating,
    review: data.review,
  };
};

const extractFilters = (tenantId, filters = {}, startIndex = 1) => {
  const whereParts = [`p.tenant_id = $${startIndex}`, `p.is_deleted = false`];
  const values = [tenantId];
  let index = startIndex + 1;

  for (const key in filters) {
    let value = filters[key];

    // Skip empty
    if (value === undefined || value === null || value === "") continue;

    // Handle boolean from query (?is_featured=true)
    if (value === "true") value = true;
    if (value === "false") value = false;

    //EARCH (global)
    if (key === "search") {
      whereParts.push(`(p.name ILIKE $${index} OR p.slug ILIKE $${index})`);
      values.push(`%${value}%`);
      index++;
      continue;
    }

    // Skip unknown columns
    if (!PRODUCT_COLUMNS.has(key)) continue;

    const column = `p.${key}`;

    // RANGE (price[min]=1000)
    if (typeof value === "object" && (value.min || value.max)) {
      if (value.min !== undefined) {
        whereParts.push(`${column} >= $${index}`);
        values.push(value.min);
        index++;
      }
      if (value.max !== undefined) {
        whereParts.push(`${column} <= $${index}`);
        values.push(value.max);
        index++;
      }
      continue;
    }

    // ARRAY (IN query)
    if (Array.isArray(value)) {
      const placeholders = value.map(() => `$${index++}`);
      whereParts.push(`${column} IN (${placeholders.join(",")})`);
      values.push(...value);
      continue;
    }

    //STRING → LIKE (optional improvement)
    if (typeof value === "string" && key === "name") {
      whereParts.push(`${column} ILIKE $${index}`);
      values.push(`%${value}%`);
      index++;
      continue;
    }

    //DEFAULT EQUAL
    whereParts.push(`${column} = $${index}`);
    values.push(value);
    index++;
  }

  return {
    whereClause: whereParts.join(" AND "),
    values,
    nextIndex: index,
  };
};