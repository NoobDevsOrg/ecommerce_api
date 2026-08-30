const { v4: uuidv4 } = require('uuid');
const pool = require('../../config/db');
const { supabase } = require('../../config/supabase');
const { uploadToSupabase } = require('../../services/uploadService');
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');

const MAX_CAMPAIGN_BANNERS = 6;
const MAX_DEFAULT_BANNERS = 3;
const HERO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BANNER_COLUMNS = `
  b.*, pi.base_url AS product_image_url, pi.alt_text AS product_image_alt_text,
  p.id AS product_id, p.name AS product_name, p.slug AS product_slug, p.price AS product_price,
  COALESCE(pi.base_url, b.image_base_url) AS image_url,
  COALESCE(pi.alt_text, b.image_alt_text) AS image_alt_text_resolved`;
const nullable = (value) => (value === undefined || value === null || value === '' ? null : value);

const deriveStatus = (banner, now = new Date()) => {
  if (!banner.is_published) return 'Draft';
  if (banner.banner_type === 'default') return banner.image_url ? 'Active' : 'Invalid';
  if (banner.start_at && new Date(banner.start_at) > now) return 'Scheduled';
  if (banner.end_at && new Date(banner.end_at) <= now) return 'Expired';
  return banner.image_url ? 'Active' : 'Invalid';
};

const presentBanner = (banner) => ({
  id: banner.id,
  banner_type: banner.banner_type,
  source_type: banner.source_type,
  product_image_id: banner.product_image_id,
  image: { id: banner.source_type === 'product_image' ? banner.product_image_id : null, url: banner.image_url || null, alt_text: banner.image_alt_text_resolved || null },
  // Convenience aliases for the existing visual components; they do not duplicate database data.
  image_url: banner.image_url || null,
  image_alt_text: banner.image_alt_text_resolved || null,
  image_missing: !banner.image_url,
  product: banner.product_id ? { id: banner.product_id, name: banner.product_name, slug: banner.product_slug, price: banner.product_price === null ? null : Number(banner.product_price) } : null,
  start_at: banner.start_at,
  end_at: banner.end_at,
  sort_order: banner.sort_order,
  is_published: banner.is_published,
  status: deriveStatus(banner),
  image_width: banner.source_type === 'uploaded' ? banner.image_width : null,
  image_height: banner.source_type === 'uploaded' ? banner.image_height : null,
  image_file_size: banner.source_type === 'uploaded' ? banner.image_file_size : null,
  image_mime_type: banner.source_type === 'uploaded' ? banner.image_mime_type : null,
  created_at: banner.created_at,
  updated_at: banner.updated_at,
});

const readImageMetadata = (file) => {
  if (!file || !file.buffer || !HERO_MIME_TYPES.has(file.mimetype)) throw new AppError('Hero images must be JPG, JPEG, PNG, or WebP', 400, 'INVALID_HERO_IMAGE');
  const data = file.buffer;
  let width = 0; let height = 0;
  if (file.mimetype === 'image/png' && data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (file.mimetype === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset < data.length - 8) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1]; offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (file.mimetype === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16);
    if (type === 'VP8X' && data.length >= 30) { width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3); }
    else if (type === 'VP8 ' && data.length >= 30) { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff; }
    else if (type === 'VP8L' && data.length >= 25) { const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
  }
  if (!width || !height) throw new AppError('Hero image is corrupted or has invalid dimensions', 400, 'INVALID_HERO_IMAGE');
  return { width, height, fileSize: file.size, mimeType: file.mimetype };
};

const validateSchedule = ({ bannerType, startAt, endAt }) => {
  if (bannerType === 'default' && (startAt || endAt)) throw new AppError('Default Hero cannot have a schedule', 400, 'INVALID_HERO_SCHEDULE');
  if (startAt && endAt && new Date(endAt) < new Date(startAt)) throw new AppError('End date must be after start date', 400, 'INVALID_HERO_SCHEDULE');
};

const verifyProductImage = async (client, tenantId, imageId) => {
  const result = await client.query(
    `SELECT pi.id, pi.base_url FROM product_images pi JOIN products p ON p.id = pi.product_id
     WHERE pi.id = $1 AND pi.tenant_id = $2 AND p.tenant_id = $2 AND p.is_deleted = false`, [imageId, tenantId]
  );
  if (!result.rows.length) throw new NotFoundError('Product image');
  if (!result.rows[0].base_url) throw new AppError('The selected product image is unusable as a Hero', 400, 'INVALID_HERO_IMAGE');
};

const getBannerRow = async (client, tenantId, id, lock = false) => {
  const result = await client.query(
    `SELECT ${BANNER_COLUMNS} FROM home_hero_banners b
     LEFT JOIN product_images pi ON pi.id = b.product_image_id AND pi.tenant_id = b.tenant_id
     LEFT JOIN products p ON p.id = pi.product_id AND p.tenant_id = b.tenant_id
     WHERE b.id = $1 AND b.tenant_id = $2 ${lock ? 'FOR UPDATE OF b' : ''}`, [id, tenantId]
  );
  if (!result.rows.length) throw new NotFoundError('Hero banner');
  return result.rows[0];
};

