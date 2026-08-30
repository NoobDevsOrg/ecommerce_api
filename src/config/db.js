const { Pool } = require('pg');
require('dotenv').config();
const Logger = require('../utils/logger');

const isSslEnabled = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
const rejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() === 'true';

const normalizeConnectionString = (rawConnectionString) => {
  if (!rawConnectionString) {
    return rawConnectionString;
  }

  try {
    const parsed = new URL(rawConnectionString);

    // Avoid SSL semantics conflicts between URL params and explicit pg ssl config.
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('sslcert');
    parsed.searchParams.delete('sslkey');
    parsed.searchParams.delete('sslrootcert');
    parsed.searchParams.delete('sslcrl');
    parsed.searchParams.delete('uselibpqcompat');

    return parsed.toString();
  } catch (_error) {
    return rawConnectionString;
  }
};
console.log("aaaaaaaaaaaaaaaaaaaaaaa",process.env.DATABASE_URL);
const connectionString = normalizeConnectionString(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString,

  // ssl: isSslEnabled
  //   ? {
  //       rejectUnauthorized,
  //     }
  //   : false,
 ssl: false,

  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

pool.on('error', (err) => {
  Logger.error('Unexpected error on idle DB client', { message: err.message });
});

module.exports = pool;