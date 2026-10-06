const crypto = require('crypto');
const defaultPool = require('../../config/db');
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');
const { resolvePublicCapabilities } = require('../products/productCapabilities');
const { invalidatePublicProductCache } = require('../products/product.controller');
const notifications = require('../orders/orderNotification.service');
const audit = require('../../services/audit.service');

const inventoryError = (message, details = {}) => new AppError(message, 409, 'INVENTORY_INSUFFICIENT_STOCK', details);

const presentMovement = (row) => ({
  id: row.id,
  transactionType: row.transaction_type,
  quantityDelta: Number(row.quantity_delta),
  beforeQuantity: Number(row.before_quantity),
  afterQuantity: Number(row.after_quantity),
  reason: row.reason,
  actorType: row.actor_type,
  actorId: row.actor_id || null,
  orderReference: row.order_number || null,
  createdAt: row.created_at,
});

const createInventoryService = ({ pool = defaultPool, auditService = audit } = {}) => {
  const applyPaidOrderSale = async (client, { tenantId, orderId, requestId = null }) => {
    const itemsResult = await client.query(
      `SELECT oi.id, oi.product_id, oi.quantity, p.id AS locked_product_id, p.stock_qty, p.name AS product_name
       FROM ORDER_ITEMS oi
       JOIN PRODUCTS p ON p.id = oi.product_id AND p.tenant_id = oi.tenant_id
       WHERE oi.tenant_id = $1 AND oi.order_id = $2 AND oi.is_deleted = false
       ORDER BY oi.product_id ASC, oi.id ASC
       FOR UPDATE OF p`,
      [tenantId, orderId]
    );
    if (itemsResult.rows.length === 0) throw new AppError('Order has no inventory items', 409, 'INVENTORY_ORDER_ITEMS_MISSING');

    const availableByProduct = new Map(); const affectedProductIds = new Set();
    for (const item of itemsResult.rows) {
      const idempotencyKey = `sale:${item.id}`;
      const existing = await client.query(
        `SELECT id FROM INVENTORY_TRANSACTIONS WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if (existing.rows[0]) continue;
      const before = availableByProduct.has(item.product_id) ? availableByProduct.get(item.product_id) : Number(item.stock_qty);
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0 || before < quantity) {
        throw inventoryError('Inventory is insufficient for this paid order', { productId: item.product_id, available: before, requested: quantity });
      }
      const after = before - quantity;
      const update = await client.query(
        `UPDATE PRODUCTS SET stock_qty = $1, updated_at = now(), updated_by = 'payment-confirmation'
         WHERE id = $2 AND tenant_id = $3 AND stock_qty = $4
         RETURNING stock_qty`,
        [after, item.product_id, tenantId, before]
      );
      if (!update.rows[0]) throw new ConflictError('Inventory changed while confirming payment');
      availableByProduct.set(item.product_id, after);
      await client.query(
        `INSERT INTO INVENTORY_TRANSACTIONS
         (id, tenant_id, product_id, order_id, order_item_id, transaction_type, quantity_delta, before_quantity, after_quantity, reason, actor_type, actor_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'SALE', $6, $7, $8, 'Trusted payment confirmation', 'SYSTEM', 'payment-confirmation', $9)`,
        [crypto.randomUUID(), tenantId, item.product_id, orderId, item.id, -quantity, before, after, idempotencyKey]
      );
      await auditService.write(client, { tenantId, entityType: 'PRODUCT', entityId: item.product_id, action: 'INVENTORY_SALE',
        actorType: 'SYSTEM', actorId: 'payment-confirmation', beforeSnapshot: { stockQty: before }, afterSnapshot: { stockQty: after },
        changedFields: ['stockQty'], requestId });
      affectedProductIds.add(item.product_id);
      const lowStockThreshold = Math.max(0, Number(process.env.LOW_STOCK_THRESHOLD || 5));
      if (before > 0 && after === 0) await notifications.enqueueInTransaction(client, { tenantId, eventType: 'OUT_OF_STOCK', entityType: 'PRODUCT', entityId: item.product_id, productId: item.product_id, productName: item.product_name, stockQty: after });
      else if (before > lowStockThreshold && after <= lowStockThreshold) await notifications.enqueueInTransaction(client, { tenantId, eventType: 'LOW_STOCK', entityType: 'PRODUCT', entityId: item.product_id, productId: item.product_id, productName: item.product_name, stockQty: after });
    }
    return [...affectedProductIds];
  };

  const list = async (tenantId, { page = 1, limit = 20, search = '' }) => {
    const values = [tenantId]; const where = ['p.tenant_id = $1', 'p.is_deleted = false'];
    if (search) { values.push(`%${search}%`); where.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length} OR p.id ILIKE $${values.length})`); }
    const clause = where.join(' AND '); const offset = (page - 1) * limit;
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM PRODUCTS p WHERE ${clause}`, values),
      pool.query(
        `SELECT p.id, p.name, p.sku, p.stock_qty, p.is_purchasable, p.price, p.is_published, p.updated_at, p.created_at, image.base_url AS image_url,
                movement.transaction_type, movement.quantity_delta, movement.reason, movement.created_at AS movement_created_at,
                movement.order_number
         FROM PRODUCTS p
         LEFT JOIN LATERAL (
           SELECT pi.base_url FROM PRODUCT_IMAGES pi
           WHERE pi.tenant_id = p.tenant_id AND pi.product_id = p.id
           ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC LIMIT 1
         ) image ON true
         LEFT JOIN LATERAL (
           SELECT it.transaction_type, it.quantity_delta, it.reason, it.created_at, o.order_number
           FROM INVENTORY_TRANSACTIONS it LEFT JOIN ORDERS o ON o.id = it.order_id AND o.tenant_id = it.tenant_id
           WHERE it.tenant_id = p.tenant_id AND it.product_id = p.id ORDER BY it.created_at DESC, it.id DESC LIMIT 1
         ) movement ON true
         WHERE ${clause} ORDER BY p.updated_at DESC, p.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
    ]);
    return {
      products: rows.rows.map((row) => ({
        id: row.id, name: row.name, imageUrl: row.image_url || null, sku: row.sku || null, availableStock: Number(row.stock_qty),
        isPurchasable: resolvePublicCapabilities(row).isPurchasable, createdAt: row.created_at, updatedAt: row.updated_at,
        lastMovement: row.transaction_type ? presentMovement({ ...row, created_at: row.movement_created_at }) : null,
      })),
      pagination: { page, limit, total: Number(count.rows[0]?.total || 0), totalPages: Math.max(1, Math.ceil(Number(count.rows[0]?.total || 0) / limit)), hasNext: page * limit < Number(count.rows[0]?.total || 0), hasPrevious: page > 1 },
    };
  };

  const history = async (tenantId, productId, { page = 1, limit = 20 }) => {
    const offset = (page - 1) * limit;
    const product = await pool.query(`SELECT id FROM PRODUCTS WHERE tenant_id = $1 AND id = $2 AND is_deleted = false`, [tenantId, productId]);
    if (!product.rows[0]) throw new NotFoundError('Product');
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM INVENTORY_TRANSACTIONS WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]),
      pool.query(
        `SELECT it.*, o.order_number FROM INVENTORY_TRANSACTIONS it
         LEFT JOIN ORDERS o ON o.id = it.order_id AND o.tenant_id = it.tenant_id
         WHERE it.tenant_id = $1 AND it.product_id = $2 ORDER BY it.created_at DESC, it.id DESC LIMIT $3 OFFSET $4`,
        [tenantId, productId, limit, offset]
      ),
    ]);
    const total = Number(count.rows[0]?.total || 0);
    return { movements: rows.rows.map(presentMovement), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrevious: page > 1 } };
  };

  const adjust = async ({ tenantId, productId, quantityDelta, reason, actorType, actorId, requestId = null, ipAddress = null, userAgent = null }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT id, stock_qty FROM PRODUCTS WHERE tenant_id = $1 AND id = $2 AND is_deleted = false FOR UPDATE`, [tenantId, productId]);
      const product = found.rows[0]; if (!product) throw new NotFoundError('Product');
      const before = Number(product.stock_qty); const after = before + Number(quantityDelta);
      if (after < 0) throw inventoryError('Adjustment would make stock negative', { productId, available: before, requested: Math.abs(Number(quantityDelta)) });
      await client.query(`UPDATE PRODUCTS SET stock_qty = $1, updated_at = now(), updated_by = $2 WHERE tenant_id = $3 AND id = $4`, [after, actorId, tenantId, productId]);
      const type = quantityDelta > 0 ? 'ADMIN_RESTOCK' : 'ADMIN_ADJUSTMENT';
      const movement = await client.query(
        `INSERT INTO INVENTORY_TRANSACTIONS
         (id, tenant_id, product_id, transaction_type, quantity_delta, before_quantity, after_quantity, reason, actor_type, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [crypto.randomUUID(), tenantId, productId, type, quantityDelta, before, after, reason.trim(), actorType, actorId]
      );
      await auditService.write(client, { tenantId, entityType: 'PRODUCT', entityId: productId, action: type,
        actorType, actorId, beforeSnapshot: { stockQty: before }, afterSnapshot: { stockQty: after, reason: reason.trim() },
        changedFields: ['stockQty'], requestId, ipAddress, userAgent });
      await client.query('COMMIT');
      invalidatePublicProductCache(tenantId);
      const lowStockThreshold = Math.max(0, Number(process.env.LOW_STOCK_THRESHOLD || 5));
      if (before > 0 && after === 0) {
        const queued = await pool.connect(); try { await queued.query('BEGIN'); await notifications.enqueueInTransaction(queued, { tenantId, eventType: 'OUT_OF_STOCK', entityType: 'PRODUCT', entityId: productId, productId, productName: product.name, stockQty: after }); await queued.query('COMMIT'); } finally { queued.release(); }
        notifications.dispatchSafely({ tenantId, entityId: productId });
      } else if (before > lowStockThreshold && after <= lowStockThreshold) {
        const queued = await pool.connect(); try { await queued.query('BEGIN'); await notifications.enqueueInTransaction(queued, { tenantId, eventType: 'LOW_STOCK', entityType: 'PRODUCT', entityId: productId, productId, productName: product.name, stockQty: after }); await queued.query('COMMIT'); } finally { queued.release(); }
        notifications.dispatchSafely({ tenantId, entityId: productId });
      }
      return { availableStock: after, movement: presentMovement(movement.rows[0]) };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  return { applyPaidOrderSale, list, history, adjust };
};

module.exports = { ...createInventoryService(), createInventoryService };
