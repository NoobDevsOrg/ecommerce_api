const pool = require('../../config/db');
const { resolvePublicCapabilities, validSellablePrice } = require('../products/productCapabilities');

const unavailable = (productId, code) => ({
  productId,
  code,
  message: 'This item is no longer available to add to your bag.',
});

const getStockStatus = (stockQty) => (Number(stockQty) > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK');

// Authoritative, read-only cart validation.  It intentionally has no cart
// persistence: browser identity/quantity data remains the source of a guest
// bag, while this boundary supplies current product facts for Cart and later
// Checkout.
const validateItems = async (tenantId, requestedItems) => {
  const productIds = requestedItems.map((item) => item.productId);
  const result = await pool.query(
    `SELECT
       p.id, p.name, p.sku, p.slug, p.price, p.compare_price, p.stock_qty,
       p.is_published, p.is_deleted, p.is_purchasable, p.is_enquiry_enabled,
       c.name AS category_name,
       pi.base_url AS primary_image_url
     FROM PRODUCTS p
     LEFT JOIN CATEGORIES c ON c.id = p.category_id
     LEFT JOIN LATERAL (
       SELECT base_url
       FROM PRODUCT_IMAGES
       WHERE product_id = p.id AND tenant_id = p.tenant_id
       ORDER BY is_primary DESC, sort_order ASC, id ASC
       LIMIT 1
     ) pi ON true
     WHERE p.tenant_id = $1 AND p.id = ANY($2::text[])`,
    [tenantId, productIds]
  );

  const productsById = new Map(result.rows.map((product) => [product.id, product]));
  const items = [];
  const invalidItems = [];

  for (const requestedItem of requestedItems) {
    const product = productsById.get(requestedItem.productId);
    if (!product || product.is_deleted || !product.is_published) {
      invalidItems.push(unavailable(requestedItem.productId, 'PRODUCT_UNAVAILABLE'));
      continue;
    }

    const capabilities = resolvePublicCapabilities(product);
    if (!capabilities.isPurchasable || !validSellablePrice(product.price)) {
      invalidItems.push(unavailable(requestedItem.productId, 'PRODUCT_NOT_PURCHASABLE'));
      continue;
    }

    const unitPrice = Number(product.price);
    const quantity = requestedItem.quantity;
    if (quantity > Number(product.stock_qty)) {
      invalidItems.push(unavailable(requestedItem.productId, 'INSUFFICIENT_STOCK'));
      continue;
    }
    items.push({
      productId: product.id,
      quantity,
      unitPrice,
      lineSubtotal: unitPrice * quantity,
      stockStatus: getStockStatus(product.stock_qty),
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku || null,
        slug: product.slug,
        categoryName: product.category_name || null,
        primaryImageUrl: product.primary_image_url || null,
        isPurchasable: true,
        isEnquiryEnabled: capabilities.isEnquiryEnabled,
      },
    });
  }

  return {
    items,
    invalidItems,
    subtotal: items.reduce((total, item) => total + item.lineSubtotal, 0),
  };
};

module.exports = { validateItems };
