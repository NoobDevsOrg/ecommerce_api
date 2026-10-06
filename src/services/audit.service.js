const crypto = require('crypto');
const pool = require('../config/db');
const { sanitize } = require('../utils/observabilitySanitizer');

const changedFields = (before = {}, after = {}) => {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
};

const actorFor = (req) => ({
  actorType: req?.user?.staff_user_id ? 'STAFF' : req?.user?.customer_id ? 'CUSTOMER' : 'SYSTEM',
  actorId: req?.user?.id || null,
});

const write = async (client, event) => {
  const before = event.beforeSnapshot ? sanitize(event.beforeSnapshot, { maskPii: false }) : null;
  const after = event.afterSnapshot ? sanitize(event.afterSnapshot, { maskPii: false }) : null;
  const fields = event.changedFields || changedFields(before || {}, after || {});
  // A transaction-scoped advisory lock gives one monotonically increasing
  // sequence per tenant/entity without adding a version column to each domain table.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [event.tenantId, `${event.entityType}:${event.entityId}`]);
  const versionResult = await client.query(
    'SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM AUDIT_EVENTS WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3',
    [event.tenantId, event.entityType, event.entityId]
  );
  const version = Number(versionResult.rows[0].version);
  const result = await client.query(
    `INSERT INTO AUDIT_EVENTS (id, tenant_id, entity_type, entity_id, action, version, actor_type, actor_id,
      before_snapshot, after_snapshot, changed_fields, request_id, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14) RETURNING *`,
    [crypto.randomUUID(), event.tenantId, event.entityType, event.entityId, event.action, version,
      event.actorType || 'SYSTEM', event.actorId || null, JSON.stringify(before), JSON.stringify(after), JSON.stringify(fields),
      event.requestId || null, event.ipAddress || null, event.userAgent || null]
  );
  return result.rows[0];
};

const eventFromRequest = (req, event) => ({ ...event, ...actorFor(req), requestId: req?.requestId || null, ipAddress: req?.ip || null, userAgent: req?.get?.('user-agent') || null });

const record = async (event) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await write(client, event); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

const list = async (tenantId, { page = 1, limit = 25, entityType, action, actor, search, from, to } = {}) => {
  const values = [tenantId]; const where = ['tenant_id = $1'];
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (entityType) add('entity_type = ?', entityType); if (action) add('action = ?', action); if (actor) add('actor_id = ?', actor);
  if (search) { values.push(`%${search}%`); where.push(`(entity_id ILIKE $${values.length} OR request_id ILIKE $${values.length})`); }
  if (from) add('created_at >= ?::date', from); if (to) add(`created_at < (?::date + interval '1 day')`, to);
  const offset = (page - 1) * limit; const clause = where.join(' AND ');
  const [count, rows] = await Promise.all([pool.query(`SELECT COUNT(*)::int AS total FROM AUDIT_EVENTS WHERE ${clause}`, values), pool.query(`SELECT * FROM AUDIT_EVENTS WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset])]);
  return { events: rows.rows, pagination: { page, limit, total: count.rows[0].total } };
};

const get = async (tenantId, id) => (await pool.query('SELECT * FROM AUDIT_EVENTS WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0] || null;
module.exports = { write, record, eventFromRequest, actorFor, changedFields, list, get };
