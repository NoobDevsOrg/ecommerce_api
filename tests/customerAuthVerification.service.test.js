const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
process.env.CHECKOUT_OTP_SECRET ||= 'phase-2-5-test-secret';
const { PURPOSES, createCustomerAuthVerificationService } = require('../src/modules/auth/customerAuthVerification.service');
const now = new Date('2026-10-03T00:00:00Z');
const harness = ({ generateCode } = {}) => {
  const rows = []; const sent = []; const client = { release() {}, async query(sql, p = []) {
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    if (sql.startsWith('SELECT * FROM CUSTOMER_AUTH_VERIFICATIONS')) return { rows: rows.filter((r) => r.tenant_id === p[0] && r.purpose === p[1] && r.normalized_email === p[2] && !r.consumed_at) };
    if (sql.startsWith('INSERT INTO CUSTOMER_AUTH_VERIFICATIONS')) { rows.push({ id: p[0], tenant_id: p[1], purpose: p[2], normalized_email: p[3], code_hash: p[4], expires_at: p[5], resend_available_at: p[6], send_count: 1, attempt_count: 0, consumed_at: null }); return { rows: [] }; }
    const row = rows.find((r) => r.id === p[p.length - 2] || r.id === p[0]);
    if (sql.startsWith('UPDATE CUSTOMER_AUTH_VERIFICATIONS SET code_hash')) { Object.assign(row, { code_hash: p[0], expires_at: p[1], resend_available_at: p[2], send_count: row.send_count + 1, attempt_count: 0 }); return { rows: [] }; }
    if (sql.includes('attempt_count=attempt_count+1')) { row.attempt_count += 1; return { rows: [] }; }
    if (sql.includes('SET consumed_at=now()')) { if (row.consumed_at) return { rows: [] }; row.consumed_at = now; return { rows: [{ id: row.id }] }; }
    throw new Error(sql);
  }};
  return { rows, sent, service: createCustomerAuthVerificationService({ database: { connect: async () => client }, now: () => now, generateCode, sendEmail: async (m) => sent.push(m) }) };
};
test('customer auth OTP is hashed, purpose/tenant isolated, single use, and returns the server cooldown timestamp', async () => {
  const h = harness({ generateCode: () => '482901' }); const challenge = await h.service.create({ tenantId: 't1', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'A@Example.com' }); const otp = h.sent[0].code;
  assert.equal(challenge.resendAvailableAt.toISOString(), '2026-10-03T00:01:00.000Z');
  assert.equal(h.sent[0].to, 'a@example.com'); assert.equal(otp, '482901'); assert.notEqual(h.rows[0].code_hash, otp); await assert.rejects(h.service.verify({ tenantId: 't1', purpose: PURPOSES.PASSWORD_RESET, email: 'a@example.com', otp }), /Invalid|expired/);
  await assert.rejects(h.service.verify({ tenantId: 't2', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'a@example.com', otp }), /Invalid|expired/);
  await h.service.verify({ tenantId: 't1', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'a@example.com', otp }); assert.ok(h.rows[0].consumed_at);
  await assert.rejects(h.service.verify({ tenantId: 't1', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'a@example.com', otp }), /Invalid|expired/);
});
test('wrong code counts attempts and resend replacement enforces cooldown', async () => {
  const h = harness(); await h.service.create({ tenantId: 't1', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'a@example.com' });
  await assert.rejects(h.service.verify({ tenantId: 't1', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'a@example.com', otp: '000000' }), /Invalid|expired/); assert.equal(h.rows[0].attempt_count, 1);
  await assert.rejects(h.service.create({ tenantId: 't1', purpose: PURPOSES.CUSTOMER_LOGIN, email: 'a@example.com' }), /Please wait/); assert.equal(h.rows.length, 1);
});
