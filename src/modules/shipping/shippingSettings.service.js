const crypto = require('crypto');
const pool = require('../../config/db');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { normalizeStateMatchKey } = require('./stateMatcher');
const audit = require('../../services/audit.service');

const normalize = (value) => value === null || value === undefined || value === '' ? null : normalizeStateMatchKey(value);
const presentZone = (row) => ({
  id: row.id, name: row.name, countryCode: row.country_code, stateName: row.state_name,
  fulfillmentMode: row.fulfillment_mode, flatRatePaise: row.flat_rate_paise === null ? null : Number(row.flat_rate_paise),
  isEnabled: Boolean(row.is_enabled), priority: Number(row.priority), updatedAt: row.updated_at,
});
const presentPolicy = (row) => ({
  freeShippingEnabled: Boolean(row?.free_shipping_enabled),
  freeShippingThresholdPaise: row?.free_shipping_threshold_paise === null || !row ? null : Number(row.free_shipping_threshold_paise),
  internationalFallbackMode: row?.international_fallback_mode || 'CONTACT_US', updatedAt: row?.updated_at || null,
});

const writeAudit = (database, { tenantId, actorUserId, eventType, zoneId = null, metadata }) => database.query(
  `INSERT INTO SHIPPING_AUDIT_EVENTS (id, tenant_id, actor_user_id, event_type, zone_id, metadata)
   VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
  [crypto.randomUUID(), tenantId, actorUserId, eventType, zoneId, JSON.stringify(metadata)]
);

const inTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') throw new ConflictError('A shipping zone with this name already exists');
    throw error;
  } finally {
    client.release();
  }
};

const validateZone = (zone) => {
  if (zone.fulfillmentMode === 'CONTACT_US' && zone.flatRatePaise !== null) throw new ValidationError('A contact-us zone cannot have a flat rate');
  if (zone.fulfillmentMode === 'FLAT' && (zone.flatRatePaise === null || zone.flatRatePaise === undefined)) throw new ValidationError('A flat-rate zone requires a shipping rate');
};

const listZones = async (tenantId) => {
  const [zones, policy] = await Promise.all([
    pool.query(`SELECT id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority, updated_at
                FROM SHIPPING_ZONES WHERE tenant_id = $1 ORDER BY priority ASC, name ASC, id ASC`, [tenantId]),
    pool.query(`SELECT free_shipping_enabled, free_shipping_threshold_paise, international_fallback_mode, updated_at
                FROM SHIPPING_POLICIES WHERE tenant_id = $1`, [tenantId]),
  ]);
  return { zones: zones.rows.map(presentZone), policy: presentPolicy(policy.rows[0]) };
};

const createZone = async (tenantId, actorUserId, payload) => {
  const zone = { ...payload, countryCode: payload.countryCode.toUpperCase(), stateName: normalize(payload.stateName) };
  validateZone(zone);
  return inTransaction(async (client) => {
  const result = await client.query(
    `INSERT INTO SHIPPING_ZONES (id, tenant_id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority, updated_at`,
    [crypto.randomUUID(), tenantId, zone.name, zone.countryCode, zone.stateName, zone.fulfillmentMode, zone.flatRatePaise, zone.isEnabled, zone.priority, actorUserId]
  );
  const output = presentZone(result.rows[0]);
  await writeAudit(client, { tenantId, actorUserId, eventType: 'SHIPPING_ZONE_CREATED', zoneId: output.id, metadata: output });
  await audit.write(client, { tenantId, entityType: 'SHIPPING_ZONE', entityId: output.id, action: 'SHIPPING_ZONE_CREATED', actorType: 'STAFF', actorId: actorUserId, afterSnapshot: output });
  return output;
  });
};

const updateZone = async (tenantId, actorUserId, zoneId, changes) => inTransaction(async (client) => {
  const current = await client.query(
    `SELECT id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority
     FROM SHIPPING_ZONES WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, zoneId]
  );
  if (!current.rows[0]) throw new NotFoundError('Shipping zone');
  const row = current.rows[0];
  const zone = {
    name: changes.name ?? row.name, countryCode: (changes.countryCode ?? row.country_code).toUpperCase(),
    stateName: normalize(changes.stateName === undefined ? row.state_name : changes.stateName),
    fulfillmentMode: changes.fulfillmentMode ?? row.fulfillment_mode,
    flatRatePaise: changes.flatRatePaise === undefined ? (row.flat_rate_paise === null ? null : Number(row.flat_rate_paise)) : changes.flatRatePaise,
    isEnabled: changes.isEnabled ?? row.is_enabled, priority: changes.priority ?? row.priority,
  };
  if (changes.fulfillmentMode === 'CONTACT_US' && changes.flatRatePaise === undefined) zone.flatRatePaise = null;
  validateZone(zone);
  const updated = await client.query(
    `UPDATE SHIPPING_ZONES SET name = $3, country_code = $4, state_name = $5, fulfillment_mode = $6,
     flat_rate_paise = $7, is_enabled = $8, priority = $9, updated_by = $10, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, country_code, state_name, fulfillment_mode, flat_rate_paise, is_enabled, priority, updated_at`,
    [tenantId, zoneId, zone.name, zone.countryCode, zone.stateName, zone.fulfillmentMode, zone.flatRatePaise, zone.isEnabled, zone.priority, actorUserId]
  );
  const output = presentZone(updated.rows[0]);
  await writeAudit(client, { tenantId, actorUserId, eventType: 'SHIPPING_ZONE_UPDATED', zoneId, metadata: output });
  await audit.write(client, { tenantId, entityType: 'SHIPPING_ZONE', entityId: zoneId, action: 'SHIPPING_ZONE_UPDATED', actorType: 'STAFF', actorId: actorUserId, beforeSnapshot: presentZone(row), afterSnapshot: output });
  return output;
});

const updatePolicy = async (tenantId, actorUserId, payload) => inTransaction(async (client) => {
  const result = await client.query(
    `INSERT INTO SHIPPING_POLICIES (tenant_id, free_shipping_enabled, free_shipping_threshold_paise, international_fallback_mode, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET free_shipping_enabled = EXCLUDED.free_shipping_enabled,
       free_shipping_threshold_paise = EXCLUDED.free_shipping_threshold_paise, international_fallback_mode = EXCLUDED.international_fallback_mode,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING free_shipping_enabled, free_shipping_threshold_paise, international_fallback_mode, updated_at`,
    [tenantId, payload.freeShippingEnabled, payload.freeShippingThresholdPaise, payload.internationalFallbackMode, actorUserId]
  );
  const output = presentPolicy(result.rows[0]);
  await writeAudit(client, { tenantId, actorUserId, eventType: 'SHIPPING_POLICY_UPDATED', metadata: output });
  await audit.write(client, { tenantId, entityType: 'SHIPPING_POLICY', entityId: tenantId, action: 'SHIPPING_POLICY_UPDATED', actorType: 'STAFF', actorId: actorUserId, afterSnapshot: output });
  return output;
});

module.exports = { listZones, createZone, updateZone, updatePolicy, presentZone, presentPolicy };
