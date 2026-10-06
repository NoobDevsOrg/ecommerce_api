const { v4: uuidv4 } = require('uuid');
const pool = require('../../config/db');
const { supabase } = require('../../config/supabase');
const { uploadToSupabase } = require('../../services/uploadService');
const { AppError, NotFoundError } = require('../../utils/errors');

const DEFAULTS = { enabled: true, heading: 'Loved by dancers and families', subheading: 'Discover jewellery inspiration for every stage and celebration.', max_cards: 5, card_size: 'standard', spacing: 'standard', desktop_visible_count: 3, tablet_visible_count: 2, mobile_visible_count: 1.2 };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 300;
const present = (row) => ({ id: row.id, customer_name: row.customer_name, customer_context: row.customer_context || null, content: row.content, image_url: row.image_url || null, image_fit: row.image_fit || 'cover', image_position_x: Number(row.image_position_x ?? 50), image_position_y: Number(row.image_position_y ?? 50), rating: row.rating === null ? null : Number(row.rating), display_order: Number(row.display_order), is_active: Boolean(row.is_active), is_sample: Boolean(row.is_sample), created_at: row.created_at, updated_at: row.updated_at });
const presentSettings = (row) => ({ ...DEFAULTS, ...(row || {}), enabled: row ? Boolean(row.enabled) : DEFAULTS.enabled, max_cards: Number(row?.max_cards || DEFAULTS.max_cards), desktop_visible_count: Number(row?.desktop_visible_count || DEFAULTS.desktop_visible_count), tablet_visible_count: Number(row?.tablet_visible_count || DEFAULTS.tablet_visible_count), mobile_visible_count: Number(row?.mobile_visible_count || DEFAULTS.mobile_visible_count) });

