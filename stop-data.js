const WITHDRAWN_VALUES = new Set(['1', 'true', 'yes', 'y', 'x', 'co', 'có', 'thu hoi', 'thu hồi']);
const { mergeDuplicateStopRows } = require('./public/stop-import');

function text(value) {
  return value == null ? '' : String(value).trim();
}

function parseRoutes(value) {
  const values = Array.isArray(value) ? value : text(value).split(/[,;|\n]+/);
  return [...new Set(values.map(route => {
    const match = text(route).match(/^([a-z0-9]+)/i);
    return match ? match[1].toUpperCase() : '';
  }).filter(Boolean))];
}

function isWithdrawn(value) {
  if (typeof value === 'boolean') return value;
  return WITHDRAWN_VALUES.has(text(value).toLocaleLowerCase('vi'));
}

function parseRouteDirection(value) {
  const direction = text(value).toLocaleLowerCase('vi')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z]/g, '');
  if (['di', 'chieudi', 'ab'].includes(direction)) return 'di';
  if (['ve', 'chieuve', 'ba'].includes(direction)) return 've';
  return '';
}

function normalizeRouteDirections(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('Dữ liệu tuyến theo chiều không hợp lệ.');

  const seen = new Set();
  return input.map(entry => {
    const codes = parseRoutes(entry?.maTuyen);
    const maTuyen = codes.length === 1 ? codes[0] : '';
    const chieu = parseRouteDirection(entry?.chieu);
    const rawOrder = text(entry?.thuTu);
    const thuTu = rawOrder ? Number(rawOrder) : null;
    if (!maTuyen) throw new Error('Thiếu mã tuyến trong thứ tự điểm theo chiều.');
    if (!['di', 've'].includes(chieu)) throw new Error(`Tuyến ${maTuyen}: chiều phải là Đi hoặc Về.`);
    if (thuTu !== null && (!Number.isInteger(thuTu) || thuTu < 1)) {
      throw new Error(`Tuyến ${maTuyen} chiều ${chieu}: thứ tự điểm phải là số nguyên dương.`);
    }
    const key = `${maTuyen}:${chieu}`;
    if (seen.has(key)) throw new Error(`Tuyến ${maTuyen} chiều ${chieu} bị khai báo nhiều lần cho cùng điểm.`);
    seen.add(key);
    return { maTuyen, chieu, thuTu };
  });
}

function mergeRouteDirectionAssignments(existing, incoming, routes) {
  const allowedRoutes = new Set(parseRoutes(routes));
  const assignments = new Map();
  (Array.isArray(existing) ? existing : []).forEach(item => {
    const maTuyen = parseRoutes(item.maTuyen)[0];
    const chieu = parseRouteDirection(item.chieu);
    if (!maTuyen || !chieu || !allowedRoutes.has(maTuyen)) return;
    assignments.set(`${maTuyen}:${chieu}`, { ...item, maTuyen, chieu });
  });
  (Array.isArray(incoming) ? incoming : []).forEach(item => {
    const maTuyen = parseRoutes(item.maTuyen)[0];
    const chieu = parseRouteDirection(item.chieu);
    if (!maTuyen || !chieu || !allowedRoutes.has(maTuyen)) return;
    const key = `${maTuyen}:${chieu}`;
    const previous = assignments.get(key);
    const incomingOrder = item.thuTu == null || text(item.thuTu) === '' ? null : Number(item.thuTu);
    const previousOrder = previous?.thuTu == null || text(previous.thuTu) === '' ? null : Number(previous.thuTu);
    assignments.set(key, {
      ...item,
      maTuyen,
      chieu,
      thuTu: incomingOrder === null && previousOrder !== null ? previousOrder : incomingOrder
    });
  });
  return [...assignments.values()];
}

function migrateStopRouteAssignments(stop) {
  if (!stop || typeof stop !== 'object' || Array.isArray(stop) || Array.isArray(stop.tuyenTheoChieu)) return null;
  const routes = parseRoutes(stop.tuyenDiQua);
  const direction = routes.length === 1 ? parseRouteDirection(stop.huong) : '';
  return {
    tuyenDiQua: routes,
    tuyenTheoChieu: direction ? [{ maTuyen: routes[0], chieu: direction, thuTu: null }] : [],
    huong: direction || (routes.length > 1 && parseRouteDirection(stop.huong) ? '' : text(stop.huong))
  };
}

