const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccessAdminRequest, canGrantAdminPermissions, canUpdateAdminPermissions, createAdminToken, expandAdminPermissions, hashPassword, verifyAdminToken, verifyPassword } = require('./security');
const { normalizeStopRecord, parseRoutes } = require('./stop-data');

test('stop records normalize route codes and require valid coordinates', () => {
  const stop = normalizeStopRecord({
    maDiem: '0012',
    tenDiem: 'Bến xe mẫu',
    kinhDo: '105.8',
    viDo: '21.02',
    tuyenDiQua: '09A, 45; 09A',
    thuHoi: 'x'
  }, 'stable-id');

  assert.equal(stop.id, 'stable-id');
  assert.deepEqual(stop.tuyenDiQua, ['09A', '45']);
  assert.equal(stop.thuHoi, true);
  assert.throws(() => normalizeStopRecord({ ...stop, kinhDo: '' }), /kinh độ/);
  assert.throws(() => normalizeStopRecord({ ...stop, viDo: '91' }), /vĩ độ/);
  assert.deepEqual(parseRoutes(['09a', ' 45A']), ['09A', '45A']);
});

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

test('legacy permissions expand without removing existing access', () => {
  const expanded = expandAdminPermissions(['bieudo']);
  assert.ok(expanded.includes('charts.view'));
  assert.ok(expanded.includes('charts.edit'));
  assert.ok(!expanded.includes('fleet.edit'));
  const legacyRoutePermissions = expandAdminPermissions(['tuyen']);
  assert.ok(legacyRoutePermissions.includes('vehicleModels.edit'));
  assert.ok(!legacyRoutePermissions.includes('stops.view'));
});

test('staff can grant only permissions they already hold', () => {
  const accountManager = { role: 'staff', permissions: ['users.create', 'users.permissions', 'charts.edit'] };
  assert.equal(canGrantAdminPermissions(['charts.view', 'users.create'], accountManager), true);
  assert.equal(canGrantAdminPermissions(['routes.edit'], accountManager), false);
  assert.equal(canGrantAdminPermissions(['routes.edit'], { role: 'master', permissions: [] }), true);
});

test('staff can update only permissions they hold and preserve unrelated permissions', () => {
  const accountManager = { role: 'staff', permissions: ['users.permissions', 'charts.edit'] };

  assert.equal(canUpdateAdminPermissions(['charts.edit', 'routes.edit'], ['charts.view', 'routes.edit'], accountManager), true);
  assert.equal(canUpdateAdminPermissions(['routes.edit'], ['routes.view'], accountManager), false);
  assert.equal(canUpdateAdminPermissions(['routes.edit'], ['routes.edit', 'charts.edit'], accountManager), true);
  assert.equal(canUpdateAdminPermissions(['routes.edit'], ['routes.edit'], { role: 'master', permissions: [] }), true);
});

test('admin view and edit permissions are enforced independently', () => {
  const chartViewer = { role: 'staff', permissions: ['charts.view'] };
  const chartEditor = { role: 'staff', permissions: ['charts.edit'] };
  const routeEditor = { role: 'staff', permissions: ['routes.edit'] };
  const routeScheduler = { role: 'staff', permissions: ['routes.edit', 'routes.schedule'] };
  const modelViewer = { role: 'staff', permissions: ['vehicleModels.view'] };
  const fleetTransfer = { role: 'staff', permissions: ['fleet.transfer'] };
  const notificationViewer = { role: 'staff', permissions: ['notifications.view'] };
  const appointmentViewer = { role: 'staff', permissions: ['appointments.view'] };
  const stopViewer = { role: 'staff', permissions: ['stops.view'] };
  const stopEditor = { role: 'staff', permissions: ['stops.edit'] };
  const stopImporter = { role: 'staff', permissions: ['stops.import'] };
  const stopStatusEditor = { role: 'staff', permissions: ['stops.status'] };
  const userManager = { role: 'staff', permissions: ['users.view', 'users.create', 'users.status'] };
  const master = { role: 'master', permissions: [] };

  assert.equal(canAccessAdminRequest('/api/danh-muc', { admin: 'true' }, chartViewer), true);
  assert.equal(canAccessAdminRequest('/api/luu-bieu-do', {}, chartViewer), false);
  assert.equal(canAccessAdminRequest('/api/luu-bieu-do', {}, chartEditor), true);
  assert.equal(canAccessAdminRequest('/api/toggle-status-tuyen', {}, routeEditor), false);
  assert.equal(canAccessAdminRequest('/api/tuyen-moi', {}, routeEditor), true);
  assert.equal(canAccessAdminRequest('/api/tuyen-moi', {}, routeEditor, { ngayApDung: '2999-01-01' }), false);
  assert.equal(canAccessAdminRequest('/api/tuyen-moi', {}, routeEditor, { ngayApDung: '01/01/2999' }), false);
  assert.equal(canAccessAdminRequest('/api/tuyen-moi', {}, routeEditor, { ngayApDung: '1.1.2999' }), false);
  assert.equal(canAccessAdminRequest('/api/tuyen-moi', {}, routeScheduler, { ngayApDung: '2999-01-01' }), true);
  assert.equal(canAccessAdminRequest('/api/admin/danh-sach-xe-mau', {}, modelViewer), true);
  assert.equal(canAccessAdminRequest('/api/admin/luu-xe-mau', {}, modelViewer), false);
  assert.equal(canAccessAdminRequest('/api/dieu-chuyen-xe-hang-loat', {}, fleetTransfer), true);
  assert.equal(canAccessAdminRequest('/api/admin/luu-doi-xe-tuyen', {}, fleetTransfer), false);
  assert.equal(canAccessAdminRequest('/api/admin/thong-bao-chi-tiet', { admin: 'true' }, notificationViewer), true);
  assert.equal(canAccessAdminRequest('/api/admin/luu-thong-bao', {}, notificationViewer), false);
  assert.equal(canAccessAdminRequest('/api/admin/lay-danh-sach-lich', {}, appointmentViewer), true);
  assert.equal(canAccessAdminRequest('/api/admin/chay-ngay-lich-hen', {}, appointmentViewer), false);
  assert.equal(canAccessAdminRequest('/api/admin/danh-sach-tai-khoan', {}, userManager), true);
  assert.equal(canAccessAdminRequest('/api/admin/dang-ky', {}, userManager, { role: 'staff' }), true);
  assert.equal(canAccessAdminRequest('/api/admin/dang-ky', {}, userManager, { role: 'master' }), false);
  assert.equal(canAccessAdminRequest('/api/admin/sua-tai-khoan', {}, userManager, { status: 'locked' }), true);
  assert.equal(canAccessAdminRequest('/api/admin/sua-tai-khoan', {}, userManager, { permissions: ['charts.view'] }), false);
  assert.equal(canAccessAdminRequest('/api/admin/xoa-tai-khoan', {}, userManager), false);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung', { readOnly: 'true' }, stopViewer), true);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung', {}, stopViewer), false);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung', {}, stopEditor), true);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung/import', {}, stopImporter), true);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung/import', {}, stopEditor), false);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung/trang-thai', {}, stopStatusEditor), true);
  assert.equal(canAccessAdminRequest('/api/admin/diem-dung/trang-thai-tuyen', {}, stopStatusEditor), true);
  assert.equal(canAccessAdminRequest('/api/bus-data', {}, userManager), false);
  assert.equal(canAccessAdminRequest('/api/admin/dang-ky', {}, master), true);
});