const getSettings = async (client, tenantId) => (await client.query('SELECT * FROM HOMEPAGE_TESTIMONIAL_SETTINGS WHERE tenant_id=$1', [tenantId])).rows[0] || null;
const getCard = async (client, tenantId, id, lock = false) => {
  const result = await client.query(`SELECT * FROM HOMEPAGE_TESTIMONIALS WHERE id=$1 AND tenant_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, tenantId]);
  if (!result.rows[0]) throw new NotFoundError('Testimonial');
  return result.rows[0];
};
const nullable = (value) => value === undefined || value === null || value === '' ? null : value;
const imageDimensions = (file) => {
  const data = file.buffer; let width = 0; let height = 0;
  if (file.mimetype === 'image/png' && data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') { width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
  else if (file.mimetype === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset < data.length - 8) { if (data[offset] !== 0xff) { offset += 1; continue; } const marker = data[offset + 1]; offset += 2; if (marker === 0xd8 || marker === 0xd9) continue; const length = data.readUInt16BE(offset); if (length < 2 || offset + length > data.length) break; if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break; } offset += length; }
  } else if (file.mimetype === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16); if (type === 'VP8X' && data.length >= 30) { width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3); } else if (type === 'VP8 ' && data.length >= 30) { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff; } else if (type === 'VP8L' && data.length >= 25) { const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
  }
  return { width, height };
};
const validateImage = (file) => {
  if (!file) return;
  if (!file.buffer || !IMAGE_TYPES.has(file.mimetype)) throw new AppError('Testimonial images must be JPG, PNG, or WebP', 400, 'INVALID_TESTIMONIAL_IMAGE');
  if (file.size > MAX_IMAGE_BYTES) throw new AppError('Testimonial images must be 5 MB or smaller', 400, 'TESTIMONIAL_IMAGE_TOO_LARGE');
  const { width, height } = imageDimensions(file);
  if (!width || !height) throw new AppError('Testimonial image is corrupted or has invalid dimensions', 400, 'INVALID_TESTIMONIAL_IMAGE');
  if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) throw new AppError('Testimonial images must be at least 300 × 300 pixels', 400, 'TESTIMONIAL_IMAGE_TOO_SMALL');
};

exports.listAdmin = async (tenantId) => {
  const [settings, testimonials] = await Promise.all([getSettings(pool, tenantId), pool.query('SELECT * FROM HOMEPAGE_TESTIMONIALS WHERE tenant_id=$1 ORDER BY display_order ASC, id ASC', [tenantId])]);
  return { settings: presentSettings(settings), testimonials: testimonials.rows.map(present) };
};

exports.listPublic = async (tenantId) => {
  const settings = presentSettings(await getSettings(pool, tenantId));
  if (!settings.enabled) return { settings, testimonials: [] };
  const result = await pool.query('SELECT * FROM HOMEPAGE_TESTIMONIALS WHERE tenant_id=$1 AND is_active=true ORDER BY display_order ASC, id ASC LIMIT $2', [tenantId, settings.max_cards]);
  return { settings, testimonials: result.rows.map(present) };
};

exports.saveSettings = async (tenantId, input) => {
  const result = await pool.query(
    `INSERT INTO HOMEPAGE_TESTIMONIAL_SETTINGS (tenant_id,enabled,heading,subheading,max_cards,card_size,spacing,desktop_visible_count,tablet_visible_count,mobile_visible_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,heading=EXCLUDED.heading,subheading=EXCLUDED.subheading,max_cards=EXCLUDED.max_cards,card_size=EXCLUDED.card_size,spacing=EXCLUDED.spacing,desktop_visible_count=EXCLUDED.desktop_visible_count,tablet_visible_count=EXCLUDED.tablet_visible_count,mobile_visible_count=EXCLUDED.mobile_visible_count,updated_at=now()
     RETURNING *`,
    [tenantId, input.enabled, input.heading, input.subheading, input.max_cards, input.card_size, input.spacing, input.desktop_visible_count, input.tablet_visible_count, input.mobile_visible_count]
  );
  return presentSettings(result.rows[0]);
};

exports.create = async (tenantId, input, file) => {
  validateImage(file); const client = await pool.connect(); let uploadedPath = null;
  try {
    await client.query('BEGIN'); const upload = file ? await uploadToSupabase(file, `homepage-testimonials/${tenantId}`) : null; uploadedPath = upload?.path || null;
    const nextOrder = (await client.query('SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM HOMEPAGE_TESTIMONIALS WHERE tenant_id=$1', [tenantId])).rows[0].next_order;
    const id = uuidv4(); await client.query('INSERT INTO HOMEPAGE_TESTIMONIALS (id,tenant_id,customer_name,customer_context,content,image_url,image_storage_path,image_fit,image_position_x,image_position_y,rating,display_order,is_active,is_sample) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)', [id, tenantId, input.customer_name, nullable(input.customer_context), input.content, upload?.url || null, upload?.path || null, input.image_fit || 'cover', input.image_position_x ?? 50, input.image_position_y ?? 50, nullable(input.rating), nextOrder, input.is_active]);
    await client.query('COMMIT'); return present(await getCard(pool, tenantId, id));
  } catch (error) { await client.query('ROLLBACK'); if (uploadedPath) await supabase.storage.from('products').remove([uploadedPath]); throw error; } finally { client.release(); }
};

exports.update = async (tenantId, id, input, file) => {
  validateImage(file); const client = await pool.connect(); let uploadedPath = null;
  try {
    await client.query('BEGIN'); const existing = await getCard(client, tenantId, id, true); const upload = file ? await uploadToSupabase(file, `homepage-testimonials/${tenantId}`) : null; uploadedPath = upload?.path || null;
    const removeImage = input.remove_image === true || input.remove_image === 'true'; const imageUrl = upload?.url || (removeImage ? null : existing.image_url); const imagePath = upload?.path || (removeImage ? null : existing.image_storage_path);
    await client.query('UPDATE HOMEPAGE_TESTIMONIALS SET customer_name=$3,customer_context=$4,content=$5,image_url=$6,image_storage_path=$7,image_fit=$8,image_position_x=$9,image_position_y=$10,rating=$11,is_active=$12,updated_at=now() WHERE id=$1 AND tenant_id=$2', [id, tenantId, input.customer_name ?? existing.customer_name, nullable(input.customer_context ?? existing.customer_context), input.content ?? existing.content, imageUrl, imagePath, input.image_fit ?? existing.image_fit ?? 'cover', input.image_position_x ?? existing.image_position_x ?? 50, input.image_position_y ?? existing.image_position_y ?? 50, nullable(input.rating ?? existing.rating), input.is_active === undefined ? existing.is_active : input.is_active,]);
    await client.query('COMMIT'); if ((file || removeImage) && existing.image_storage_path) await supabase.storage.from('products').remove([existing.image_storage_path]); return present(await getCard(pool, tenantId, id));
  } catch (error) { await client.query('ROLLBACK'); if (uploadedPath) await supabase.storage.from('products').remove([uploadedPath]); throw error; } finally { client.release(); }
};

exports.remove = async (tenantId, id) => { const client = await pool.connect(); try { await client.query('BEGIN'); const row = await getCard(client, tenantId, id, true); await client.query('DELETE FROM HOMEPAGE_TESTIMONIALS WHERE id=$1 AND tenant_id=$2', [id, tenantId]); await client.query('COMMIT'); if (row.image_storage_path) await supabase.storage.from('products').remove([row.image_storage_path]); return { id }; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } };
exports.setActive = async (tenantId, id, isActive) => { await pool.query('UPDATE HOMEPAGE_TESTIMONIALS SET is_active=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2', [id, tenantId, isActive]); return present(await getCard(pool, tenantId, id)); };
exports.reorder = async (tenantId, orderedIds) => { const client = await pool.connect(); try { await client.query('BEGIN'); const current = await client.query('SELECT id FROM HOMEPAGE_TESTIMONIALS WHERE tenant_id=$1 ORDER BY display_order ASC FOR UPDATE', [tenantId]); const ids = current.rows.map((row) => row.id); if (ids.length !== orderedIds.length || new Set(orderedIds).size !== ids.length || orderedIds.some((id) => !ids.includes(id))) throw new AppError('Reorder request must contain every testimonial exactly once', 400, 'INVALID_TESTIMONIAL_ORDER'); for (const [order, id] of orderedIds.entries()) await client.query('UPDATE HOMEPAGE_TESTIMONIALS SET display_order=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2', [id, tenantId, order]); await client.query('COMMIT'); return exports.listAdmin(tenantId); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } };
