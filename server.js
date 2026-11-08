require('dotenv').config();

const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { ADMIN_PERMISSIONS, canAccessAdminRequest, canGrantAdminPermissions, canUpdateAdminPermissions, createAdminToken, expandAdminPermissions, hasAdminPermission, hashPassword, verifyAdminToken, verifyPassword } = require('./security');
const { filterPublicStopData, mergeDuplicateStopRows, mergeRouteDirectionAssignments, migrateStopRouteAssignments, normalizeStopRecord, replaceRouteDirectionAssignments } = require('./stop-data');
const { calculatePolylineDistance, normalizeRouteGeometry } = require('./route-geometry');

const app = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI;
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || '';
const OSRM_BASE_URL = (process.env.OSRM_BASE_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
if (!MONGO_URI) throw new Error('MONGO_URI must be configured in the environment.');

const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'https://dieu-hanh-bus.onrender.com,http://localhost:3000')
  .split(',').map(origin => origin.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed.'));
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- BỘ NHỚ TẠM TRONG RAM & KHÓA CHỐNG XUNG ĐỘT HÀNG CỜ (SINGLE-FLIGHT PROMISE) ---
let cachedData = null;
let activeFetchPromise = null; // Giúp các API gọi cùng lúc dùng chung 1 lần query DB

function clearCache() {
  cachedData = null;
  activeFetchPromise = null;
}

// HELPER: Lấy ngày ISO YYYY-MM-DD chuẩn múi giờ Việt Nam (UTC+7)
function getVietnamTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// HELPER: Lấy chuỗi thời gian hiển thị tiếng Việt múi giờ Việt Nam
// HELPER: Chuẩn hóa mọi định dạng ngày (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY) về YYYY-MM-DD
function parseDateToISO(dateStr) {
  if (!dateStr) return getVietnamTodayISO();
  let s = String(dateStr).trim();
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3) {
    if (parts[0].length <= 2 && parts[2].length >= 2) {
      let d = parts[0].padStart(2, '0');
      let m = parts[1].padStart(2, '0');
      let y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
      return `${y}-${m}-${d}`;
    }
  }
  return s;
}

// MONGOOSE SCHEMAS & MODELS
const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);


// --- MIDDLEWARE BẢO MẬT & XÁC THỰC QUẢN TRỊ ---
async function verifyAdmin(req, res, next) {
  try {
    if (Buffer.byteLength(AUTH_TOKEN_SECRET) < 32) {
      return res.status(503).json({ success: false, message: 'Hệ thống chưa cấu hình xác thực quản trị.' });
    }
    const token = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
    const claims = verifyAdminToken(token, AUTH_TOKEN_SECRET);
    if (!claims) {
      return res.status(401).json({ success: false, message: 'Chưa xác thực danh tính quản trị viên!' });
    }
    const raw = await getRawData();
    const user = (raw.taiKhoanList || []).find(u => u.username === claims.username && u.status === 'active');
    if (!user) {
      return res.status(403).json({ success: false, message: 'Tài khoản không hợp lệ hoặc đã bị tạm khóa!' });
    }
    if ((user.tokenVersion || 0) !== claims.tokenVersion) {
      return res.status(401).json({ success: false, message: 'Phiên đăng nhập đã hết hiệu lực.' });
    }
    if (!canAccessAdminRequest(req.path, req.query, user, req.body || {})) {
      return res.status(403).json({ success: false, message: 'Tài khoản không có quyền thực hiện thao tác này.' });
    }
    req.adminUser = user;
    return next();
  } catch (err) {
    console.error('Lỗi xác thực quản trị:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi xác thực hệ thống.' });
  }
}

async function ensureBootstrapAdmin(raw) {
  if (!Array.isArray(raw.taiKhoanList)) raw.taiKhoanList = [];
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (raw.taiKhoanList.length || !username || !password) return false;
  if (password.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters.');
  raw.taiKhoanList.push({
    username,
    password: await hashPassword(password),
    role: 'master',
    permissions: ['tuyen', 'xe', 'bieudo'],
    status: 'active'
  });
  await saveRawDataFast(raw);
  return true;
}

function parseTabDate(tabName) {
  if (!tabName) return { sortKey: "00000000", dateObj: new Date(0) };
  const matches = [...String(tabName).matchAll(/(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{2,4})/g)];
  if (matches.length > 0) {
    let m = matches[matches.length - 1];
    let d = parseInt(m[1], 10);
    let mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const dateObj = new Date(y, mo - 1, d);
    const sortKey = `${y}${String(mo).padStart(2,'0')}${String(d).padStart(2,'0')}`;
    return { sortKey, dateObj };
  }
  return { sortKey: "00000000", dateObj: new Date(0) };
}

// --- HÀM LÀM SẠCH, ĐỒNG BỘ DỮ LIỆU & TỰ ĐỘNG KÍCH HOẠT HẸN GIỜ (CRON ENGINE CORE) ---
async function cleanAndSyncData(data) {
  if (!data) return data;
  const hasHistoryLog = Object.prototype.hasOwnProperty.call(data, 'historyLog');
  const hasStopAuditHistory = Object.prototype.hasOwnProperty.call(data, 'diemDungHistory');
  if (hasHistoryLog) delete data.historyLog;
  if (hasStopAuditHistory) delete data.diemDungHistory;
  if (!Array.isArray(data.xeList)) data.xeList = [];
  if (!data.tuyenList) data.tuyenList = {};
  if (!Array.isArray(data.danhMucXeMau)) data.danhMucXeMau = [];

  const todayISO = getVietnamTodayISO();
  let isDataChanged = hasHistoryLog || hasStopAuditHistory;
  if (Array.isArray(data.diemDungList)) {
    data.diemDungList.forEach(stop => {
      const migration = migrateStopRouteAssignments(stop);
      if (!migration) return;
      stop.tuyenDiQua = migration.tuyenDiQua;
      stop.tuyenTheoChieu = migration.tuyenTheoChieu;
      stop.huong = migration.huong;
      isDataChanged = true;
    });
  }

  // STEP A: Chuẩn hóa & lọc trùng BKS xe
  const uniqueXeMap = new Map();
  data.xeList.forEach(x => {
    if (x && x.bks) {
      const bksNorm = String(x.bks).trim().toUpperCase();
      uniqueXeMap.set(bksNorm, {
        ...x,
        bks: bksNorm,
        maTuyen: String(x.maTuyen || '').trim().toUpperCase()
      });
    }
  });
  data.xeList = Array.from(uniqueXeMap.values());

  // STEP B: Tự động chuyển dàn xe hẹn giờ khi đến ngày
  if (Array.isArray(data.scheduledFleetUpdates)) {
    data.scheduledFleetUpdates.forEach(update => {
      const targetDateISO = parseDateToISO(update.ngayApDung);
      if (update.status === 'pending' && targetDateISO <= todayISO) {
        const normMaTuyen = String(update.maTuyen).toUpperCase();
        const newCars = (update.danhSachXe || []).map(x => ({
          ...x,
          bks: String(x.bks || '').trim().toUpperCase(),
          maTuyen: normMaTuyen
        }));
        const newBksSet = new Set(newCars.map(x => x.bks));

        const otherCars = data.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() !== normMaTuyen);
        const xeCuCuaTuyen = data.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() === normMaTuyen);

        const finalXeList = [...otherCars, ...newCars];
        xeCuCuaTuyen.forEach(xeCu => {
          if (!newBksSet.has(xeCu.bks)) {
            finalXeList.push({ ...xeCu, maTuyen: 'DP', updatedAt: new Date() });
          }
        });

        data.xeList = finalXeList;
        update.status = 'applied';
        isDataChanged = true;

      }
    });
  }

  // STEP C: Tự động đổi thông tin Tuyến khi đến ngày
  if (Array.isArray(data.scheduledRouteUpdates)) {
    data.scheduledRouteUpdates.forEach(update => {
      const targetDateISO = parseDateToISO(update.ngayApDung);
      if (update.status === 'pending' && targetDateISO <= todayISO) {
        const normMaTuyen = String(update.maTuyen).toUpperCase();
        if (update.tuyenInfo) {
          data.tuyenList[normMaTuyen] = {
            ...(data.tuyenList[normMaTuyen] || {}),
            ...update.tuyenInfo
          };
        }
        update.status = 'applied';
        isDataChanged = true;

      }
    });
  }

  // STEP D: Đếm lại xe kế hoạch theo tuyến
  const realKhCounts = {};
  data.xeList.forEach(x => {
    let maT = String(x.maTuyen || '').trim().toUpperCase();
    if (maT) {
      realKhCounts[maT] = (realKhCounts[maT] || 0) + 1;
    }
  });

  // STEP E: Lấy số nốt tối đa từ biểu đồ
  const tuyenChartsMap = {};
  if (Array.isArray(data.bieuDoList)) {
    data.bieuDoList.forEach(item => {
      let tuyenStr = String(item.tuyen || item.tenTab || "").trim();
      let matchMa = tuyenStr.match(/^([A-Za-z0-9]+)/);
      if (matchMa) {
        let ma = matchMa[1].toUpperCase();
        if (!tuyenChartsMap[ma]) tuyenChartsMap[ma] = [];
        tuyenChartsMap[ma].push({
          ...item,
          dateInfo: parseTabDate(item.tenTab || item.bieuDo || "")
        });
      }
    });
  }

  const maxNotMap = {};
  for (let ma in tuyenChartsMap) {
    const charts = tuyenChartsMap[ma];
    charts.sort((a, b) => a.dateInfo.dateObj - b.dateInfo.dateObj);
    const latestChart = charts[charts.length - 1];

    if (latestChart && Array.isArray(latestChart.rawData)) {
      let maxNot = 0;
      latestChart.rawData.forEach(row => {
        let val = parseInt(String(row[0] || '').trim(), 10);
        if (!isNaN(val) && val > maxNot) maxNot = val;
      });
      if (maxNot > 0) {
        maxNotMap[ma] = maxNot;
      }
    }
  }

  // STEP F: Cập nhật thông tin tuyến
  for (let k in data.tuyenList) {
    let tObj = data.tuyenList[k];
    let maT = (tObj.maTuyen || k).toUpperCase();

    let realKh = realKhCounts[maT] || 0;
    tObj.soXeKh = realKh; 
    tObj.soXe = realKh;

    let foundVd = maxNotMap[maT];
    if (foundVd && foundVd > 0) {
      tObj.soXeVd = foundVd;
    } else {
      tObj.soXeVd = tObj.soXeVd && tObj.soXeVd > 0 ? tObj.soXeVd : (realKh || 0);
    }
  }

  data._isDataChanged = isDataChanged;
  return data;
}

