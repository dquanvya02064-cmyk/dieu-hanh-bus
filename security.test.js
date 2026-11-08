const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccessAdminRequest, canGrantAdminPermissions, canUpdateAdminPermissions, createAdminToken, expandAdminPermissions, hashPassword, verifyAdminToken, verifyPassword } = require('./security');
const { filterPublicStopData, mergeDuplicateStopRows, mergeRouteDirectionAssignments, migrateStopRouteAssignments, normalizeStopRecord, parseRouteDirection, parseRoutes } = require('./stop-data');
const { routeDirection } = require('./public/stop-import');

test('stop records normalize route codes, direction order, and require valid coordinates', () => {
  const stop = normalizeStopRecord({
    thuTu: '7',
    maDiem: '0012',
    maKhachHang: 'KH-0012',
    tenQuanHuyen: 'Ba Đình',
    tenDuong: 'Đường Bưởi',
    tenDiem: 'Bến xe mẫu',
    anhThanh: 'Âm thanh mẫu',
    bienBao: '1',
    nhaChoTCT: 'Có',
    nhaChoLED: 'Có',
    kinhDo: '105.8',
    viDo: '21.02',
    tuyenDiQua: '09A, 45; 09A',
    tuyenTheoChieu: [{ maTuyen: '09a', chieu: 'di', thuTu: '1' }],
    thuHoi: 'x',
    banKinhQuet: '70',
    huong: 'Đông',
    maAmThanh: '010012',
    ngayBatDau: '01/01/2020',
    ngayKetThuc: '01/01/2021',
    ghiChu: 'Ghi chú mẫu'
  }, 'stable-id');

  assert.equal(stop.id, 'stable-id');
  assert.equal(stop.thuTu, '7');
  assert.equal(stop.maKhachHang, 'KH-0012');
  assert.equal(stop.tenQuanHuyen, 'Ba Đình');
  assert.equal(stop.anhThanh, 'Âm thanh mẫu');
  assert.deepEqual(stop.tuyenDiQua, ['09A', '45']);
  assert.deepEqual(stop.tuyenTheoChieu, [{ maTuyen: '09A', chieu: 'di', thuTu: 1 }]);
  assert.equal(stop.thuHoi, true);
  assert.equal(stop.ngayBatDau, '01/01/2020');
  assert.equal(stop.ghiChu, 'Ghi chú mẫu');
  assert.deepEqual(stop.lichSuDiemDung, []);
  assert.equal(parseRouteDirection('Chiều Đi'), 'di');
  assert.equal(parseRouteDirection('Về'), 've');
  assert.equal(routeDirection('Chiều đi'), 'di');
  assert.equal(routeDirection('Chiều về'), 've');
  assert.equal(normalizeStopRecord({
    maDiem: 'ONE', tenDiem: 'Một tuyến', kinhDo: '105.8', viDo: '21.02',
    tuyenDiQua: ['09A'], huong: 'Đi'
  }).tuyenTheoChieu[0].thuTu, null);
  assert.deepEqual(normalizeStopRecord({
    maDiem: 'BOTH', tenDiem: 'Hai chiều', kinhDo: '105.8', viDo: '21.02',
    tuyenDiQua: ['09A'],
    tuyenTheoChieu: [
      { maTuyen: '09A', chieu: 'di', thuTu: 1 },
      { maTuyen: '09A', chieu: 've', thuTu: 9 }
    ]
  }).tuyenTheoChieu, [
    { maTuyen: '09A', chieu: 'di', thuTu: 1 },
    { maTuyen: '09A', chieu: 've', thuTu: 9 }
  ]);
  const ambiguous = normalizeStopRecord({
    maDiem: 'MULTI', tenDiem: 'Nhiều tuyến', kinhDo: '105.8', viDo: '21.02',
    tuyenDiQua: ['09A', '45'], huong: 'Đi'
  });
  assert.deepEqual(ambiguous.tuyenTheoChieu, []);
  assert.equal(ambiguous.huong, '');
  assert.throws(() => normalizeStopRecord({ ...stop, kinhDo: '' }), /kinh độ/);
  assert.throws(() => normalizeStopRecord({ ...stop, viDo: '91' }), /vĩ độ/);
  assert.throws(() => normalizeStopRecord({ ...stop, tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 0 }] }), /số nguyên dương/);
  assert.throws(() => normalizeStopRecord({ ...stop, tuyenTheoChieu: [
    { maTuyen: '09A', chieu: 'di', thuTu: 1 },
    { maTuyen: '09A', chieu: 'di', thuTu: 2 }
  ] }), /khai báo nhiều lần/);
  assert.deepEqual(parseRoutes(['09a', ' 45A']), ['09A', '45A']);
});