function filterPublicStopData(stops, routeEntries) {
  const entries = Array.isArray(routeEntries) ? routeEntries : [];
  const statusByRoute = new Map(entries.map(([code, route]) => [
    String(route.maTuyen || code).toUpperCase(), route.status || 'active'
  ]));
  const isLockedRoute = code => statusByRoute.get(String(code || '').toUpperCase()) === 'locked';
  const tuyenList = entries.filter(([code, route]) => !isLockedRoute(route.maTuyen || code))
    .map(([code, route]) => ({
      maTuyen: route.maTuyen || code,
      tenTuyen: route.tenTuyen || code,
      status: route.status || 'active'
    }));
  const diemDungList = (Array.isArray(stops) ? stops : []).flatMap(stop => {
    const routes = parseRoutes(stop.tuyenDiQua);
    const assignments = Array.isArray(stop.tuyenTheoChieu) ? stop.tuyenTheoChieu : [];
    const allRouteCodes = [...new Set([...routes, ...assignments.map(item => String(item.maTuyen || '').toUpperCase())])];
    const visibleRouteCodes = allRouteCodes.filter(code => !isLockedRoute(code));
    if (allRouteCodes.length && !visibleRouteCodes.length) return [];
    const visibleCodes = new Set(visibleRouteCodes);
    return [{
      ...stop,
      tuyenDiQua: routes.filter(code => visibleCodes.has(code)),
      tuyenTheoChieu: assignments.filter(item => visibleCodes.has(String(item.maTuyen || '').toUpperCase()))
    }];
  });
  return { diemDungList, tuyenList };
}

function normalizeStopRecord(input, idFallback) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Dữ liệu điểm dừng không hợp lệ.');
  }

  const maDiem = text(input.maDiem);
  const tenDiem = text(input.tenDiem);
  const longitude = text(input.kinhDo);
  const latitude = text(input.viDo);
  const kinhDo = Number(longitude);
  const viDo = Number(latitude);
  if (!maDiem) throw new Error('Thiếu mã điểm.');
  if (!tenDiem) throw new Error(`Điểm ${maDiem}: thiếu tên điểm.`);
  if (!longitude || !Number.isFinite(kinhDo) || kinhDo < -180 || kinhDo > 180) {
    throw new Error(`Điểm ${maDiem}: kinh độ phải nằm trong khoảng -180 đến 180.`);
  }
  if (!latitude || !Number.isFinite(viDo) || viDo < -90 || viDo > 90) {
    throw new Error(`Điểm ${maDiem}: vĩ độ phải nằm trong khoảng -90 đến 90.`);
  }

  const rawRouteDirections = input.tuyenTheoChieu === undefined
    ? []
    : Array.isArray(input.tuyenTheoChieu) ? [...input.tuyenTheoChieu] : input.tuyenTheoChieu;
  const routeCodes = parseRoutes(input.tuyenDiQua);
  if (Array.isArray(rawRouteDirections) && !rawRouteDirections.length && routeCodes.length === 1) {
    const direction = parseRouteDirection(input.huong);
    if (direction) rawRouteDirections.push({ maTuyen: routeCodes[0], chieu: direction, thuTu: null });
  }
  const routeDirections = normalizeRouteDirections(rawRouteDirections);
  const routes = [...new Set([
    ...routeCodes,
    ...routeDirections.map(item => item.maTuyen)
  ])];
  const directionsForSingleRoute = routeCodes.length === 1
    ? routeDirections.filter(item => item.maTuyen === routeCodes[0])
    : [];
  return {
    id: text(input.id) || idFallback || maDiem,
    thuTu: text(input.thuTu),
    maDiem,
    maKhachHang: text(input.maKhachHang),
    tenQuanHuyen: text(input.tenQuanHuyen || input.quanHuyen),
    tenDuong: text(input.tenDuong || input.duongPho),
    tenDiem,
    anhThanh: text(input.anhThanh),
    bienBao: text(input.bienBao),
    nhaChoTCT: text(input.nhaChoTCT),
    nhaChoLED: text(input.nhaChoLED),
    tuyenDiQua: routes,
    tuyenTheoChieu: routeDirections,
    thuHoi: isWithdrawn(input.thuHoi),
    kinhDo,
    viDo,
    banKinhQuet: text(input.banKinhQuet),
    huong: directionsForSingleRoute.length === 1
      ? directionsForSingleRoute[0].chieu
      : routeCodes.length > 1 && parseRouteDirection(input.huong) ? '' : text(input.huong),
    maAmThanh: text(input.maAmThanh),
    ngayBatDau: text(input.ngayBatDau),
    ngayKetThuc: text(input.ngayKetThuc),
    lichSuDiemDung: Array.isArray(input.lichSuDiemDung) ? input.lichSuDiemDung : [],
    ghiChu: text(input.ghiChu)
  };
}

module.exports = { filterPublicStopData, mergeDuplicateStopRows, mergeRouteDirectionAssignments, migrateStopRouteAssignments, normalizeStopRecord, normalizeRouteDirections, parseRouteDirection, parseRoutes };