// CRON ENGINE CHẠY NGẦM MỖI 1 PHÚT
setInterval(async () => {
  try {
    await getRawData(true);
  } catch (err) {
    console.error("Lỗi thực thi Cron Engine ngầm:", err);
  }
}, 60000);

// KẾT NỐI MONGODB
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('>>> Kết nối thành công MongoDB Atlas!');

    const doc = await BusModel.findOne({ key: 'main_data' }).lean();
    if (doc && doc.data) {
      const cleanedData = await cleanAndSyncData(doc.data);
      delete cleanedData._isDataChanged;
      await BusModel.findOneAndUpdate({ key: 'main_data' }, { key: 'main_data', data: cleanedData }, { upsert: true });
      cachedData = cleanedData;
      console.log('>>> Đã tự động làm sạch và đồng bộ dữ liệu thành công!');
    }
  })
  .catch(err => console.error('>>> Lỗi kết nối MongoDB:', err));

async function getRawData(forceRefresh = false) {
  // 1. Đã có cache trong RAM -> Trả về NGAY LẬP TỨC (<1ms)
  if (!forceRefresh && cachedData) {
    return cachedData;
  }

  // 2. Nếu đang có request khác fetch DB -> Dùng chung Promise (Chống gọi trùng)
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  activeFetchPromise = (async () => {
    try {
      // Dùng .lean() giúp Mongoose đọc JSON thuần cực nhanh
      const doc = await BusModel.findOne({ key: 'main_data' }).lean();
      if (doc && doc.data) {
        const cleaned = await cleanAndSyncData(doc.data);
        if (cleaned._isDataChanged) {
          delete cleaned._isDataChanged;
          BusModel.findOneAndUpdate({ key: 'main_data' }, { key: 'main_data', data: cleaned }, { upsert: true }).catch(() => {});
        } else {
          delete cleaned._isDataChanged;
        }
        cachedData = cleaned;
        return cachedData;
      }
    } catch (err) {
      console.error('Lỗi đọc db:', err);
    } finally {
      activeFetchPromise = null; // Giải phóng lock
    }
    
    const localPath = path.join(__dirname, 'bus_full_data.json');
    if (fs.existsSync(localPath)) {
      const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      const cleaned = await cleanAndSyncData(fileData);
      delete cleaned._isDataChanged;
      cachedData = cleaned;
      return cachedData;
    }
    return { 
      tuyenList: {}, bieuDoList: [], xeList: [], taiKhoanList: [], 
      danhMucXeMau: [], thongBaoChay: "", scheduledFleetUpdates: [], 
      scheduledRouteUpdates: []
    };
  })();

  return activeFetchPromise;
}

async function saveRawDataFast(data) {
  delete data._isDataChanged;
  delete data.historyLog;
  delete data.diemDungHistory;
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: data },
    { upsert: true, returnDocument: 'after' }
  );
  cachedData = data;
}

async function saveRawData(data) {
  const cleaned = await cleanAndSyncData(data);
  delete cleaned._isDataChanged;
  cachedData = cleaned;
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: cleaned },
    { upsert: true, returnDocument: 'after' }
  );
}