test('duplicate stop rows merge routes and retain every history entry', () => {
  const { rows, duplicateCount, conflicts } = mergeDuplicateStopRows([
    {
      maDiem: '001.02',
      tenDiem: 'Bến xe mẫu',
      kinhDo: '105.800001',
      viDo: '21.020001',
      tuyenDiQua: ['09A'],
      ngayBatDau: '01/01/2020',
      ghiChu: 'Ghi chú cũ'
    },
    {
      maDiem: '001.02',
      tenDiem: 'Bến xe mẫu',
      kinhDo: '105.800002',
      viDo: '21.020002',
      tuyenDiQua: ['45', '09A'],
      thuHoi: 'x',
      ngayBatDau: '01/01/2021',
      ghiChu: 'Ghi chú mới'
    }
  ]);

  assert.equal(duplicateCount, 1);
  assert.deepEqual(conflicts, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tuyenDiQua, ['09A', '45']);
  assert.equal(rows[0].thuHoi, true);
  assert.equal(rows[0].lichSuDiemDung.length, 2);
});

test('duplicate stop rows preserve distinct notes, exact repeated entries, and can be reprocessed', () => {
  const rows = [
    { maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02', ghiChu: 'Ghi chú đặc biệt' },
    { maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02', ghiChu: 'Ghi chú đặc biệt' },
    { maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02', ghiChu: 'Ghi chú khác' }
  ];
  const firstPass = mergeDuplicateStopRows(rows);
  const secondPass = mergeDuplicateStopRows(firstPass.rows);

  assert.equal(firstPass.rows[0].lichSuDiemDung.length, 3);
  assert.equal(secondPass.rows[0].lichSuDiemDung.length, 3);
  assert.deepEqual(firstPass.rows[0].lichSuDiemDung.map(entry => entry.ghiChu), [
    'Ghi chú đặc biệt', 'Ghi chú đặc biệt', 'Ghi chú khác'
  ]);
});

test('duplicate stop rows merge both directions and flag conflicting concrete order', () => {
  const result = mergeDuplicateStopRows([
    {
      maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 1 }]
    },
    {
      maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '45', chieu: 've', thuTu: 8 }]
    }
  ]);
  assert.deepEqual(result.rows[0].tuyenTheoChieu, [
    { maTuyen: '09A', chieu: 'di', thuTu: 1 },
    { maTuyen: '45', chieu: 've', thuTu: 8 }
  ]);

  const conflict = mergeDuplicateStopRows([
    {
      maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 1 }]
    },
    {
      maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 2 }]
    }
  ]);
  assert.deepEqual(conflict.conflicts, [{ maDiem: '001.02', fields: ['tuyenTheoChieu'] }]);

  const oppositeConflict = mergeDuplicateStopRows([
    {
      maDiem: '001.03', tenDiem: 'Bến D', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 1 }]
    },
    {
      maDiem: '001.03', tenDiem: 'Bến D', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 've', thuTu: 1 }]
    }
  ]);
  assert.deepEqual(oppositeConflict.conflicts, []);
  assert.deepEqual(oppositeConflict.rows[0].tuyenTheoChieu, [
    { maTuyen: '09A', chieu: 'di', thuTu: 1 },
    { maTuyen: '09A', chieu: 've', thuTu: 1 }
  ]);
});

