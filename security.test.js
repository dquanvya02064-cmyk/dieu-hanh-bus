const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccessAdminRequest, createAdminToken, hashPassword, verifyAdminToken, verifyPassword } = require('./security');

test('password hashes verify without storing plaintext', async () => {
  const password = 'a-long-test-password';
  const hash = await hashPassword(password);

  assert.notEqual(hash, password);
  assert.equal((await verifyPassword(password, hash)).valid, true);
  assert.equal((await verifyPassword('wrong-password', hash)).valid, false);
});

test('legacy plaintext passwords can be detected for migration', async () => {
  assert.deepEqual(await verifyPassword('legacy-password', 'legacy-password'), {
    valid: true,
    needsRehash: true
  });
});

test('admin tokens reject tampering and expiration', () => {
  const secret = 'a-test-secret-that-is-long-enough-for-hmac';
  const now = 1_800_000_000_000;
  const token = createAdminToken('operator', secret, now, 2);

  assert.equal(verifyAdminToken(token, secret, now).username, 'operator');
  assert.equal(verifyAdminToken(token, secret, now).tokenVersion, 2);
  assert.equal(verifyAdminToken(`${token}x`, secret, now), null);
  assert.equal(verifyAdminToken(token, secret, now + 8 * 60 * 60 * 1000), null);
});

test('endpoint permissions deny access outside the assigned role', () => {
  const chartStaff = { role: 'staff', permissions: ['bieudo'] };
  const vehicleStaff = { role: 'staff', permissions: ['xe'] };
  const master = { role: 'master', permissions: [] };

  assert.equal(canAccessAdminRequest('/api/luu-bieu-do', {}, chartStaff), true);
  assert.equal(canAccessAdminRequest('/api/admin/dang-ky', {}, chartStaff), false);
  assert.equal(canAccessAdminRequest('/api/xoa-xe', {}, vehicleStaff), true);
  assert.equal(canAccessAdminRequest('/api/bus-data', {}, vehicleStaff), false);
  assert.equal(canAccessAdminRequest('/api/admin/dang-ky', {}, master), true);
});