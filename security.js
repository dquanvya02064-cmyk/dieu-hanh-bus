const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PASSWORD_KEY_LENGTH = 64;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const MASTER_ONLY_PATHS = new Set([
  '/api/admin/danh-sach-tai-khoan', '/api/admin/dang-ky', '/api/admin/sua-tai-khoan',
  '/api/admin/doi-mat-khau', '/api/admin/xoa-tai-khoan', '/api/admin/luu-thong-bao',
  '/api/admin/them-lich-thong-bao', '/api/admin/xoa-lich-thong-bao',
  '/api/bus-data', '/api/save-data'
]);

function canAccessAdminRequest(path, query, user) {
  if (user.role === 'master') return true;
  if (MASTER_ONLY_PATHS.has(path)) return false;

  const permissions = user.permissions || [];
  if (path === '/api/luu-bieu-do' || path === '/api/xoa-bieu-do') return permissions.includes('bieudo');
  if (path === '/api/save-tuyen' || path === '/api/tuyen-moi' || path === '/api/toggle-status-tuyen') {
    return permissions.includes('tuyen');
  }
  if (path === '/api/danh-muc' && query.admin === 'true') {
    return ['tuyen', 'xe', 'bieudo'].some(permission => permissions.includes(permission));
  }
  if (path.startsWith('/api/admin/lay-danh-sach-lich') || path.startsWith('/api/admin/chay-ngay-lich-hen') || path.startsWith('/api/admin/huy-lich-hen')) {
    return ['tuyen', 'xe'].some(permission => permissions.includes(permission));
  }
  if (path.includes('xe') || path.includes('dieu-chuyen')) {
    return ['tuyen', 'xe'].some(permission => permissions.includes(permission));
  }
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

module.exports = { canAccessAdminRequest, createAdminToken, hashPassword, verifyAdminToken, verifyPassword };