test('a concrete route order fills a missing order when duplicate stops merge', () => {
  const result = mergeDuplicateStopRows([
    {
      maDiem: '001.04', tenDiem: 'Bến E', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: null }]
    },
    {
      maDiem: '001.04', tenDiem: 'Bến E', kinhDo: '105.8', viDo: '21.02',
      tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 1 }]
    }
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.rows[0].tuyenTheoChieu[0].thuTu, 1);
});

test('importing a direction without order preserves saved order and the other direction', () => {
  const assignments = mergeRouteDirectionAssignments([
    { maTuyen: '09A', chieu: 'di', thuTu: 3 },
    { maTuyen: '09A', chieu: 've', thuTu: 8 },
    { maTuyen: '45', chieu: 'di', thuTu: 4 }
  ], [
    { maTuyen: '09A', chieu: 'di', thuTu: null }
  ], ['09A']);

  assert.deepEqual(assignments, [
    { maTuyen: '09A', chieu: 'di', thuTu: 3 },
    { maTuyen: '09A', chieu: 've', thuTu: 8 }
  ]);
});

test('legacy stop routes migrate direction only when a single route is unambiguous', () => {
  assert.deepEqual(migrateStopRouteAssignments({ tuyenDiQua: '09a', huong: 'Đi' }), {
    tuyenDiQua: ['09A'],
    tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: null }],
    huong: 'di'
  });
  assert.deepEqual(migrateStopRouteAssignments({ tuyenDiQua: '09A,45', huong: 'Đi' }), {
    tuyenDiQua: ['09A', '45'],
    tuyenTheoChieu: [],
    huong: ''
  });
  assert.equal(migrateStopRouteAssignments({ tuyenDiQua: ['09A'], tuyenTheoChieu: [] }), null);
});

test('public stop data hides locked routes and stops only attached to them', () => {
  const result = filterPublicStopData([
    { maDiem: 'LOCKED', tuyenDiQua: ['09A'], tuyenTheoChieu: [{ maTuyen: '09A', chieu: 'di', thuTu: 1 }] },
    { maDiem: 'MIXED', tuyenDiQua: ['09A', '45'], tuyenTheoChieu: [
      { maTuyen: '09A', chieu: 'di', thuTu: 1 },
      { maTuyen: '45', chieu: 'di', thuTu: 2 }
    ] },
    { maDiem: 'UNASSIGNED', tuyenDiQua: [] }
  ], [
    ['09A', { maTuyen: '09A', status: 'locked' }],
    ['45', { maTuyen: '45', status: 'active' }]
  ]);

  assert.deepEqual(result.tuyenList.map(route => route.maTuyen), ['45']);
  assert.deepEqual(result.diemDungList.map(stop => stop.maDiem), ['MIXED', 'UNASSIGNED']);
  assert.deepEqual(result.diemDungList[0].tuyenDiQua, ['45']);
  assert.deepEqual(result.diemDungList[0].tuyenTheoChieu.map(item => item.maTuyen), ['45']);
});

test('duplicate stop rows flag conflicting point identity and location', () => {
  const result = mergeDuplicateStopRows([
    { maDiem: '001.02', tenDiem: 'Bến A', kinhDo: '105.8', viDo: '21.02' },
    { maDiem: '001.02', tenDiem: 'Bến B', kinhDo: '106.8', viDo: '21.02' },
    { maDiem: '003.04', tenDiem: 'Bến C', kinhDo: '105.9', viDo: '21.03' }
  ]);

  assert.deepEqual(result.conflicts, [{
    maDiem: '001.02',
    fields: ['tenDiem', 'kinhDo']
  }]);
  assert.deepEqual(result.rows.map(row => row.maDiem), ['003.04']);
});

test('rows without a point code stay separate for validation instead of being merged', () => {
  const result = mergeDuplicateStopRows([
    { maDiem: '', tenDiem: 'Thiếu mã 1' },
    { maDiem: '', tenDiem: 'Thiếu mã 2' }
  ]);

  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicateCount, 0);
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