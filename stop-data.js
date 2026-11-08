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

  const routes = parseRoutes(input.tuyenDiQua);
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
    thuHoi: isWithdrawn(input.thuHoi),
    kinhDo,
    viDo,
    banKinhQuet: text(input.banKinhQuet),
    huong: text(input.huong),
    maAmThanh: text(input.maAmThanh),
    ngayBatDau: text(input.ngayBatDau),
    ngayKetThuc: text(input.ngayKetThuc),
    lichSuDiemDung: Array.isArray(input.lichSuDiemDung) ? input.lichSuDiemDung : [],
    ghiChu: text(input.ghiChu)
  };
}

module.exports = { mergeDuplicateStopRows, normalizeStopRecord, parseRoutes };
