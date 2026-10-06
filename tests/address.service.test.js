const assert = require('node:assert/strict');
const test = require('node:test');
const { authenticate } = require('../src/middleware/auth');

const databaseModulePath = require.resolve('../src/config/db');
const addressServicePath = require.resolve('../src/modules/addresses/address.service');

const clone = (row) => ({ ...row });

const createAddressPool = () => {
  const state = {
    customers: [
      { id: 'customer-1', tenant_id: 't1' },
      { id: 'customer-2', tenant_id: 't1' },
      { id: 'customer-1', tenant_id: 't2' },
    ],
    addresses: [],
    locks: new Map(),
    sequence: 0,
  };

  const activeAddresses = (tenantId, customerId) => state.addresses.filter((address) => (
    address.tenant_id === tenantId && address.customer_id === customerId && !address.is_deleted
  ));

  const releaseLock = (client) => {
    if (!client.lockKey) return;
    const lock = state.locks.get(client.lockKey);
    client.lockKey = null;
    const next = lock?.waiters.shift();
    if (next) next();
    else state.locks.delete(lock?.key);
  };

  const acquireLock = async (client, key) => {
    const lock = state.locks.get(key);
    if (!lock) {
      state.locks.set(key, { key, waiters: [] });
      client.lockKey = key;
      return;
    }
    await new Promise((resolve) => lock.waiters.push(() => {
      client.lockKey = key;
      resolve();
    }));
  };

  const query = async (client, sql, params = []) => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement === 'BEGIN') return { rows: [] };
    if (statement === 'COMMIT' || statement === 'ROLLBACK') {
      releaseLock(client);
      return { rows: [] };
    }
    if (statement.includes('FROM CUSTOMERS') && statement.includes('FOR UPDATE')) {
      const [customerId, tenantId] = params;
      const customer = state.customers.find((item) => item.id === customerId && item.tenant_id === tenantId);
      if (!customer) return { rows: [] };
      await acquireLock(client, `${tenantId}:${customerId}`);
      return { rows: [clone(customer)] };
    }
    if (statement.includes('FROM ADDRESSES')) {
      if (statement.includes('WHERE id = $1')) {
        const [addressId, tenantId, customerId] = params;
        const address = state.addresses.find((item) => item.id === addressId && item.tenant_id === tenantId && item.customer_id === customerId && (statement.includes('is_deleted = false') ? !item.is_deleted : true));
        return { rows: address ? [clone(address)] : [] };
      }
      const [tenantId, customerId] = params;
      const rows = activeAddresses(tenantId, customerId).map(clone);
      if (statement.includes('ORDER BY created_at ASC')) rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      if (statement.includes('ORDER BY is_default DESC')) rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || b.updated_at.localeCompare(a.updated_at));
      return { rows: /LIMIT 1(?:\s|$)/.test(statement) ? rows.slice(0, 1) : rows };
    }
    if (statement.startsWith('UPDATE ADDRESSES')) {
      if (statement.includes('SET is_default = false')) {
        const [tenantId, customerId] = params;
        activeAddresses(tenantId, customerId).forEach((address) => { if (address.is_default) address.is_default = false; });
        return { rows: [] };
      }
      if (statement.includes('SET is_default = true')) {
        const [addressId, tenantId, customerId] = params;
        const address = state.addresses.find((item) => item.id === addressId && item.tenant_id === tenantId && item.customer_id === customerId && !item.is_deleted);
        if (!address) return { rows: [] };
        address.is_default = true;
        address.updated_at = `updated-${++state.sequence}`;
        return { rows: [clone(address)] };
      }
      if (statement.includes('SET is_deleted = true')) {
        const [addressId, tenantId, customerId] = params;
        const address = state.addresses.find((item) => item.id === addressId && item.tenant_id === tenantId && item.customer_id === customerId && !item.is_deleted);
        if (address) {
          address.is_deleted = true;
          address.is_default = false;
        }
        return { rows: [] };
      }
      const [addressId, tenantId, customerId, fullName, phone, line1, line2, landmark, city, stateCode, countryCode, pincode] = params;
      const address = state.addresses.find((item) => item.id === addressId && item.tenant_id === tenantId && item.customer_id === customerId && !item.is_deleted);
      if (!address) return { rows: [] };
      Object.assign(address, { full_name: fullName, phone, line1, line2, landmark, city, state_code: stateCode, country_code: countryCode, pincode, updated_at: `updated-${++state.sequence}` });
      return { rows: [clone(address)] };
    }
    if (statement.startsWith('INSERT INTO ADDRESSES')) {
      const [id, tenantId, customerId, fullName, phone, line1, line2, landmark, city, stateCode, countryCode, pincode, isDefault] = params;
      const address = {
        id, tenant_id: tenantId, customer_id: customerId, full_name: fullName, phone, line1, line2, landmark,
        city, state_code: stateCode, country_code: countryCode, pincode, is_default: isDefault,
        is_deleted: false, created_at: `created-${++state.sequence}`, updated_at: `updated-${state.sequence}`,
      };
      state.addresses.push(address);
      return { rows: [clone(address)] };
    }
    throw new Error(`Unexpected query in address test double: ${statement}`);
  };

  return {
    state,
    query(sql, params) { return query({}, sql, params); },
    async connect() {
      const client = { lockKey: null, query(sql, params) { return query(client, sql, params); }, release() { releaseLock(client); } };
      return client;
    },
  };
};

