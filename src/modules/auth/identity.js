const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

module.exports = { normalizeEmail };