// --- API HỆ THỐNG LỊCH HẸN ---
app.get('/api/admin/lay-danh-sach-lich', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData();
    const pending = [];

    if (Array.isArray(raw.scheduledFleetUpdates)) {
      raw.scheduledFleetUpdates.forEach(item => {
        if (item.status === 'pending') {
          pending.push({
            id: item.id,
            source: 'fleet',
            type: 'TUYEN_DOI_XE',
            target: item.maTuyen === 'DP' ? 'Bến DP' : `Tuyến ${item.maTuyen}`,
            details: `Thay đổi toàn bộ dàn xe (${(item.danhSachXe || []).length} xe)`,
            targetTimeStr: item.ngayApDung,
            danhSachBks: (item.danhSachXe || []).map(x => String(x.bks || '').trim().toUpperCase()),
            createdBy: item.createdBy || 'Admin'
          });
        }
      });
    }

    if (Array.isArray(raw.scheduledRouteUpdates)) {
      raw.scheduledRouteUpdates.forEach(item => {
        if (item.status === 'pending') {
          pending.push({
            id: item.id,
            source: 'route',
            type: 'TUYEN_DOI_XE',
            target: `Tuyến ${item.maTuyen}`,
            details: `Thay đổi thông tin / Lộ trình / Đơn vị chủ quản (${item.tuyenInfo?.tenTuyen || ''})`,
            targetTimeStr: item.ngayApDung,
            createdBy: item.createdBy || 'Admin'
          });
        }
      });
    }

    if (Array.isArray(raw.thongBaoScheduleList)) {
      raw.thongBaoScheduleList.forEach(item => {
        pending.push({
          id: item.id,
          source: 'notification',
          type: 'THONG_BAO',
          target: 'Chạy chữ Marquee',
          details: `Nội dung: "${item.noiDung}"`,
          targetTimeStr: `${item.tuNgay} ${item.tuGio || '00:00'} ➔ ${item.denNgay} ${item.denGio || '23:59'}`,
          createdBy: 'Admin'
        });
      });
    }

    res.json({
      success: true,
      pending: pending.filter(item => item.source !== 'notification' || hasAdminPermission(req.adminUser, 'notifications.view'))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/chay-ngay-lich-hen', verifyAdmin, async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ success: false, message: 'Thiếu mã tác vụ!' });

    const raw = await getRawData(true);
    let isExecuted = false;
    let targetName = '';

    if (Array.isArray(raw.scheduledFleetUpdates)) {
      const fleetItem = raw.scheduledFleetUpdates.find(f => f.id === taskId && f.status === 'pending');
      if (fleetItem) {
        const normMaTuyen = String(fleetItem.maTuyen).toUpperCase();
        const newCars = (fleetItem.danhSachXe || []).map(x => ({ ...x, bks: String(x.bks || '').trim().toUpperCase(), maTuyen: normMaTuyen }));
        const newBksSet = new Set(newCars.map(x => x.bks));

        const otherCars = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() !== normMaTuyen);
        const xeCuCuaTuyen = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() === normMaTuyen);

        const finalXeList = [...otherCars, ...newCars];
        xeCuCuaTuyen.forEach(xeCu => {
          if (!newBksSet.has(xeCu.bks)) {
            finalXeList.push({ ...xeCu, maTuyen: 'DP', updatedAt: new Date() });
          }
        });

        raw.xeList = finalXeList;
        fleetItem.status = 'applied';
        isExecuted = true;
        targetName = `Tuyến ${fleetItem.maTuyen}`;

      }
    }

    if (!isExecuted && Array.isArray(raw.scheduledRouteUpdates)) {
      const routeItem = raw.scheduledRouteUpdates.find(r => r.id === taskId && r.status === 'pending');
      if (routeItem) {
        const normMaTuyen = String(routeItem.maTuyen).toUpperCase();
        if (routeItem.tuyenInfo) {
          raw.tuyenList[normMaTuyen] = {
            ...(raw.tuyenList[normMaTuyen] || {}),
            ...routeItem.tuyenInfo
          };
        }
        routeItem.status = 'applied';
        isExecuted = true;
        targetName = `Tuyến ${routeItem.maTuyen}`;

      }
    }

    if (isExecuted) {
      await saveRawData(raw);
      return res.json({ success: true, message: `Đã kích hoạt áp dụng tác vụ thành công cho ${targetName}!` });
    } else {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tác vụ hẹn giờ hoặc tác vụ đã được thực thi!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/huy-lich-hen', verifyAdmin, async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ success: false, message: 'Thiếu mã tác vụ!' });

    const raw = await getRawData(true);
    let isCancelled = false;

    if (Array.isArray(raw.scheduledFleetUpdates)) {
      const fleetItem = raw.scheduledFleetUpdates.find(f => f.id === taskId && f.status === 'pending');
      if (fleetItem) {
        fleetItem.status = 'cancelled';
        isCancelled = true;

      }
    }

    if (!isCancelled && Array.isArray(raw.scheduledRouteUpdates)) {
      const routeItem = raw.scheduledRouteUpdates.find(r => r.id === taskId && r.status === 'pending');
      if (routeItem) {
        routeItem.status = 'cancelled';
        isCancelled = true;

      }
    }

    if (isCancelled) {
      await saveRawDataFast(raw);
      return res.json({ success: true, message: `Đã hủy lịch hẹn thành công!` });
    } else {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tác vụ hẹn giờ cần hủy!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API THÔNG BÁO ---
app.get('/api/thong-bao', async (req, res) => {
  try {
    const raw = await getRawData();
    const defaultText = raw.thongBaoChay || "";
    const scheduleList = raw.thongBaoScheduleList || [];
    
    const now = new Date();
    const todayDate = getVietnamTodayISO();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;
    
    let textHienThi = defaultText;

    if (Array.isArray(scheduleList)) {
      for (let item of scheduleList) {
        const tuNgay = item.tuNgay;
        const denNgay = item.denNgay;
        const tuGio = item.tuGio || "00:00";
        const denGio = item.denGio || "23:59";

        const startStr = `${tuNgay} ${tuGio}`;
        const endStr = `${denNgay} ${denGio}`;
        const currentStr = `${todayDate} ${currentTime}`;

        if (currentStr >= startStr && currentStr <= endStr) {
          textHienThi = item.noiDung;
          break;
        }
      }
    }

    res.json({ success: true, text: textHienThi });
  } catch (err) {
    res.status(500).json({ success: false, text: "" });
  }
});

app.get('/api/thong-bao-chi-tiet', (req, res, next) => {
  if (req.query.admin === 'true') return verifyAdmin(req, res, next);
  return next();
}, async (req, res) => {
  try {
    const raw = await getRawData();
    const now = new Date();
    
    let activeTexts = [];
    const scheduleList = raw.thongBaoScheduleList || [];

    if (scheduleList.length > 0) {
      for (let item of scheduleList) {
        const start = new Date(`${item.tuNgay}T${item.tuGio || '00:00'}`);
        const end = new Date(`${item.denNgay}T${item.denGio || '23:59'}`);
        
        if (now >= start && now <= end) {
          if (item.noiDung && !activeTexts.includes(item.noiDung)) {
            activeTexts.push(item.noiDung.trim());
          }
        }
      }
    }

    let finalActiveText = "";
    if (activeTexts.length > 0) {
      finalActiveText = activeTexts.join("    •    ");
    } else {
      finalActiveText = raw.thongBaoChay || "Hệ thống điều hành xe buýt Hà Nội";
    }

    if (req.query.admin === 'true') {
      return res.json({
        success: true,
        defaultText: raw.thongBaoChay || '',
        currentActiveText: finalActiveText,
        scheduleList
      });
    }
    res.json({ success: true, currentActiveText: finalActiveText });
  } catch (err) {
    res.status(500).json({ success: false, defaultText: "", scheduleList: [] });
  }
});

app.post('/api/admin/luu-thong-bao', verifyAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    const raw = await getRawData(true);
    raw.thongBaoChay = text !== undefined ? text : "";
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật thông báo mặc định thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/them-lich-thong-bao', verifyAdmin, async (req, res) => {
  try {
    const { tuNgay, tuGio, denNgay, denGio, noiDung } = req.body;
    if (!tuNgay || !denNgay || !noiDung) {
      return res.json({ success: false, message: "Thiếu thông tin ngày hoặc nội dung!" });
    }

    const raw = await getRawData(true);
    if (!raw.thongBaoScheduleList) raw.thongBaoScheduleList = [];

    raw.thongBaoScheduleList.push({
      id: Date.now().toString(),
      tuNgay,
      tuGio: tuGio || "00:00",
      denNgay,
      denGio: denGio || "23:59",
      noiDung
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: "Đã thêm lịch thông báo thành công!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-lich-thong-bao', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    const raw = await getRawData(true);
    
    if (raw.thongBaoScheduleList) {
      raw.thongBaoScheduleList = raw.thongBaoScheduleList.filter(item => item.id !== id);
      await saveRawDataFast(raw);
    }
    res.json({ success: true, message: "Đã xóa mốc lịch thành công!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- AUTHENTICATION & QUẢN TRỊ NGƯỜI DÙNG ---
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (Buffer.byteLength(AUTH_TOKEN_SECRET) < 32) {
      return res.status(503).json({ success: false, message: 'Hệ thống chưa cấu hình xác thực quản trị.' });
    }
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập tài khoản và mật khẩu.' });
    }

    const raw = await getRawData(true);
    if (!Array.isArray(raw.taiKhoanList)) raw.taiKhoanList = [];

    if (raw.taiKhoanList.length === 0 && username === process.env.BOOTSTRAP_ADMIN_USERNAME && password === process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      await ensureBootstrapAdmin(raw);
    }

    const user = raw.taiKhoanList.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Tài khoản hoặc mật khẩu không đúng.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Tài khoản của bạn đang bị tạm khóa!' });
    }

    if (user.username === 'quan' && user.password === '123') {
      const replacementPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
      if (!replacementPassword || replacementPassword.length < 12) {
        return res.status(503).json({ success: false, message: 'Tài khoản mặc định đã bị vô hiệu hóa. Hãy cấu hình mật khẩu quản trị mới.' });
      }
      user.password = await hashPassword(replacementPassword);
      await saveRawDataFast(raw);
    }

    const passwordCheck = await verifyPassword(password, user.password);
    if (!passwordCheck.valid) {
      return res.status(401).json({ success: false, message: 'Tài khoản hoặc mật khẩu không đúng.' });
    }
    if (passwordCheck.needsRehash) {
      user.password = await hashPassword(password);
      await saveRawDataFast(raw);
    }

    return res.json({
      success: true, 
      role: user.role, 
      permissions: expandAdminPermissions(user.permissions || []),
      token: createAdminToken(user.username, AUTH_TOKEN_SECRET, Date.now(), user.tokenVersion || 0),
      message: 'Đăng nhập thành công!' 
    });
  } catch (err) {
    console.error('Lỗi đăng nhập quản trị:', err.message);
    return res.status(500).json({ success: false, message: 'Không thể đăng nhập lúc này.' });
  }
});

app.get('/api/admin/danh-sach-tai-khoan', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData();
    const accounts = (raw.taiKhoanList || []).map(({ password, ...account }) => ({
      ...account,
      permissions: expandAdminPermissions(account.permissions || [])
    }));
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/dang-ky', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername, password, role, permissions } = req.body;
    if (typeof targetUsername !== 'string' || !targetUsername.trim() || typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ success: false, message: 'Tên tài khoản và mật khẩu tối thiểu 12 ký tự là bắt buộc.' });
    }
    if (role && !['master', 'staff'].includes(role)) return res.status(400).json({ success: false, message: 'Vai trò không hợp lệ.' });
    const allowedPermissions = [...ADMIN_PERMISSIONS, 'tuyen', 'xe', 'bieudo'];
    if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some(permission => !allowedPermissions.includes(permission)))) {
      return res.status(400).json({ success: false, message: 'Danh sách quyền không hợp lệ.' });
    }
    const expandedPermissions = expandAdminPermissions(permissions || []);
    if (!canGrantAdminPermissions(expandedPermissions, req.adminUser)) {
      return res.status(403).json({ success: false, message: 'Không thể cấp quyền vượt quá quyền hiện có của bạn.' });
    }

    const raw = await getRawData(true);
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    if (raw.taiKhoanList.some(u => u.username === targetUsername)) {
      return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    raw.taiKhoanList.push({
      username: targetUsername.trim(),
      password: await hashPassword(password),
      role: role || 'staff',
      permissions: expandedPermissions,
      status: 'active'
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Tạo tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/sua-tai-khoan', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername, status, role, permissions } = req.body;
    if (status !== undefined && !['active', 'locked'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Trạng thái tài khoản không hợp lệ.' });
    }
    if (role !== undefined && !['master', 'staff'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Vai trò không hợp lệ.' });
    }
    const allowedPermissions = [...ADMIN_PERMISSIONS, 'tuyen', 'xe', 'bieudo'];
    if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some(permission => !allowedPermissions.includes(permission)))) {
      return res.status(400).json({ success: false, message: 'Danh sách quyền không hợp lệ.' });
    }
    const expandedPermissions = permissions === undefined ? undefined : expandAdminPermissions(permissions);
    const raw = await getRawData(true);
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === targetUsername);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    if (user.role === 'master' && req.adminUser.role !== 'master') {
      return res.status(403).json({ success: false, message: 'Chỉ quản trị tối cao mới được sửa tài khoản Master.' });
    }
    if (expandedPermissions && !canUpdateAdminPermissions(user.permissions || [], expandedPermissions, req.adminUser)) {
      return res.status(403).json({ success: false, message: 'Chỉ có thể thay đổi các quyền bạn đang sở hữu.' });
    }

    if (status) user.status = status;
    if (role) user.role = role;
    if (expandedPermissions) user.permissions = expandedPermissions;

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/doi-mat-khau', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername, newPassword } = req.body;
    if (typeof targetUsername !== 'string' || !targetUsername || typeof newPassword !== 'string' || newPassword.length < 12) {
      return res.status(400).json({ success: false, message: 'Mật khẩu mới phải có ít nhất 12 ký tự.' });
    }

    const raw = await getRawData(true);
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === targetUsername);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    if (user.role === 'master' && req.adminUser.role !== 'master') {
      return res.status(403).json({ success: false, message: 'Chỉ quản trị tối cao mới được đổi mật khẩu tài khoản Master.' });
    }

    user.password = await hashPassword(newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã đổi mật khẩu cho tài khoản [${targetUsername}] thành công!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-tai-khoan', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername } = req.body;
    const raw = await getRawData(true);
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === targetUsername);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    if (user.role === 'master' && req.adminUser.role !== 'master') {
      return res.status(403).json({ success: false, message: 'Chỉ quản trị tối cao mới được xóa tài khoản Master.' });
    }
    raw.taiKhoanList = raw.taiKhoanList.filter(u => u.username !== targetUsername);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- QUẢN LÝ DANH MỤC MÁC XE MẪU ---
app.get('/api/admin/danh-sach-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, data: raw.danhMucXeMau || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/luu-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const { chungLoai, sucChua, namSx } = req.body;
    if (!chungLoai) return res.status(400).json({ success: false, message: 'Thiếu chủng loại xe mẫu!' });
    const raw = await getRawData(true);
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];
    
    const cleanNamSx = String(namSx || '').trim();
    const idx = raw.danhMucXeMau.findIndex(m => 
      m.chungLoai.toLowerCase() === chungLoai.toLowerCase() && 
      String(m.namSx || '').trim() === cleanNamSx
    );

    if (idx >= 0) {
      raw.danhMucXeMau[idx] = { chungLoai, sucChua, namSx: cleanNamSx };
    } else {
      raw.danhMucXeMau.push({ chungLoai, sucChua, namSx: cleanNamSx });
    }
    
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu mác xe mẫu thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const { chungLoai, namSx } = req.body;
    const raw = await getRawData(true);
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];
    const cleanNamSx = String(namSx || '').trim();
    
    raw.danhMucXeMau = raw.danhMucXeMau.filter(m => !(m.chungLoai === chungLoai && String(m.namSx || '').trim() === cleanNamSx));
    
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa mác xe mẫu thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/import-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData(true);
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];

    const lines = rawText.split('\n');
    let count = 0;
    lines.forEach(line => {
      const parts = line.split(/[\t]+/).length > 1 ? line.split(/[\t]+/).map(p => p.trim()) : line.split(/\s{2,}/).map(p => p.trim());
      const chungLoai = parts[0];
      const sucChua = parts[1] || '';
      const namSx = parts[2] || '';
      if (chungLoai) {
        const cleanNamSx = String(namSx || '').trim();
        const existing = raw.danhMucXeMau.find(m => m.chungLoai.toLowerCase() === chungLoai.toLowerCase() && String(m.namSx || '').trim() === cleanNamSx);
        if (!existing) {
          raw.danhMucXeMau.push({ 
            chungLoai, 
            sucChua: sucChua.toLowerCase().includes('chỗ') ? sucChua : (sucChua ? `${sucChua} chỗ` : ''),
            namSx: cleanNamSx 
          });
          count++;
        }
      }
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: `Import thành công ${count} mác xe mẫu mới!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-tat-ca-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData(true);
    raw.danhMucXeMau = [];
    await saveRawDataFast(raw);
    res.json({ success: true, message: "Đã dọn sạch danh mục mác xe mẫu thành công!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- QUẢN LÝ ĐỘI XE THEO TUYẾN & HẸN GIỜ ĐIỀU CHUYỂN BẾN DP ---
app.post('/api/admin/luu-doi-xe-tuyen', verifyAdmin, async (req, res) => {
  try {
    const { maTuyen, danhSachXe, ngayApDung, status, trangThai } = req.body;
    const requestedStatus = status ?? trangThai;
    if (!maTuyen) return res.status(400).json({ success: false, message: 'Thiếu mã tuyến!' });
    const raw = await getRawData(true);
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];
    if (!Array.isArray(raw.scheduledFleetUpdates)) raw.scheduledFleetUpdates = [];

    const normMaTuyen = String(maTuyen).trim().toUpperCase();
    const existingRoute = raw.tuyenList[normMaTuyen];
    const currentStatus = existingRoute?.status || 'active';
    if (existingRoute && requestedStatus && requestedStatus !== currentStatus && !hasAdminPermission(req.adminUser, 'routes.status')) {
      return res.status(403).json({ success: false, message: 'Tài khoản không có quyền đổi trạng thái tuyến.' });
    }
    const today = getVietnamTodayISO();
    const ngayHieuLuc = ngayApDung ? parseDateToISO(ngayApDung) : today;

    const newCarsForRoute = (danhSachXe || []).map(x => {
      let bksUpper = String(x.bks || '').trim().toUpperCase();
      let inputChungLoai = x.chungLoai || '';
      let inputNamSx = String(x.namSx || '').trim();

      let mauChuan = raw.danhMucXeMau.find(m => 
        m.chungLoai.toLowerCase() === inputChungLoai.toLowerCase() && 
        String(m.namSx || '').trim() === inputNamSx
      );

      return {
        bks: bksUpper,
        maTuyen: normMaTuyen,
        chungLoai: mauChuan ? mauChuan.chungLoai : inputChungLoai,
        sucChua: mauChuan ? mauChuan.sucChua : (x.sucChua || ''),
        nhanHieu: x.nhanHieu || '',
        namSx: mauChuan ? mauChuan.namSx : inputNamSx
      };
    }).filter(x => x.bks);

    if (ngayHieuLuc > today) {
      raw.scheduledFleetUpdates = raw.scheduledFleetUpdates.filter(
        item => String(item.maTuyen).trim().toUpperCase() !== normMaTuyen || item.status !== 'pending'
      );

      raw.scheduledFleetUpdates.push({
        id: Date.now().toString(),
        maTuyen: normMaTuyen,
        danhSachXe: newCarsForRoute,
        ngayApDung: ngayHieuLuc,
        status: 'pending',
        createdAt: new Date(),
        createdBy: req.adminUser ? req.adminUser.username : 'Admin'
      });

      await saveRawData(raw);
      return res.json({ 
        success: true, 
        message: `Đã lên lịch thành công! Đội xe sẽ tự động áp dụng và đẩy xe cũ về bến DP vào ngày ${ngayApDung}. Dàn xe hiện tại vẫn giữ nguyên.` 
      });
    }

    raw.scheduledFleetUpdates = raw.scheduledFleetUpdates.filter(
      item => String(item.maTuyen).trim().toUpperCase() !== normMaTuyen || item.status !== 'pending'
    );

    const bksXeMoiSet = new Set(newCarsForRoute.map(x => x.bks));
    const otherCars = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() !== normMaTuyen);
    const xeCuCuaTuyen = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() === normMaTuyen);

    const finalXeList = [...otherCars];
    finalXeList.push(...newCarsForRoute);

    xeCuCuaTuyen.forEach(xeCu => {
      if (!bksXeMoiSet.has(xeCu.bks)) {
        finalXeList.push({
          ...xeCu,
          maTuyen: 'DP',
          updatedAt: new Date()
        });
      }
    });

    raw.xeList = finalXeList;

    if (raw.tuyenList && raw.tuyenList[normMaTuyen]) {
      raw.tuyenList[normMaTuyen].soXeKh = newCarsForRoute.length;
      raw.tuyenList[normMaTuyen].soXe = newCarsForRoute.length;
    }

    await saveRawData(raw);
    res.json({ success: true, message: `Lưu đội xe tuyến ${normMaTuyen} thành công (${newCarsForRoute.length} xe), xe cũ đã được tự động điều chuyển về bến DP!` });
  } catch (err) {
    console.error('Lỗi lưu đội xe:', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// --- API QUẢN LÝ THÔNG TIN TUYẾN & HẸN NGÀY ĐỔI LỘ TRÌNH / XÍ NGHIỆP ---
app.post(['/api/save-tuyen', '/api/tuyen-moi'], verifyAdmin, async (req, res) => {
  try {
    const { maTuyen, tenTuyen, xn, dauA, dauB, tramDi, tramVe, soXeVd, soXeKh, loaiXe, sucChua, status, trangThai, ngayApDung } = req.body;
    const requestedStatus = status ?? trangThai;
    if (!maTuyen) return res.status(400).json({ success: false, message: 'Thiếu mã tuyến!' });

    const raw = await getRawData(true);
    if (!raw.tuyenList) raw.tuyenList = {};
    if (!Array.isArray(raw.scheduledRouteUpdates)) raw.scheduledRouteUpdates = [];

    const normMaTuyen = String(maTuyen).trim().toUpperCase();
    const today = getVietnamTodayISO();
    const ngayHieuLuc = ngayApDung ? parseDateToISO(ngayApDung) : today;

    const newTuyenInfo = {
      maTuyen: normMaTuyen, 
      tenTuyen: tenTuyen || `${normMaTuyen}. Tuyến ${normMaTuyen}`,
      xn: xn || "", 
      dauA: dauA || "", 
      dauB: dauB || "",
      tramDi: tramDi || "",
      tramVe: tramVe || "",
      soXeVd: parseInt(soXeVd, 10) || raw.tuyenList[normMaTuyen]?.soXeVd || 0,
      soXeKh: parseInt(soXeKh, 10) || raw.tuyenList[normMaTuyen]?.soXeKh || 0, 
      soXe: parseInt(soXeKh, 10) || raw.tuyenList[normMaTuyen]?.soXe || 0,
      loaiXe: loaiXe || "", 
      sucChua: sucChua || "", 
      status: requestedStatus || "active"
    };

    if (ngayHieuLuc > today) {
      raw.scheduledRouteUpdates = raw.scheduledRouteUpdates.filter(
        item => String(item.maTuyen).trim().toUpperCase() !== normMaTuyen || item.status !== 'pending'
      );

      raw.scheduledRouteUpdates.push({
        id: Date.now().toString(),
        maTuyen: normMaTuyen,
        tuyenInfo: newTuyenInfo,
        ngayApDung: ngayHieuLuc,
        status: 'pending',
        createdAt: new Date(),
        createdBy: req.adminUser ? req.adminUser.username : 'Admin'
      });

      await saveRawData(raw);
      return res.json({ 
        success: true, 
        message: `Đã lên lịch thành công! Thông tin/Lộ trình Tuyến ${normMaTuyen} sẽ tự động cập nhật vào ngày ${ngayApDung}. Dữ liệu hiện tại giữ nguyên.` 
      });
    }

    raw.scheduledRouteUpdates = raw.scheduledRouteUpdates.filter(
      item => String(item.maTuyen).trim().toUpperCase() !== normMaTuyen || item.status !== 'pending'
    );

    raw.tuyenList[normMaTuyen] = newTuyenInfo;

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu tuyến thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// --- TRA CỨU DANH MỤC & DỮ LIỆU TUYẾN ---
app.get('/api/danh-muc', (req, res, next) => {
  if (req.query.admin === 'true') return verifyAdmin(req, res, next);
  return next();
}, async (req, res) => {
  try {
    const isAdmin = req.query.admin === 'true';
    const raw = await getRawData();
    const canViewRouteDetails = !isAdmin || hasAdminPermission(req.adminUser, 'routes.view') || hasAdminPermission(req.adminUser, 'fleet.view');
    const canViewAdminRoutes = canViewRouteDetails || (isAdmin && hasAdminPermission(req.adminUser, 'charts.view'));
    const canViewAdminCharts = !isAdmin || hasAdminPermission(req.adminUser, 'charts.view');
    let danhMucList = [];
    let allRoutesList = [];
    const activeRouteNames = new Set();

    if (raw.tuyenList && typeof raw.tuyenList === 'object') {
      for (let k in raw.tuyenList) {
        const item = raw.tuyenList[k];
        if (isAdmin || item.status !== 'locked') {
          activeRouteNames.add(item.tenTuyen || k);
          allRoutesList.push({
            maTuyen: item.maTuyen || k,
            tenTuyen: item.tenTuyen || k,
            xn: item.xn || "",
            dauA: item.dauA || "",
            dauB: item.dauB || "",
            tramDi: item.tramDi || "",
            tramVe: item.tramVe || "",
            soXeVd: item.soXeVd || 0,
            soXeKh: item.soXeKh || item.soXe || 0,
            loaiXe: item.loaiXe || "",
            sucChua: item.sucChua || "",
            status: item.status || "active"
          });
        }
      }
    }

    if (canViewAdminCharts && Array.isArray(raw.bieuDoList)) {
      danhMucList = raw.bieuDoList
        .filter(item => isAdmin || activeRouteNames.has(item.tuyen))
        .map(item => ({
          xn: item.xn || "",
          tuyen: item.tuyen || "",
          bieuDo: item.bieuDo || "",
          tenTab: item.tenTab || ""
        }));
    }

    const dashboard = isAdmin && hasAdminPermission(req.adminUser, 'dashboard.view')
      ? Object.values(raw.tuyenList || {}).reduce((summary, route) => {
        const vehicles = parseInt(route.soXeVd || route.soXe, 10) || 0;
        const planned = parseInt(route.soXeKh || route.soXe, 10) || 0;
        if (route.status === 'locked') {
          summary.lockedRoutes++;
          summary.lockedVehicles += planned || vehicles;
        } else {
          summary.activeRoutes++;
          summary.activeVehicles += vehicles;
          summary.plannedVehicles += planned;
        }
        summary.totalRoutes++;
        return summary;
      }, { totalRoutes: 0, activeRoutes: 0, lockedRoutes: 0, activeVehicles: 0, plannedVehicles: 0, lockedVehicles: 0 })
      : null;

    res.json({
      success: true,
      data: danhMucList,
      allRoutes: canViewRouteDetails
        ? allRoutesList
        : canViewAdminRoutes
          ? allRoutesList.map(({ maTuyen, tenTuyen, xn }) => ({ maTuyen, tenTuyen, xn }))
          : [],
      bieuDoList: canViewAdminCharts ? (isAdmin ? raw.bieuDoList || [] : []) : [],
      dashboard
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/table-data', async (req, res) => {
  try {
    const tabName = req.query.tab;
    const tuyenQuery = req.query.tuyen;
    if (!tabName) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin tab biểu đồ!' });
    }

    const raw = await getRawData();
    const bieuDoList = raw.bieuDoList || [];
    
    let found = bieuDoList.find(b => String(b.tenTab || '').trim() === String(tabName).trim());
    
    if (!found && tuyenQuery) {
      const matchMa = tuyenQuery.match(/^([A-Za-z0-9]+)/);
      const targetMa = matchMa ? matchMa[1].toUpperCase() : tuyenQuery.toUpperCase();

      found = bieuDoList.find(b => {
        const bTuyen = String(b.tuyen || '').trim().toUpperCase();
        const bTab = String(b.tenTab || '').trim().toUpperCase();
        const matchB = bTuyen.match(/^([A-Za-z0-9]+)/) || bTab.match(/^([A-Za-z0-9]+)/);
        return matchB && matchB[1].toUpperCase() === targetMa;
      });
    }

    if (!found) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu biểu đồ cho tab này!' });
    }

    const foundRouteName = String(found.tuyen || tuyenQuery || '').trim();
    const foundRouteCode = foundRouteName.match(/^([A-Za-z0-9]+)/)?.[1]?.toUpperCase();
    const foundRoute = foundRouteCode && (raw.tuyenList?.[foundRouteCode] || Object.values(raw.tuyenList || {}).find(route => String(route.maTuyen || '').toUpperCase() === foundRouteCode));
    if (foundRoute?.status === 'locked') {
      return res.status(404).json({ success: false, message: 'Tuyến hiện không hoạt động.' });
    }

    let dauA = "Đầu A", dauB = "Đầu B";
    if (raw.tuyenList && tuyenQuery) {
      const matchMa = tuyenQuery.match(/^([A-Za-z0-9]+)/);
      const targetMa = matchMa ? matchMa[1].toUpperCase() : tuyenQuery.toUpperCase();

      for (let k in raw.tuyenList) {
        let t = raw.tuyenList[k];
        let maT = String(t.maTuyen || k).trim().toUpperCase();
        if (maT === targetMa) {
          dauA = t.dauA || "Đầu A";
          dauB = t.dauB || "Đầu B";
          break;
        }
      }
    }

    res.json({
      success: true,
      rawData: found.rawData || [],
      dauA: dauA,
      dauB: dauB
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/chi-tiet-tuyen', async (req, res) => {
  try {
    const queryTuyen = String(req.query.maTuyen || req.query.tuyen || '').trim().toUpperCase();
    if (!queryTuyen) return res.json({ success: false, message: "Thiếu mã tuyến!" });

    const raw = await getRawData();
    let tuyenInfo = null;

    const matchMa = queryTuyen.match(/^([A-Za-z0-9]+)/);
    const targetMa = matchMa ? matchMa[1].toUpperCase() : queryTuyen;

    if (raw.tuyenList) {
      for (let k in raw.tuyenList) {
        const t = raw.tuyenList[k];
        const maT = String(t.maTuyen || k).trim().toUpperCase();
        if (maT === targetMa) {
          tuyenInfo = t;
          break;
        }
      }

      if (!tuyenInfo) {
        for (let k in raw.tuyenList) {
          const t = raw.tuyenList[k];
          const tenT = String(t.tenTuyen || '').trim().toUpperCase();
          const regex = new RegExp('^' + targetMa + '([\\s\\.-]|$)', 'i');
          if (regex.test(tenT)) {
            tuyenInfo = t;
            break;
          }
        }
      }
    }

    if (!tuyenInfo) {
      return res.json({
        success: true,
        maTuyen: targetMa,
        tenTuyen: queryTuyen,
        dauA: "Đầu A",
        dauB: "Đầu B",
        tramDi: "",
        tramVe: ""
      });
    }
    if (tuyenInfo.status === 'locked') {
      return res.status(404).json({ success: false, message: 'Tuyến hiện không hoạt động.' });
    }

    res.json({
      success: true,
      maTuyen: tuyenInfo.maTuyen || targetMa,
      tenTuyen: tuyenInfo.tenTuyen || queryTuyen,
      dauA: tuyenInfo.dauA || "Đầu A",
      dauB: tuyenInfo.dauB || "Đầu B",
      tramDi: tuyenInfo.tramDi || "",
      tramVe: tuyenInfo.tramVe || ""
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/bus-data', verifyAdmin, async (req, res) => {
  try {
    const data = await getRawData();
    const safeData = {
      ...data,
      taiKhoanList: (data.taiKhoanList || []).map(({ password, ...account }) => account)
    };
    res.json(safeData);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post(['/api/bus-data', '/api/save-data'], verifyAdmin, async (req, res) => {
  try { 
    await saveRawData(req.body); 
    res.json({ success: true, message: 'Lưu thành công!' }); 
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/toggle-status-tuyen', verifyAdmin, async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    const raw = await getRawData(true);
    if (!raw.tuyenList || !raw.tuyenList[maTuyen]) return res.status(404).json({ success: false, message: 'Không tìm thấy mã tuyến!' });
    raw.tuyenList[maTuyen].status = status;
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật trạng thái thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/diem-dung', async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, ...filterPublicStopData(raw.diemDungList, Object.entries(raw.tuyenList || {})) });
  } catch (err) {
    console.error('Lỗi tải dữ liệu điểm dừng:', err);
    res.status(500).json({ success: false, message: 'Không thể tải dữ liệu điểm dừng.' });
  }
});

app.get('/api/diem-dung/lo-trinh', async (req, res) => {
  try {
    const maTuyen = String(req.query.maTuyen || '').trim().toUpperCase();
    const chieu = String(req.query.chieu || '').trim().toLowerCase();
    if (!/^[A-Z0-9]+$/.test(maTuyen) || !['di', 've'].includes(chieu)) {
      return res.status(400).json({ success: false, message: 'Mã tuyến hoặc chiều không hợp lệ.' });
    }

    const raw = await getRawData();
    const route = Object.entries(raw.tuyenList || {}).find(([code, item]) =>
      String(item.maTuyen || code).trim().toUpperCase() === maTuyen
    )?.[1];
    if (!route || route.status === 'locked') {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tuyến đang hoạt động.' });
    }

    const key = `${maTuyen}:${chieu}`;
    const coordinates = raw.diemDungRouteGeometries?.[key];
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(404).json({
        success: false,
        code: 'ROUTE_GEOMETRY_NOT_DEFINED',
        message: 'Quản trị viên chưa vẽ đường đi cho tuyến và chiều này.'
      });
    }

    return res.json({
      success: true,
      maTuyen,
      chieu,
      coordinates,
      distanceMeters: calculatePolylineDistance(coordinates),
      geometrySource: 'admin-defined'
    });
  } catch (err) {
    console.error('Lỗi lấy geometry tuyến xe:', err.message);
    return res.status(500).json({ success: false, message: 'Không thể tải đường đi của tuyến.' });
  }
});

app.get('/api/admin/diem-dung', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({
      success: true,
      diemDungList: Array.isArray(raw.diemDungList) ? raw.diemDungList : [],
      diemDungRouteGeometries: raw.diemDungRouteGeometries || {},
      tuyenList: Object.entries(raw.tuyenList || {}).map(([code, route]) => ({
        maTuyen: route.maTuyen || code,
        tenTuyen: route.tenTuyen || code,
        status: route.status || 'active'
      }))
    });
  } catch (err) {
    console.error('Lỗi tải dữ liệu điểm dừng quản trị:', err);
    res.status(500).json({ success: false, message: 'Không thể tải dữ liệu điểm dừng.' });
  }
});

app.post('/api/admin/diem-dung/lo-trinh/preview', verifyAdmin, async (req, res) => {
  const waypoints = req.body.waypoints;
  if (!Array.isArray(waypoints) || waypoints.length < 2 || waypoints.length > 100) {
    return res.status(400).json({ success: false, message: 'Cần chọn từ 2 đến 100 điểm mốc.' });
  }

  let coordinates;
  try {
    coordinates = normalizeRouteGeometry(waypoints);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const osrmCoordinates = coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const url = `${OSRM_BASE_URL}/route/v1/driving/${osrmCoordinates}?overview=full&geometries=geojson&steps=false`;
    const response = await fetch(url, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok || result.code !== 'Ok' || !Array.isArray(result.routes?.[0]?.geometry?.coordinates)) {
      return res.status(502).json({
        success: false,
        message: 'OSRM không tìm được đường qua các điểm mốc đã chọn. Hãy thử đổi vị trí hoặc thứ tự điểm.'
      });
    }

    let routeCoordinates;
    try {
      routeCoordinates = normalizeRouteGeometry(result.routes[0].geometry.coordinates);
    } catch (err) {
      console.error('Geometry OSRM không hợp lệ:', err.message);
      return res.status(502).json({ success: false, message: 'Đường OSRM trả về không hợp lệ hoặc quá dài.' });
    }
    if (routeCoordinates.length < 2) {
      return res.status(502).json({ success: false, message: 'OSRM trả về đường đi không đủ điểm.' });
    }

    return res.json({
      success: true,
      coordinates: routeCoordinates,
      distanceMeters: result.routes[0].distance,
      durationSeconds: result.routes[0].duration,
      geometrySource: 'osrm-driving'
    });
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'OSRM phản hồi quá lâu. Hãy thử lại sau.'
      : 'Không kết nối được OSRM để dựng đường bám theo mạng đường.';
    console.error('Lỗi tạo preview tuyến OSRM:', err.message);
    return res.status(502).json({ success: false, message });
  } finally {
    clearTimeout(timeout);
  }
});

app.post('/api/admin/diem-dung/lo-trinh/diem-dung', verifyAdmin, async (req, res) => {
  const maTuyen = String(req.body.maTuyen || '').trim().toUpperCase();
  const chieu = String(req.body.chieu || '').trim().toLowerCase();
  const assignments = req.body.assignments;
  if (!/^[A-Z0-9]+$/.test(maTuyen) || !['di', 've'].includes(chieu) || !Array.isArray(assignments)) {
    return res.status(400).json({ success: false, message: 'Tuyến, chiều hoặc danh sách điểm không hợp lệ.' });
  }
  if (assignments.length > 20000) {
    return res.status(413).json({ success: false, message: 'Mỗi chiều tuyến tối đa 20.000 điểm.' });
  }

  try {
    const raw = await getRawData(true);
    const route = Object.entries(raw.tuyenList || {}).find(([code, item]) =>
      String(item.maTuyen || code).trim().toUpperCase() === maTuyen
    );
    if (!route) return res.status(404).json({ success: false, message: 'Không tìm thấy tuyến.' });
    if (!Array.isArray(raw.diemDungList)) raw.diemDungList = [];

    let updatedCount;
    try {
      updatedCount = replaceRouteDirectionAssignments(raw.diemDungList, maTuyen, chieu, assignments);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    await saveRawDataFast(raw);
    return res.json({
      success: true,
      message: `Đã lưu ${updatedCount} điểm cho tuyến ${maTuyen} chiều ${chieu === 'di' ? 'Đi' : 'Về'}.`
    });
  } catch (err) {
    console.error('Lỗi cập nhật hàng loạt điểm theo tuyến:', err.message);
    return res.status(500).json({ success: false, message: 'Không thể cập nhật danh sách điểm của tuyến.' });
  }
});

app.post('/api/admin/diem-dung/lo-trinh', verifyAdmin, async (req, res) => {
  try {
    const maTuyen = String(req.body.maTuyen || '').trim().toUpperCase();
    const chieu = String(req.body.chieu || '').trim().toLowerCase();
    const rawCoordinates = req.body.coordinates;
    if (!/^[A-Z0-9]+$/.test(maTuyen) || !['di', 've'].includes(chieu) || !Array.isArray(rawCoordinates)) {
      return res.status(400).json({ success: false, message: 'Tuyến, chiều hoặc geometry không hợp lệ.' });
    }

    const raw = await getRawData(true);
    const route = Object.entries(raw.tuyenList || {}).find(([code, item]) =>
      String(item.maTuyen || code).trim().toUpperCase() === maTuyen
    );
    if (!route) return res.status(404).json({ success: false, message: 'Không tìm thấy tuyến.' });
    if (!raw.diemDungRouteGeometries || typeof raw.diemDungRouteGeometries !== 'object') {
      raw.diemDungRouteGeometries = {};
    }

    const key = `${maTuyen}:${chieu}`;
    if (rawCoordinates.length === 0) {
      delete raw.diemDungRouteGeometries[key];
      await saveRawDataFast(raw);
      return res.json({ success: true, message: `Đã xóa đường vẽ tuyến ${maTuyen} chiều ${chieu === 'di' ? 'Đi' : 'Về'}.` });
    }

    let coordinates;
    try {
      coordinates = normalizeRouteGeometry(rawCoordinates);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (coordinates.length < 2) {
      return res.status(400).json({ success: false, message: 'Đường tuyến cần ít nhất hai điểm hình học.' });
    }

    raw.diemDungRouteGeometries[key] = coordinates;
    await saveRawDataFast(raw);
    return res.json({
      success: true,
      message: `Đã lưu đường vẽ tuyến ${maTuyen} chiều ${chieu === 'di' ? 'Đi' : 'Về'} (${coordinates.length} điểm).`
    });
  } catch (err) {
    console.error('Lỗi lưu geometry tuyến:', err.message);
    return res.status(500).json({ success: false, message: 'Không thể lưu đường đi của tuyến.' });
  }
});

app.post('/api/admin/diem-dung/lo-trinh', verifyAdmin, async (req, res) => {
  try {
    const maTuyen = String(req.body.maTuyen || '').trim().toUpperCase();
    const chieu = String(req.body.chieu || '').trim().toLowerCase();
    const rawCoordinates = req.body.coordinates;
    if (!/^[A-Z0-9]+$/.test(maTuyen) || !['di', 've'].includes(chieu) || !Array.isArray(rawCoordinates)) {
      return res.status(400).json({ success: false, message: 'Tuyến, chiều hoặc geometry không hợp lệ.' });
    }

    const raw = await getRawData(true);
    const route = Object.entries(raw.tuyenList || {}).find(([code, item]) =>
      String(item.maTuyen || code).trim().toUpperCase() === maTuyen
    );
    if (!route) return res.status(404).json({ success: false, message: 'Không tìm thấy tuyến.' });
    if (!raw.diemDungRouteGeometries || typeof raw.diemDungRouteGeometries !== 'object') {
      raw.diemDungRouteGeometries = {};
    }

    const key = `${maTuyen}:${chieu}`;
    if (rawCoordinates.length === 0) {
      delete raw.diemDungRouteGeometries[key];
      await saveRawDataFast(raw);
      return res.json({ success: true, message: `Đã xóa đường vẽ tuyến ${maTuyen} chiều ${chieu === 'di' ? 'Đi' : 'Về'}.` });
    }

    let coordinates;
    try {
      coordinates = normalizeRouteGeometry(rawCoordinates);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (coordinates.length < 2) {
      return res.status(400).json({ success: false, message: 'Đường tuyến cần ít nhất hai điểm hình học.' });
    }

    raw.diemDungRouteGeometries[key] = coordinates;
    await saveRawDataFast(raw);
    return res.json({
      success: true,
      message: `Đã lưu đường vẽ tuyến ${maTuyen} chiều ${chieu === 'di' ? 'Đi' : 'Về'} (${coordinates.length} điểm).`
    });
  } catch (err) {
    console.error('Lỗi lưu geometry tuyến:', err.message);
    return res.status(500).json({ success: false, message: 'Không thể lưu đường đi của tuyến.' });
  }
});

app.post('/api/admin/diem-dung', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData(true);
    if (!Array.isArray(raw.diemDungList)) raw.diemDungList = [];

    const requestedId = String(req.body.id || '').trim();
    const existingIndex = requestedId
      ? raw.diemDungList.findIndex(stop => stop.id === requestedId)
      : -1;
    const existing = existingIndex >= 0 ? raw.diemDungList[existingIndex] : null;
    let stop;
    try {
      stop = normalizeStopRecord(req.body, existing?.id || randomUUID());
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!Array.isArray(req.body.tuyenTheoChieu)) {
      stop.tuyenTheoChieu = (existing?.tuyenTheoChieu || []).filter(item =>
        stop.tuyenDiQua.some(code => code.toLocaleUpperCase('vi') === item.maTuyen.toLocaleUpperCase('vi'))
      );
    }
    if (stop.thuHoi !== Boolean(existing?.thuHoi) && !hasAdminPermission(req.adminUser, 'stops.status')) {
      return res.status(403).json({ success: false, message: 'Tài khoản không có quyền đổi trạng thái thu hồi.' });
    }
    if (!Array.isArray(req.body.lichSuDiemDung)) {
      stop.lichSuDiemDung = existing?.lichSuDiemDung || [];
    }
    const duplicate = raw.diemDungList.find(item =>
      item.maDiem.toLocaleUpperCase('vi') === stop.maDiem.toLocaleUpperCase('vi') && item.id !== stop.id
    );
    if (duplicate) return res.status(409).json({ success: false, message: `Mã điểm ${stop.maDiem} đã tồn tại.` });

    if (existing) raw.diemDungList[existingIndex] = stop;
    else raw.diemDungList.push(stop);
    await saveRawDataFast(raw);
    res.json({ success: true, message: existing ? 'Cập nhật điểm dừng thành công.' : 'Thêm điểm dừng thành công.', data: stop });
  } catch (err) {
    console.error('Lỗi lưu điểm dừng:', err);
    res.status(500).json({ success: false, message: 'Không thể lưu điểm dừng.' });
  }
});

app.post('/api/admin/diem-dung/import', verifyAdmin, async (req, res) => {
  try {
    const rows = req.body.diemDungList;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'File nhập không có dữ liệu điểm dừng hợp lệ.' });
    }
    if (rows.length > 20000) {
      return res.status(413).json({ success: false, message: 'Mỗi lần chỉ nhập tối đa 20.000 dòng điểm dừng.' });
    }

    const validationErrors = [];
    const validRows = [];
    rows.forEach((row, index) => {
      try {
        validRows.push(normalizeStopRecord(row, randomUUID()));
      } catch (err) {
        validationErrors.push(`Dòng ${index + 2}: ${err.message}`);
      }
    });
    const imported = mergeDuplicateStopRows(validRows);
    const normalized = imported.rows;
    if (!normalized.length) {
      const conflictExamples = imported.conflicts.slice(0, 10)
        .map(item => `${item.maDiem} (${item.fields.join(', ')})`).join('; ');
      const errorExamples = validationErrors.slice(0, 10).join('; ');
      const details = [errorExamples, conflictExamples].filter(Boolean).join('; ');
      return res.status(400).json({
        success: false,
        message: `Không có điểm hợp lệ để nhập. Đã bỏ qua ${validationErrors.length} dòng lỗi và ${imported.conflicts.length} mã mâu thuẫn.${details ? ` ${details}` : ''}`
      });
    }
    const raw = await getRawData(true);
    if (!Array.isArray(raw.diemDungList)) raw.diemDungList = [];
    const existingByCode = new Map(raw.diemDungList.map((stop, index) => [
      stop.maDiem.toLocaleUpperCase('vi'),
      { stop, index }
    ]));
    const hasStatusPermission = hasAdminPermission(req.adminUser, 'stops.status');
    if (!hasStatusPermission) {
      normalized.forEach(stop => {
        stop.thuHoi = Boolean(existingByCode.get(stop.maDiem.toLocaleUpperCase('vi'))?.stop.thuHoi);
      });
    }
    let added = 0;
    let updated = 0;
    for (const stop of normalized) {
      const match = existingByCode.get(stop.maDiem.toLocaleUpperCase('vi'));
      if (match) {
        stop.id = match.stop.id;
        stop.tuyenTheoChieu = mergeRouteDirectionAssignments(
          match.stop.tuyenTheoChieu,
          stop.tuyenTheoChieu,
          stop.tuyenDiQua
        );
        raw.diemDungList[match.index] = stop;
        updated++;
      } else {
        raw.diemDungList.push(stop);
        added++;
      }
    }
    await saveRawDataFast(raw);
    const conflictExamples = imported.conflicts.slice(0, 5)
      .map(item => `${item.maDiem} (${item.fields.join(', ')})`).join('; ');
    const skippedDetails = [
      validationErrors.length ? `bỏ qua ${validationErrors.length} dòng lỗi` : '',
      imported.conflicts.length
        ? `bỏ qua ${imported.conflicts.length} mã mâu thuẫn${conflictExamples ? `: ${conflictExamples}` : ''}`
        : ''
    ].filter(Boolean).join('; ');
    res.json({
      success: true,
      message: `Đã nhập ${added} điểm mới, cập nhật ${updated} điểm; gộp ${imported.duplicateCount} dòng trùng mã.${skippedDetails ? ` Đã ${skippedDetails}; sửa file để nhập lại các dòng này.` : ''}`,
      added,
      updated,
      duplicatesMerged: imported.duplicateCount,
      invalidRowsSkipped: validationErrors.length,
      conflictingCodesSkipped: imported.conflicts.length
    });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ success: false, message: err.message });
    console.error('Lỗi nhập Excel điểm dừng:', err);
    res.status(500).json({ success: false, message: 'Không thể lưu dữ liệu điểm dừng đã nhập.' });
  }
});

app.post('/api/admin/diem-dung/trang-thai', verifyAdmin, async (req, res) => {
  try {
    const { id, thuHoi } = req.body;
    if (typeof thuHoi !== 'boolean') return res.status(400).json({ success: false, message: 'Trạng thái thu hồi không hợp lệ.' });
    const raw = await getRawData(true);
    const stop = (raw.diemDungList || []).find(item => item.id === id);
    if (!stop) return res.status(404).json({ success: false, message: 'Không tìm thấy điểm dừng.' });
    stop.thuHoi = thuHoi;
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã cập nhật trạng thái thu hồi điểm dừng.' });
  } catch (err) {
    console.error('Lỗi cập nhật trạng thái điểm dừng:', err);
    res.status(500).json({ success: false, message: 'Không thể cập nhật trạng thái điểm dừng.' });
  }
});

app.post('/api/admin/diem-dung/trang-thai-tuyen', verifyAdmin, async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    if (!['active', 'locked'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Trạng thái tuyến không hợp lệ.' });
    }
    const raw = await getRawData(true);
    const entry = Object.entries(raw.tuyenList || {}).find(([key, route]) =>
      String(route.maTuyen || key).toUpperCase() === String(maTuyen || '').trim().toUpperCase()
    );
    if (!entry) return res.status(404).json({ success: false, message: 'Không tìm thấy tuyến.' });
    entry[1].status = status;
    await saveRawDataFast(raw);
    res.json({ success: true, message: status === 'locked' ? 'Đã tạm khóa tuyến.' : 'Đã mở hoạt động tuyến.' });
  } catch (err) {
    console.error('Lỗi cập nhật trạng thái tuyến:', err);
    res.status(500).json({ success: false, message: 'Không thể cập nhật trạng thái tuyến.' });
  }
});

app.post('/api/luu-bieu-do', verifyAdmin, async (req, res) => {
  try {
    const { xn, tuyen, bieuDo, tenTab, rawData } = req.body;
    if (!tenTab || !rawData) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData(true);
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];
    const newTabObj = { xn: xn || "", tuyen: tuyen || "", bieuDo: bieuDo || "", tenTab, rawData };
    const idx = raw.bieuDoList.findIndex(b => String(b.tenTab || '').trim() === String(tenTab).trim());
    if (idx >= 0) raw.bieuDoList[idx] = newTabObj;
    else raw.bieuDoList.push(newTabObj);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu biểu đồ thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/xoa-bieu-do', verifyAdmin, async (req, res) => {
  try {
    const { tenTab } = req.body;
    const raw = await getRawData(true);
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];
    raw.bieuDoList = raw.bieuDoList.filter(b => String(b.tenTab || '').trim() !== String(tenTab).trim());
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa biểu đồ!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/tim-kiem-xe', (req, res, next) => {
  if (req.query.all === 'true') return verifyAdmin(req, res, next);
  return next();
}, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const isAdminRequest = req.query.all === 'true';
    const tuyenQuery = (req.query.tuyen || '').trim().toUpperCase();
    const raw = await getRawData();
    let xeList = Array.isArray(raw.xeList) ? raw.xeList : [];

    const normalizeBks = value => String(value || '').replace(/[\s\-\.]/g, '').toLowerCase();
    let ketQua = isAdminRequest ? xeList : q ? xeList.filter(x => normalizeBks(x.bks).includes(normalizeBks(q))) : [];
    
    if (tuyenQuery) {
      const chuanHoaTuyen = str => String(str || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
      const tuyenQueryNorm = chuanHoaTuyen(tuyenQuery);
      ketQua = ketQua.filter(x => chuanHoaTuyen(x.maTuyen) === tuyenQueryNorm);
    }

    if (!isAdminRequest) {
      ketQua = ketQua.filter(x => {
        const maXe = String(x.maTuyen || '').toUpperCase();
        const route = raw.tuyenList?.[maXe] || Object.values(raw.tuyenList || {}).find(item => String(item.maTuyen || '').toUpperCase() === maXe);
        return !route || route.status !== 'locked';
      });
    }

    const tuyenMap = raw.tuyenList || {};
    ketQua = ketQua.map(x => {
      const maXe = (x.maTuyen || '').toUpperCase();
      let foundTuyen = tuyenMap[maXe] || Object.values(tuyenMap).find(t => (t.maTuyen || '').toUpperCase() === maXe);
      return {
        ...x,
        tenTuyen: foundTuyen ? foundTuyen.tenTuyen : `Tuyến ${x.maTuyen}`,
        xn: foundTuyen ? foundTuyen.xn : (x.donVi || ''),
        soXeVd: foundTuyen ? (foundTuyen.soXeVd || 0) : 0,
        soXeKh: foundTuyen ? (foundTuyen.soXeKh || foundTuyen.soXe || 0) : 0
      };
    });
    res.json({ success: true, data: ketQua });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post(['/api/import-xe-excel', '/api/import-danh-sach-xe'], verifyAdmin, async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData(true);
    if (!raw.tuyenList) raw.tuyenList = {};
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    
    const lines = rawText.split('\n');
    let currentMaTuyen = '';
    let currentTenLoTrinh = '';
    const importedCars = [];

    for (let i = 0; i < lines.length; i++) {
      const lineStr = lines[i].trim();
      if (!lineStr) continue;
      const matchTuyen = lineStr.match(/^(?:Tuyến\s+)?([0-9A-Za-z]+)\s*[:\-]\s*(.*)/i);
      if (matchTuyen) {
        currentMaTuyen = matchTuyen[1].toUpperCase();
        currentTenLoTrinh = matchTuyen[2] ? matchTuyen[2].trim() : '';
        break;
      }
    }

    if (!currentMaTuyen) {
      return res.status(400).json({ 
        success: false, 
        message: 'Không tìm thấy thông tin tuyến ở dòng tiêu đề!' 
      });
    }

    lines.forEach(line => {
      const fullLine = line.trim();
      if (!fullLine) return;

      const parts = fullLine.split(/[\t]+/).length > 1 
        ? fullLine.split(/[\t]+/).map(p => p.trim()) 
        : fullLine.split(/\s{2,}/).map(p => p.trim());
      
      const bks = parts[0] || '';
      const isBks = /^[0-9]{2}[A-Z]{1,2}[-\.]?[0-9]{3,4}[\.0-9]*$/.test(bks) || (bks.includes('-') && /\d/.test(bks) && bks.length <= 12);
      const isHeaderLine = /^[0-9A-Za-z]+\s*[:\-]\s*/.test(fullLine);

      if (isBks && !isHeaderLine) {
        importedCars.push({
          bks: bks.toUpperCase(), 
          maTuyen: currentMaTuyen, 
          nhanHieu: parts[1] || '',
          chungLoai: parts[2] || '', 
          namSx: parts[3] || '', 
          sucChua: parts[4] || '', 
          donVi: parts[5] || ''
        });
      }
    });

    if (importedCars.length > 0) {
      if (!raw.tuyenList[currentMaTuyen]) {
        let dauA = "", dauB = "";
        const loTrinhParts = currentTenLoTrinh.split('-');
        if (loTrinhParts.length >= 2) { dauA = loTrinhParts[0].trim(); dauB = loTrinhParts[1].trim(); }
        
        raw.tuyenList[currentMaTuyen] = {
          maTuyen: currentMaTuyen, 
          tenTuyen: `${currentMaTuyen}. ${currentTenLoTrinh || 'Tuyến ' + currentMaTuyen}`,
          xn: "Transerco", dauA, dauB, 
          soXeVd: 0, soXeKh: importedCars.length, soXe: importedCars.length, 
          loaiXe: importedCars[0]?.chungLoai || "", 
          sucChua: importedCars[0]?.sucChua ? importedCars[0].sucChua + " chỗ" : "", 
          status: "active"
        };
      }

      const existingMap = new Map();
      raw.xeList.forEach(x => existingMap.set(String(x.bks || '').trim().toUpperCase(), x));
      importedCars.forEach(x => existingMap.set(x.bks, x));
      raw.xeList = Array.from(existingMap.values());
    }
    
    await saveRawData(raw);
    res.json({ success: true, message: `Bóc tách và nạp thành công ${importedCars.length} xe vào tuyến ${currentMaTuyen}!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/xoa-xe', verifyAdmin, async (req, res) => {
  try {
    const { bks } = req.body;
    if (!bks) return res.status(400).json({ success: false, message: 'Thiếu biển kiểm soát xe cần xóa!' });
    const raw = await getRawData(true);
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    
    const initialLen = raw.xeList.length;
    raw.xeList = raw.xeList.filter(x => String(x.bks || '').trim().toUpperCase() !== String(bks).trim().toUpperCase());
    
    if (raw.xeList.length === initialLen) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy biển số xe cần xóa!' });
    }

    await saveRawData(raw);
    res.json({ success: true, message: `Đã xóa thành công xe [${bks}] khỏi hệ thống!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe', verifyAdmin, async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;
    if (!bks || !tuyenMoi) return res.status(400).json({ success: false, message: 'Thiếu thông tin điều chuyển!' });
    const raw = await getRawData(true);
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    const xe = raw.xeList.find(x => String(x.bks || '').trim().toUpperCase() === String(bks).trim().toUpperCase());
    if (!xe) return res.status(404).json({ success: false, message: 'Không tìm thấy biển kiểm soát xe!' });
    xe.maTuyen = String(tuyenMoi).trim().toUpperCase();
    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã điều chuyển xe [${bks}] sang tuyến [${tuyenMoi}] thành công!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe-hang-loat', verifyAdmin, async (req, res) => {
  try {
    const { bksList, tuyenMoi } = req.body;
    if (!bksList || !Array.isArray(bksList) || bksList.length === 0 || !tuyenMoi) {
      return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ!' });
    }
    const raw = await getRawData(true);
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const normTuyenMoi = String(tuyenMoi).trim().toUpperCase();
    const targetBksSet = new Set(bksList.map(b => String(b || '').trim().toUpperCase()));

    let count = 0;
    raw.xeList.forEach(x => {
      const normBks = String(x.bks || '').trim().toUpperCase();
      if (targetBksSet.has(normBks)) {
        x.maTuyen = normTuyenMoi;
        x.updatedAt = new Date();
        count++;
      }
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã điều chuyển thành công ${count} xe sang tuyến [${tuyenMoi}]!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.listen(PORT, () => {
  console.log(`=== SERVER RUNNING ON PORT ${PORT} ===`);
});
