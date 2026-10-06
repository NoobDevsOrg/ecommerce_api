const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const test = require('node:test');

const databaseModulePath = require.resolve('../src/config/db');
const authServicePath = require.resolve('../src/modules/auth/auth.service');

const hashToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const createLockedPool = (initialRefreshToken) => {
  const state = {
    auth: {
      id: 'auth-1',
      tenant_id: 't1',
      email: 'customer@example.com',
      customer_id: 'customer-1',
      staff_user_id: null,
      password_hash: 'not-used',
      is_active: true,
      reset_token: hashToken(initialRefreshToken),
      reset_token_exp: new Date(Date.now() + 60_000),
    },
    queryLog: [],
    locked: false,
    waiters: [],
  };

  const releaseLock = (client) => {
    if (!client.locked) return;
    client.locked = false;
    const next = state.waiters.shift();
    if (next) {
      next();
    } else {
      state.locked = false;
    }
  };

  const acquireLock = async (client) => {
    if (!state.locked) {
      state.locked = true;
      client.locked = true;
      return;
    }

    await new Promise((resolve) => state.waiters.push(() => {
      client.locked = true;
      resolve();
    }));
  };

  const createClient = () => {
    const client = {
      locked: false,
      released: false,
      async query(sql, params = []) {
        state.queryLog.push(sql);
        const statement = sql.replace(/\s+/g, ' ').trim();

        if (statement === 'BEGIN') return { rows: [] };
        if (statement === 'COMMIT' || statement === 'ROLLBACK') {
          releaseLock(client);
          return { rows: [] };
        }
        if (statement.includes('FROM AUTH') && statement.includes('FOR UPDATE')) {
          await acquireLock(client);
          return {
            rows: state.auth.id === params[0] && state.auth.tenant_id === params[1]
              ? [{
                  id: state.auth.id,
                  reset_token: state.auth.reset_token,
                  reset_token_exp: state.auth.reset_token_exp,
                  is_active: state.auth.is_active,
                }]
              : [],
          };
        }
        if (statement.includes('FROM AUTH a')) {
          return {
            rows: [{
              id: state.auth.id,
              email: state.auth.email,
              password_hash: state.auth.password_hash,
              is_active: state.auth.is_active,
              customer_id: state.auth.customer_id,
              staff_user_id: state.auth.staff_user_id,
              customer_name: 'Customer One',
              staff_name: null,
              role_id: null,
              role_code: null,
              user_type: 'customer',
            }],
          };
        }
        if (statement.startsWith('UPDATE AUTH SET reset_token')) {
          state.auth.reset_token = params[0];
          state.auth.reset_token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          return { rows: [] };
        }
        if (statement.startsWith('UPDATE AUTH SET last_login_at')) return { rows: [] };

        throw new Error(`Unexpected query in test double: ${statement}`);
      },
      release() {
        client.released = true;
        releaseLock(client);
      },
    };
    return client;
  };

  return {
    state,
    async connect() {
      return createClient();
    },
  };
};

test('concurrent refreshes serialize on the auth row and only one can rotate a token', async (t) => {
  const previousRefreshSecret = process.env.JWT_REFRESH_SECRET;
  const previousAccessSecret = process.env.JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = 'refresh-test-secret';
  process.env.JWT_SECRET = 'access-test-secret';

  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalAuthService = require.cache[authServicePath];
  const refreshToken = jwt.sign({ id: 'auth-1', tenant_id: 't1', jti: 'initial-token' }, process.env.JWT_REFRESH_SECRET, { expiresIn: '5m' });
  const pool = createLockedPool(refreshToken);

  delete require.cache[authServicePath];
  require.cache[databaseModulePath] = { exports: pool };
  const authService = require('../src/modules/auth/auth.service');

  t.after(() => {
    delete require.cache[authServicePath];
    if (originalAuthService) require.cache[authServicePath] = originalAuthService;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
    if (previousRefreshSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = previousRefreshSecret;
    if (previousAccessSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousAccessSecret;
  });

  const outcomes = await Promise.allSettled([
    authService.refreshSession(refreshToken, 't1'),
    authService.refreshSession(refreshToken, 't1'),
  ]);

  const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected');

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason.message, /no longer valid/);
  assert.notEqual(successes[0].value.refreshToken, refreshToken);
  assert.ok(pool.state.queryLog.some((query) => /FOR UPDATE/.test(query)));
});
