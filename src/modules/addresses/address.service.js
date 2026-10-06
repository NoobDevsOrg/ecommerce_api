const crypto = require('crypto');
const pool = require('../../config/db');
const { AuthorizationError, NotFoundError } = require('../../utils/errors');

const presentAddress = (row) => ({
  // Saved addresses are intentionally mutable customer data. A future order
  // module must copy this projection into an immutable order-address snapshot.
  id: row.id,
  fullName: row.full_name,
  phone: row.phone,
  addressLine1: row.line1,
  addressLine2: row.line2,
  landmark: row.landmark,
  city: row.city,
  state: row.state_code,
  pincode: row.pincode,
  country: row.country_code,
  isDefault: Boolean(row.is_default),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const normalizeOptional = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const normalizePhone = (value, country = 'IN') => {
  const compact = String(value).replace(/[\s()-]/g, '');
  if (compact.startsWith('+')) return `+${compact.slice(1).replace(/\D/g, '')}`;
  const digits = compact.replace(/\D/g, '');
  if (String(country).toUpperCase() === 'IN') {
    return digits.startsWith('91') && digits.length === 12 ? `+${digits}` : `+91${digits}`;
  }
  return digits;
};

const toValues = (input) => ({
  fullName: input.fullName.trim(),
  phone: normalizePhone(input.phone, input.country),
  line1: input.addressLine1.trim(),
  line2: normalizeOptional(input.addressLine2),
  landmark: normalizeOptional(input.landmark),
  city: input.city.trim(),
  state: input.state.trim(),
  pincode: input.pincode.trim(),
  country: input.country.trim().toUpperCase(),
});

const isDuplicateAddress = (row, values) => (
  row.full_name === values.fullName
  && row.phone === values.phone
  && row.line1 === values.line1
  && row.line2 === values.line2
  && row.landmark === values.landmark
  && row.city === values.city
  && row.state_code === values.state
  && row.country_code === values.country
  && row.pincode === values.pincode
);

const lockCustomer = async (client, tenantId, customerId) => {
  const result = await client.query(
    `SELECT id
     FROM CUSTOMERS
     WHERE id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [customerId, tenantId]
  );

  if (!result.rows[0]) {
    throw new AuthorizationError('Customer access is required');
  }
};

const findOwnedAddress = async (client, tenantId, customerId, addressId, { includeDeleted = false, lock = false } = {}) => {
  const result = await client.query(
    `SELECT id, tenant_id, customer_id, full_name, phone, line1, line2, landmark,
            city, state_code, country_code, pincode, is_default, is_deleted,
            created_at, updated_at
     FROM ADDRESSES
     WHERE id = $1
       AND tenant_id = $2
       AND customer_id = $3
       ${includeDeleted ? '' : 'AND is_deleted = false'}
       ${lock ? 'FOR UPDATE' : ''}`,
    [addressId, tenantId, customerId]
  );

  return result.rows[0] || null;
};

const assertOwnedAddress = async (...args) => {
  const address = await findOwnedAddress(...args);
  if (!address) throw new NotFoundError('Address');
  return address;
};

const withCustomerTransaction = async (tenantId, customerId, operation) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The customer row exists even when no address exists, so this serializes
    // first-address/default-address writes as well as ordinary updates.
    await lockCustomer(client, tenantId, customerId);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const chooseDefault = async (client, tenantId, customerId) => {
  const replacement = await client.query(
    `SELECT id
     FROM ADDRESSES
     WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [tenantId, customerId]
  );

  if (!replacement.rows[0]) return null;

  await client.query(
    `UPDATE ADDRESSES
     SET is_default = true, updated_at = now(), updated_by = $3
     WHERE id = $1 AND tenant_id = $2`,
    [replacement.rows[0].id, tenantId, customerId]
  );
  return replacement.rows[0].id;
};

exports.list = async (tenantId, customerId) => {
  const result = await pool.query(
    `SELECT id, full_name, phone, line1, line2, landmark, city, state_code,
            country_code, pincode, is_default, created_at, updated_at
     FROM ADDRESSES
     WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false
     ORDER BY is_default DESC, updated_at DESC, id DESC
     LIMIT 100`,
    [tenantId, customerId]
  );
  return result.rows.map(presentAddress);
};

// Checkout uses this server-side projection instead of accepting a browser
// address payload. Order Core then persists it as immutable historical data.
exports.getOwnedActiveSnapshot = async (tenantId, customerId, addressId) => {
  const address = await assertOwnedAddress(pool, tenantId, customerId, addressId);
  return {
    sourceAddressId: address.id,
    fullName: address.full_name,
    phone: address.phone,
    addressLine1: address.line1,
    addressLine2: address.line2,
    landmark: address.landmark,
    city: address.city,
    state: address.state_code,
    pincode: address.pincode,
    country: address.country_code,
  };
};

const createInTransaction = async (client, tenantId, customerId, input, { customerLocked = false } = {}) => {
  if (!customerLocked) await lockCustomer(client, tenantId, customerId);
  const values = toValues(input);
  const activeAddresses = await client.query(
    `SELECT id, full_name, phone, line1, line2, landmark, city, state_code,
            country_code, pincode, is_default, created_at, updated_at
     FROM ADDRESSES
     WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false`,
    [tenantId, customerId]
  );
  const duplicate = activeAddresses.rows.find((address) => isDuplicateAddress(address, values));
  if (duplicate) return presentAddress(duplicate);

  const isDefault = input.isDefault || activeAddresses.rows.length === 0;

  if (isDefault) {
    await client.query(
      `UPDATE ADDRESSES
       SET is_default = false, updated_at = now(), updated_by = $3
       WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false AND is_default = true`,
      [tenantId, customerId, customerId]
    );
  }

  const result = await client.query(
    `INSERT INTO ADDRESSES
       (id, tenant_id, customer_id, full_name, phone, line1, line2, landmark,
        city, state_code, country_code, pincode, is_default, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $3, $3)
     RETURNING id, full_name, phone, line1, line2, landmark, city, state_code,
               country_code, pincode, is_default, created_at, updated_at`,
    [
      crypto.randomUUID(), tenantId, customerId, values.fullName, values.phone,
      values.line1, values.line2, values.landmark, values.city, values.state,
      values.country, values.pincode, isDefault,
    ]
  );

  return presentAddress(result.rows[0]);
};

exports.create = async (tenantId, customerId, input) => withCustomerTransaction(
  tenantId,
  customerId,
  async (client) => createInTransaction(client, tenantId, customerId, input, { customerLocked: true })
);

// Checkout identity finalization uses this only inside its own transaction,
// after it has verified the customer identity. Keeping creation here preserves
// the existing address normalization, duplicate detection, and default rules.
exports.createInTransaction = createInTransaction;

exports.update = async (tenantId, customerId, addressId, input) => withCustomerTransaction(tenantId, customerId, async (client) => {
  await assertOwnedAddress(client, tenantId, customerId, addressId, { lock: true });
  const values = toValues(input);
  const result = await client.query(
    `UPDATE ADDRESSES
     SET full_name = $4, phone = $5, line1 = $6, line2 = $7, landmark = $8,
         city = $9, state_code = $10, country_code = $11, pincode = $12,
         updated_at = now(), updated_by = $3
     WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 AND is_deleted = false
     RETURNING id, full_name, phone, line1, line2, landmark, city, state_code,
               country_code, pincode, is_default, created_at, updated_at`,
    [
      addressId, tenantId, customerId, values.fullName, values.phone, values.line1,
      values.line2, values.landmark, values.city, values.state, values.country, values.pincode,
    ]
  );
  return presentAddress(result.rows[0]);
});

exports.setDefault = async (tenantId, customerId, addressId) => withCustomerTransaction(tenantId, customerId, async (client) => {
  await assertOwnedAddress(client, tenantId, customerId, addressId, { lock: true });
  await client.query(
    `UPDATE ADDRESSES
     SET is_default = false, updated_at = now(), updated_by = $3
     WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false AND is_default = true`,
    [tenantId, customerId, customerId]
  );
  const result = await client.query(
    `UPDATE ADDRESSES
     SET is_default = true, updated_at = now(), updated_by = $3
     WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 AND is_deleted = false
     RETURNING id, full_name, phone, line1, line2, landmark, city, state_code,
               country_code, pincode, is_default, created_at, updated_at`,
    [addressId, tenantId, customerId]
  );
  return presentAddress(result.rows[0]);
});

exports.remove = async (tenantId, customerId, addressId) => withCustomerTransaction(tenantId, customerId, async (client) => {
  const address = await assertOwnedAddress(client, tenantId, customerId, addressId, { lock: true });
  await client.query(
    `UPDATE ADDRESSES
     SET is_deleted = true, is_default = false, updated_at = now(), updated_by = $3
     WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 AND is_deleted = false`,
    [addressId, tenantId, customerId]
  );

  const newDefaultAddressId = address.is_default
    ? await chooseDefault(client, tenantId, customerId)
    : null;

  return { id: addressId, defaultAddressId: newDefaultAddressId };
});