const resolveValues = async (client, tenantId, input, file, existing = null) => {
  const sourceType = input.source_type || existing?.source_type;
  const bannerType = input.banner_type || existing?.banner_type;
  if (!['default', 'campaign'].includes(bannerType) || !['product_image', 'uploaded'].includes(sourceType)) throw new AppError('Invalid Hero banner or source type', 400, 'INVALID_HERO_BANNER');
  const startAt = bannerType === 'campaign' ? nullable(input.start_at) : null;
  const endAt = bannerType === 'campaign' ? nullable(input.end_at) : null;
  validateSchedule({ bannerType, startAt, endAt });
  const common = { banner_type: bannerType, source_type: sourceType, start_at: startAt, end_at: endAt, is_published: input.is_published === undefined ? (existing?.is_published ?? false) : input.is_published };
  if (sourceType === 'product_image') {
    const imageId = input.product_image_id || (existing?.source_type === 'product_image' ? existing.product_image_id : null);
    if (!imageId) throw new AppError('Select a product image for this Hero', 400, 'HERO_IMAGE_REQUIRED');
    await verifyProductImage(client, tenantId, imageId);
    return { ...common, product_image_id: imageId, upload: null };
  }
  if (!file && (!existing || existing.source_type !== 'uploaded')) throw new AppError('Upload a Hero image', 400, 'HERO_IMAGE_REQUIRED');
  return { ...common, product_image_id: null, upload: file ? readImageMetadata(file) : null };
};

const listQuery = `SELECT ${BANNER_COLUMNS} FROM home_hero_banners b
  LEFT JOIN product_images pi ON pi.id = b.product_image_id AND pi.tenant_id = b.tenant_id
  LEFT JOIN products p ON p.id = pi.product_id AND p.tenant_id = b.tenant_id`;

exports.listAdmin = async (tenantId) => {
  const result = await pool.query(`${listQuery} WHERE b.tenant_id = $1 ORDER BY CASE WHEN b.banner_type = 'default' THEN 0 ELSE 1 END, b.sort_order ASC, b.created_at ASC`, [tenantId]);
  return result.rows.map(presentBanner);
};
exports.getById = async (tenantId, id) => presentBanner(await getBannerRow(pool, tenantId, id));

