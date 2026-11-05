const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PASSWORD_KEY_LENGTH = 64;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const ADMIN_PERMISSIONS = [
  'dashboard.view',
  'routes.view', 'routes.edit', 'routes.status', 'routes.schedule',
  'fleet.view', 'fleet.edit', 'fleet.transfer', 'fleet.schedule',
  'vehicleModels.view', 'vehicleModels.edit',
  'charts.view', 'charts.edit',
  'notifications.view', 'notifications.edit',
  'appointments.view', 'appointments.apply', 'appointments.cancel',
  'users.view', 'users.create', 'users.permissions', 'users.status', 'users.password', 'users.delete'
];

const LEGACY_PERMISSION_MAP = {
  tuyen: ['dashboard.view', 'routes.view', 'routes.edit', 'routes.status', 'routes.schedule', 'fleet.view', 'fleet.edit', 'fleet.transfer', 'fleet.schedule', 'vehicleModels.view', 'vehicleModels.edit', 'appointments.view', 'appointments.apply', 'appointments.cancel'],
  xe: ['dashboard.view', 'fleet.view', 'fleet.edit', 'fleet.transfer', 'fleet.schedule', 'vehicleModels.view', 'vehicleModels.edit', 'appointments.view', 'appointments.apply', 'appointments.cancel'],
  bieudo: ['dashboard.view', 'charts.view', 'charts.edit']
};

function expandAdminPermissions(permissions = []) {
  const expanded = new Set();
  for (const permission of permissions) {
    if (LEGACY_PERMISSION_MAP[permission]) {
      LEGACY_PERMISSION_MAP[permission].forEach(value => expanded.add(value));
    } else if (ADMIN_PERMISSIONS.includes(permission)) {
      expanded.add(permission);
    }
  }
  return [...expanded];
}

function hasPermission(user, permission) {
  if (user.role === 'master') return true;
  const permissions = expandAdminPermissions(user.permissions);
  const [section] = permission.split('.');
  if (permissions.includes(permission)) return true;
  if (permission.endsWith('.view')) {
    return permissions.some(value => value.startsWith(`${section}.`));
  }
  return permissions.includes(`${section}.manage`);
}

function hasAnyPermission(user, permissions) {
  return permissions.some(permission => hasPermission(user, permission));
}

function canGrantAdminPermissions(permissions, user) {
  return user.role === 'master' || permissions.every(permission => hasPermission(user, permission));
}

function needsSchedulePermission(body = {}) {
  const applyDate = body.ngayApDung;
  if (applyDate === undefined || applyDate === null || applyDate === '') return false;
  if (typeof applyDate !== 'string') return true;
  let normalizedDate = applyDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    const parts = normalizedDate.split(/[\/.-]/);
    if (parts.length === 3 && parts[0].length <= 2 && parts[2].length >= 2) {
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      normalizedDate = `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    } else {
      return true;
    }
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return normalizedDate > today;
}

function canAccessAdminRequest(path, query, user, body = {}) {
  if (user.role === 'master') return true;
  if (path === '/api/bus-data' || path === '/api/save-data') return false;

  if (path === '/api/admin/danh-sach-tai-khoan') return hasPermission(user, 'users.view');
  if (path === '/api/admin/dang-ky') return hasPermission(user, 'users.create') && body.role !== 'master';
  if (path === '/api/admin/sua-tai-khoan') {
    if (body.role === 'master') return false;
    const required = [];
    if (body.status !== undefined) required.push('users.status');
    if (body.role !== undefined || body.permissions !== undefined) required.push('users.permissions');
    return required.length > 0 && required.every(permission => hasPermission(user, permission));
  }
  if (path === '/api/admin/doi-mat-khau') return hasPermission(user, 'users.password');
  if (path === '/api/admin/xoa-tai-khoan') return hasPermission(user, 'users.delete');
  if (path === '/api/admin/danh-sach-xe-mau') return hasAnyPermission(user, ['vehicleModels.view', 'fleet.view']);
  if (['/api/admin/luu-xe-mau', '/api/admin/xoa-xe-mau', '/api/admin/import-xe-mau', '/api/admin/xoa-tat-ca-xe-mau'].includes(path)) {
    return hasPermission(user, 'vehicleModels.edit');
  }
  if (path === '/api/admin/thong-bao-chi-tiet') return hasPermission(user, 'notifications.view');
  if (['/api/admin/luu-thong-bao', '/api/admin/them-lich-thong-bao', '/api/admin/xoa-lich-thong-bao'].includes(path)) {
    return hasPermission(user, 'notifications.edit');
  }
  if (path === '/api/admin/lay-danh-sach-lich') return hasPermission(user, 'appointments.view');
  if (path === '/api/admin/chay-ngay-lich-hen') return hasPermission(user, 'appointments.apply');
  if (path === '/api/admin/huy-lich-hen') return hasPermission(user, 'appointments.cancel');

  if (path === '/api/luu-bieu-do' || path === '/api/xoa-bieu-do') return hasPermission(user, 'charts.edit');
  if (path === '/api/toggle-status-tuyen') return hasPermission(user, 'routes.status');
  if (path === '/api/save-tuyen' || path === '/api/tuyen-moi') {
    return hasPermission(user, 'routes.edit') && (!needsSchedulePermission(body) || hasPermission(user, 'routes.schedule'));
  }
  if (path === '/api/admin/luu-doi-xe-tuyen') {
    return hasPermission(user, 'fleet.edit') && (!needsSchedulePermission(body) || hasPermission(user, 'fleet.schedule'));
  }
  if (path === '/api/dieu-chuyen-xe' || path === '/api/dieu-chuyen-xe-hang-loat') return hasPermission(user, 'fleet.transfer');
  if (path === '/api/xoa-xe' || path === '/api/import-xe-excel' || path === '/api/import-danh-sach-xe') return hasPermission(user, 'fleet.edit');
  if (path === '/api/danh-muc' && query.admin === 'true') {
    return hasAnyPermission(user, ['dashboard.view', 'routes.view', 'fleet.view', 'charts.view']);
  }
  if (path === '/api/tim-kiem-xe' && query.all === 'true') return hasPermission(user, 'fleet.view');

  return false;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedPassword) {
  if (typeof password !== 'string' || typeof storedPassword !== 'string') {
    return { valid: false, needsRehash: false };
  }

  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(storedPassword);
  if (!match) {
    return { valid: password === storedPassword, needsRehash: true };
  }

  const salt = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(match[2], 'hex');
  const actual = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  return {
    valid: crypto.timingSafeEqual(actual, expected),
    needsRehash: false
  };
}

function createAdminToken(username, secret, now = Date.now(), tokenVersion = 0) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('AUTH_TOKEN_SECRET must be at least 32 bytes.');
  }

  const payload = Buffer.from(JSON.stringify({
    sub: username,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS,
    ver: tokenVersion
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyAdminToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/i.test(parts[1])) return null;

  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const nowSeconds = Math.floor(now / 1000);
    if (typeof payload.sub !== 'string' || !payload.sub || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds) {
      return null;
    }
    if (!Number.isInteger(payload.ver) || payload.ver < 0) return null;
    return { username: payload.sub, expiresAt: payload.exp, tokenVersion: payload.ver };
  } catch {
    return null;
  }
}

module.exports = { ADMIN_PERMISSIONS, canAccessAdminRequest, canGrantAdminPermissions, createAdminToken, expandAdminPermissions, hasAdminPermission: hasPermission, hashPassword, verifyAdminToken, verifyPassword };