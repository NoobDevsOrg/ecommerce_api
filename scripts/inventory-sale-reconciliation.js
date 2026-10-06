/*
 * Read-only historical reconciliation. It never writes, backfills, or changes
 * stock. Set INVENTORY_V1_APPLIED_AT only when the actual migration timestamp
 * is known from deployment records; the script will otherwise never label an
 * item as legacy merely because it is old.
 */
require('dotenv').config();

const pool = require('../src/config/db');

const parseAppliedAt = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('INVENTORY_V1_APPLIED_AT must be an ISO timestamp');
  return parsed;
};

const classify = ({ expectedQuantity, saleCount, saleQuantity, orderCreatedAt, appliedAt }) => {
  if (saleCount > 1) return 'DUPLICATE_SALE';
  if (saleCount === 1 && saleQuantity === -expectedQuantity) return 'MATCHED';
  if (saleCount === 0 && appliedAt && new Date(orderCreatedAt) < appliedAt) return 'PRE_INVENTORY_V1 / LEGACY';
  if (saleCount === 0) return 'MISSING_SALE';
  return 'UNKNOWN';
};

const main = async () => {
  const appliedAt = parseAppliedAt(process.env.INVENTORY_V1_APPLIED_AT);
  const tenantId = process.env.TENANT_ID || null;
  const result = await pool.query(
    `SELECT o.order_number AS order_reference,o.created_at AS order_created_at,o.payment_status,
            oi.id AS order_item_id,oi.product_id,oi.quantity,
            COUNT(it.id)::int AS actual_sale_movement_count,
            COALESCE(SUM(it.quantity_delta),0)::int AS actual_sale_quantity
     FROM ORDERS o
     JOIN ORDER_ITEMS oi ON oi.order_id=o.id AND oi.tenant_id=o.tenant_id AND oi.is_deleted=false
     LEFT JOIN INVENTORY_TRANSACTIONS it
       ON it.tenant_id=oi.tenant_id AND it.order_item_id=oi.id AND it.transaction_type='SALE'
     WHERE o.payment_status='PAID' AND o.is_deleted=false
       AND ($1::text IS NULL OR o.tenant_id=$1)
     GROUP BY o.order_number,o.created_at,o.payment_status,oi.id,oi.product_id,oi.quantity
     ORDER BY o.created_at ASC,o.order_number ASC,oi.id ASC`,
    [tenantId]
  );
  const rows = result.rows.map((row) => {
    const expectedQuantity = Number(row.quantity);
    const actualSaleMovementCount = Number(row.actual_sale_movement_count);
    const actualSaleQuantity = Number(row.actual_sale_quantity);
    return {
      order_reference: row.order_reference,
      order_created_at: row.order_created_at,
      payment_status: row.payment_status,
      order_item_id: row.order_item_id,
      product_id: row.product_id,
      quantity: expectedQuantity,
      expected_sale_movement: -expectedQuantity,
      actual_sale_movement_count: actualSaleMovementCount,
      actual_sale_quantity: actualSaleQuantity,
      inventory_v1_migration_context: appliedAt ? { appliedAt: appliedAt.toISOString(), source: 'INVENTORY_V1_APPLIED_AT' } : { appliedAt: null, source: 'not determinable from database' },
      classification: classify({ expectedQuantity, saleCount: actualSaleMovementCount, saleQuantity: actualSaleQuantity, orderCreatedAt: row.order_created_at, appliedAt }),
    };
  });
  const summary = {
    total_paid_orders: new Set(rows.map((row) => row.order_reference)).size,
    total_paid_order_items: rows.length,
    matched_items: rows.filter((row) => row.classification === 'MATCHED').length,
    missing_sale_items: rows.filter((row) => row.classification === 'MISSING_SALE').length,
    duplicate_sale_items: rows.filter((row) => row.classification === 'DUPLICATE_SALE').length,
    likely_legacy_items: rows.filter((row) => row.classification === 'PRE_INVENTORY_V1 / LEGACY').length,
    unresolved_items: rows.filter((row) => ['MISSING_SALE', 'DUPLICATE_SALE', 'UNKNOWN'].includes(row.classification)).length,
  };
  const recommendation = summary.unresolved_items > 0
    ? 'manual investigation needed'
    : summary.likely_legacy_items > 0
      ? 'document as legacy baseline'
      : 'no action required';
  console.log(JSON.stringify({ readOnly: true, inventoryV1AppliedAt: appliedAt?.toISOString() || null, summary, recommendation, rows }, null, 2));
};

main()
  .catch((error) => { console.error(`Inventory reconciliation failed: ${error.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