exports.create = async (tenantId, input, file) => {
  const client = await pool.connect(); let uploadedPath = null;
  try {
    await client.query('BEGIN');
    const values = await resolveValues(client, tenantId, input, file);
    await client.query('LOCK TABLE home_hero_banners IN SHARE ROW EXCLUSIVE MODE');
    const maxForType = values.banner_type === 'default' ? MAX_DEFAULT_BANNERS : MAX_CAMPAIGN_BANNERS;
    const count = await client.query(`SELECT count(*)::int AS count FROM home_hero_banners WHERE tenant_id=$1 AND banner_type=$2`, [tenantId, values.banner_type]);
    if (count.rows[0].count >= maxForType) throw new ConflictError(`A tenant can have at most ${maxForType} ${values.banner_type} Heroes`);
    const upload = file ? await uploadToSupabase(file, `hero-banners/${tenantId}`) : null; uploadedPath = upload?.path || null;
    const id = uuidv4();
    const nextOrder = values.banner_type === 'campaign' ? (await client.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM home_hero_banners WHERE tenant_id=$1 AND banner_type='campaign'`, [tenantId])).rows[0].sort_order : 0;
    await client.query(
      `INSERT INTO home_hero_banners (
        id, tenant_id, banner_type, source_type, product_image_id, image_public_id, image_base_url, image_storage_path,
        image_width, image_height, image_file_size, image_mime_type, image_alt_text, start_at, end_at, sort_order, is_published, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
      [id, tenantId, values.banner_type, values.source_type, values.product_image_id, null, upload?.url || null, upload?.path || null, values.upload?.width || null, values.upload?.height || null, values.upload?.fileSize || null, values.upload?.mimeType || null, nullable(input.image_alt_text), values.start_at, values.end_at, nextOrder, values.is_published, 'system']
    );
    await client.query('COMMIT'); return exports.getById(tenantId, id);
  } catch (error) {
    await client.query('ROLLBACK'); if (uploadedPath) await supabase.storage.from('products').remove([uploadedPath]);
    if (error.code === '23505') throw new ConflictError('Hero configuration conflicts with an existing record');
    throw error;
  } finally { client.release(); }
};

exports.update = async (tenantId, id, input, file) => {
  const client = await pool.connect(); let uploadedPath = null;
  try {
    await client.query('BEGIN');
    const existing = await getBannerRow(client, tenantId, id, true);
    const values = await resolveValues(client, tenantId, { ...existing, ...input }, file, existing);
    if (values.banner_type !== existing.banner_type) throw new AppError('Banner type cannot be changed', 400, 'INVALID_HERO_BANNER');
    const upload = file ? await uploadToSupabase(file, `hero-banners/${tenantId}`) : null; uploadedPath = upload?.path || null;
    await client.query(
      `UPDATE home_hero_banners SET source_type=$3, product_image_id=$4, image_public_id=$5, image_base_url=$6, image_storage_path=$7,
       image_width=$8, image_height=$9, image_file_size=$10, image_mime_type=$11, image_alt_text=$12, start_at=$13, end_at=$14,
       is_published=$15, updated_at=now(), updated_by='system' WHERE id=$1 AND tenant_id=$2`,
      [id, tenantId, values.source_type, values.product_image_id, null,
       values.source_type === 'uploaded' ? (upload?.url || existing.image_base_url) : null,
       values.source_type === 'uploaded' ? (upload?.path || existing.image_storage_path) : null,
       values.source_type === 'uploaded' ? (values.upload?.width || existing.image_width) : null,
       values.source_type === 'uploaded' ? (values.upload?.height || existing.image_height) : null,
       values.source_type === 'uploaded' ? (values.upload?.fileSize || existing.image_file_size) : null,
       values.source_type === 'uploaded' ? (values.upload?.mimeType || existing.image_mime_type) : null,
       values.source_type === 'uploaded' ? (nullable(input.image_alt_text) ?? existing.image_alt_text) : null,
       values.start_at, values.end_at, values.is_published]
    );
    await client.query('COMMIT');
    if (existing.source_type === 'uploaded' && existing.image_storage_path && (file || values.source_type !== 'uploaded')) await supabase.storage.from('products').remove([existing.image_storage_path]);
    return exports.getById(tenantId, id);
  } catch (error) {
    await client.query('ROLLBACK'); if (uploadedPath) await supabase.storage.from('products').remove([uploadedPath]); throw error;
  } finally { client.release(); }
};

exports.remove = async (tenantId, id) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const banner = await getBannerRow(client, tenantId, id, true);
    await client.query('DELETE FROM home_hero_banners WHERE id=$1 AND tenant_id=$2', [id, tenantId]); await client.query('COMMIT');
    if (banner.source_type === 'uploaded' && banner.image_storage_path) await supabase.storage.from('products').remove([banner.image_storage_path]);
    return { id };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

exports.setPublished = async (tenantId, id, isPublished) => {
  const result = await pool.query(`UPDATE home_hero_banners SET is_published=$3, updated_at=now(), updated_by='system' WHERE id=$1 AND tenant_id=$2 RETURNING id`, [id, tenantId, isPublished]);
  if (!result.rows.length) throw new NotFoundError('Hero banner'); return exports.getById(tenantId, id);
};

exports.reorder = async (tenantId, bannerType, orderedIds) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!['default', 'campaign'].includes(bannerType)) throw new AppError('Invalid Hero banner type', 400, 'INVALID_HERO_BANNER');
    const current = await client.query(`SELECT id FROM home_hero_banners WHERE tenant_id=$1 AND banner_type=$2 ORDER BY sort_order ASC FOR UPDATE`, [tenantId, bannerType]);
    const currentIds = current.rows.map((row) => row.id);
    if (orderedIds.length !== currentIds.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !currentIds.includes(id))) throw new AppError(`Reorder request must contain every ${bannerType} Hero exactly once`, 400, 'INVALID_HERO_ORDER');
    for (const [index, bannerId] of orderedIds.entries()) await client.query(`UPDATE home_hero_banners SET sort_order=$3, updated_at=now(), updated_by='system' WHERE id=$1 AND tenant_id=$2`, [bannerId, tenantId, index]);
    await client.query('COMMIT'); return exports.listAdmin(tenantId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

exports.listPublic = async (tenantId) => {
  const campaigns = await pool.query(`${listQuery}
    WHERE b.tenant_id=$1 AND b.banner_type='campaign' AND b.is_published=true
      AND (b.start_at IS NULL OR b.start_at <= now()) AND (b.end_at IS NULL OR b.end_at > now())
    ORDER BY b.sort_order ASC LIMIT ${MAX_CAMPAIGN_BANNERS}`, [tenantId]);
  const active = campaigns.rows.map(presentBanner).filter((banner) => !banner.image_missing);
  if (active.length) return { banners: active, fallback_used: false };
  const fallback = await pool.query(`${listQuery} WHERE b.tenant_id=$1 AND b.banner_type='default' AND b.is_published=true ORDER BY b.sort_order ASC LIMIT ${MAX_DEFAULT_BANNERS}`, [tenantId]);
  return { banners: fallback.rows.map(presentBanner).filter((banner) => !banner.image_missing), fallback_used: true };
};
