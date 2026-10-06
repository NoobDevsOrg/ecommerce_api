const crypto = require('crypto');
const zlib = require('zlib');
const pool = require('../config/db');
const Logger = require('../utils/logger');
const { sanitize, byteLength } = require('../utils/observabilitySanitizer');

const inlineLimit = () => Math.max(1024, Number(process.env.LOG_INLINE_MAX_BYTES || 32768));
const storageKey = ({ tenantId, requestId, now = new Date() }) => `system-logs/${tenantId || 'system'}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}/${requestId}.json.gz`;
const isSensitiveEndpoint = (path) => /^\/auth(?:\/|$)|\/razorpay\/(?:verify|orders)|\/webhooks\/razorpay/.test(path);

const defaultUploadArchive = async (key, data, contentType) => {
  // Reuse the service-role storage client; this bucket must be provisioned as
  // private. We intentionally never call getPublicUrl for observability data.
  const { supabase } = require('../config/supabase');
  const { error } = await supabase.storage.from(process.env.SYSTEM_LOG_STORAGE_BUCKET || 'system-logs')
    .upload(key, data, { contentType, upsert: false });
  if (error) throw error;
};

const createHttpLogService = ({ database = pool, uploadArchive } = {}) => {
  const persist = async (input) => {
    const restricted = isSensitiveEndpoint(input.route);
    const requestBody = restricted ? { redacted: true } : sanitize(input.requestBody, { maskPii: true });
    const responseBody = restricted ? { redacted: true } : sanitize(input.responseBody, { maskPii: true });
    const payload = { request: requestBody, response: responseBody };
    let storageMode = 'INLINE'; let objectKey = null; let inlineRequest = requestBody; let inlineResponse = responseBody;
    if (byteLength(payload) > inlineLimit()) {
      storageMode = 'ARCHIVED'; objectKey = storageKey(input);
      inlineRequest = null; inlineResponse = null;
      try {
        await (uploadArchive || defaultUploadArchive)(objectKey, zlib.gzipSync(Buffer.from(JSON.stringify(payload))), 'application/gzip');
      } catch (error) {
        storageMode = 'OFFLOAD_FAILED'; objectKey = null;
        Logger.warn('System log archive failed', { requestId: input.requestId, message: error.message });
      }
    }
    await database.query(
      `INSERT INTO HTTP_REQUEST_LOGS (id, request_id, tenant_id, actor_type, actor_id, method, route, status_code, duration_ms,
       request_body_sanitized, response_body_sanitized, error_code, ip_address, user_agent, storage_mode, storage_object_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)`,
      [crypto.randomUUID(), input.requestId, input.tenantId || null, input.actorType || null, input.actorId || null, input.method, input.route,
        input.statusCode, input.durationMs, JSON.stringify(inlineRequest), JSON.stringify(inlineResponse), input.errorCode || null,
        input.ipAddress || null, input.userAgent || null, storageMode, objectKey]
    );
  };
  const list = async (tenantId, { page = 1, limit = 25, search, method, status, from, to } = {}) => {
    const values = []; const where = [];
    if (tenantId) { values.push(tenantId); where.push(`tenant_id = $${values.length}`); }
    if (search) { values.push(`%${search}%`); where.push(`(request_id ILIKE $${values.length} OR route ILIKE $${values.length})`); }
    if (method) { values.push(method); where.push(`method = $${values.length}`); } if (status) { values.push(status); where.push(`status_code = $${values.length}`); }
    if (from) { values.push(from); where.push(`created_at >= $${values.length}::date`); } if (to) { values.push(to); where.push(`created_at < ($${values.length}::date + interval '1 day')`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''; const offset = (page - 1) * limit;
    const [count, rows] = await Promise.all([database.query(`SELECT COUNT(*)::int AS total FROM HTTP_REQUEST_LOGS ${clause}`, values), database.query(`SELECT * FROM HTTP_REQUEST_LOGS ${clause} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset])]);
    return { logs: rows.rows, pagination: { page, limit, total: count.rows[0].total } };
  };
  return { persist, list };
};
module.exports = { ...createHttpLogService(), createHttpLogService, storageKey, isSensitiveEndpoint };