const loadAddressService = (t) => {
  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalAddressService = require.cache[addressServicePath];
  const pool = createAddressPool();
  delete require.cache[addressServicePath];
  require.cache[databaseModulePath] = { exports: pool };
  const service = require('../src/modules/addresses/address.service');
  t.after(() => {
    delete require.cache[addressServicePath];
    if (originalAddressService) require.cache[addressServicePath] = originalAddressService;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
  });
  return { service, pool };
};

const validAddress = (overrides = {}) => ({
  fullName: 'Ananya Natarajan', phone: '98765 43210', addressLine1: '12 Temple Road', addressLine2: '', landmark: '',
  city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'IN', isDefault: false, ...overrides,
});

test('unauthenticated address requests are rejected before address service access', async () => {
  const error = await new Promise((resolve) => authenticate(
    { headers: {}, tenantId: 't1', path: '/addresses' },
    {},
    resolve
  ));
  assert.equal(error?.statusCode, 401);
});

test('address lifecycle is customer- and tenant-scoped, with deterministic default promotion', async (t) => {
  const { service } = loadAddressService(t);
  const first = await service.create('t1', 'customer-1', validAddress());
  assert.equal(first.isDefault, true, 'the first active address becomes default');
  const second = await service.create('t1', 'customer-1', validAddress({ addressLine1: '14 Temple Road', city: 'Madurai' }));
  assert.equal((await service.list('t1', 'customer-1')).length, 2);
  await assert.rejects(service.update('t1', 'customer-2', first.id, validAddress()), /Address not found/);
  await assert.rejects(service.update('t2', 'customer-1', first.id, validAddress()), /Address not found/);

  const updated = await service.update('t1', 'customer-1', second.id, validAddress({ addressLine1: '14 Temple Road', city: 'Madurai', landmark: 'Near the hall' }));
  assert.equal(updated.landmark, 'Near the hall');
  const defaultAddress = await service.setDefault('t1', 'customer-1', second.id);
  assert.equal(defaultAddress.isDefault, true);
  await service.remove('t1', 'customer-1', second.id);

  const remaining = await service.list('t1', 'customer-1');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, first.id);
  assert.equal(remaining[0].isDefault, true, 'deleting the default promotes the oldest remaining active address');
  await assert.rejects(service.remove('t1', 'customer-1', second.id), /Address not found/);
});

test('concurrent default changes and duplicate submissions serialize per customer', async (t) => {
  const { service, pool } = loadAddressService(t);
  const duplicateInput = validAddress({ addressLine1: '99 Race Course Road' });
  const created = await Promise.all([service.create('t1', 'customer-1', duplicateInput), service.create('t1', 'customer-1', duplicateInput)]);
  assert.equal(created[0].id, created[1].id, 'a rapid duplicate create resolves to one saved address');
  assert.equal((await service.list('t1', 'customer-1')).length, 1);

  const second = await service.create('t1', 'customer-1', validAddress({ addressLine1: '100 Race Course Road' }));
  await Promise.all([service.setDefault('t1', 'customer-1', created[0].id), service.setDefault('t1', 'customer-1', second.id)]);
  const addresses = await service.list('t1', 'customer-1');
  assert.equal(addresses.filter((address) => address.isDefault).length, 1);
  assert.equal(pool.state.locks.size, 0, 'all customer row locks are released');
});
