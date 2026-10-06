const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'bus_full_data.json');
let busData = { tuyenList: {}, bieuDoList: [] };

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      busData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`[OK] Đã nạp dữ liệu vào bộ nhớ siêu tốc!`);
    } catch (e) {
      console.error('[Lỗi] Không đọc được file bus_full_data.json:', e);
    }
  }
}
loadData();

// 1. API lấy danh mục tuyến & biểu đồ (Có phân tách chế độ Khách & Admin)
app.get('/api/danh-muc', (req, res) => {
  const isAdmin = req.query.admin === 'true';

  // Lấy toàn bộ danh sách tuyến
  const allRoutes = [];
  if (busData.tuyenList) {
    for (let k in busData.tuyenList) {
      const t = busData.tuyenList[k];
      const status = t.status || 'active'; // active hoặc locked
      
      // Khách tra cứu chỉ thấy tuyến đang hoạt động
      if (isAdmin || status === 'active') {
        allRoutes.push({
          maTuyen: t.maTuyen || k,
          tenTuyen: t.tenTuyen || k,
          xn: t.xn || '',
          dauA: t.dauA || '',
          dauB: t.dauB || '',
          soXe: t.soXe || '',
          loaiXe: t.loaiXe || '',
          sucChua: t.sucChua || '',
          status: status
        });
      }
    }
  }

  // Danh mục biểu đồ (Khách chỉ thấy biểu đồ của các tuyến active)
  const activeRoutesSet = new Set(allRoutes.map(r => r.tenTuyen));
  const ds = (busData.bieuDoList || [])
    .filter(item => isAdmin || activeRoutesSet.has(item.tuyen))
    .map(item => ({
      xn: item.xn,
      tuyen: item.tuyen,
      bieuDo: item.bieuDo,
      tenTab: item.tenTab
    }));

  res.json({ success: true, data: ds, allRoutes: allRoutes });
});

// 2. API lấy biểu đồ chi tiết
app.get('/api/table-data', (req, res) => {
  const { tab, tuyen } = req.query;
  const item = (busData.bieuDoList || []).find(b => b.tenTab === tab);
  if (!item) {
    return res.json({ error: true, message: 'Không tìm thấy dữ liệu tab biểu đồ!' });
  }

  let dauA = '', dauB = '';
  if (busData.tuyenList) {
    for (let k in busData.tuyenList) {
      const t = busData.tuyenList[k];
      if (t.tenTuyen === tuyen || k === tuyen) {
        dauA = t.dauA;
        dauB = t.dauB;
        break;
      }
    }
  }

  res.json({ success: true, rawData: item.rawData, dauA, dauB });
});

// 3. API xác lập, cập nhật, điều chuyển & khóa tuyến
app.post('/api/tuyen-moi', (req, res) => {
  const { maTuyen, tenTuyen, xn, dauA, dauB, soXe, loaiXe, sucChua, status } = req.body;
  if (!maTuyen || !tenTuyen) {
    return res.json({ success: false, message: 'Thiếu mã hoặc tên tuyến!' });
  }

  if (!busData.tuyenList) busData.tuyenList = {};
  
  // Lưu thông tin chi tiết đầy đủ
  busData.tuyenList[maTuyen] = { 
    maTuyen, 
    tenTuyen, 
    xn, 
    dauA, 
    dauB, 
    soXe: soXe || '', 
    loaiXe: loaiXe || '', 
    sucChua: sucChua || '',
    status: status || 'active'
  };

  // Cập nhật đồng bộ các biểu đồ nếu đổi tên tuyến/xí nghiệp
  if (busData.bieuDoList) {
    busData.bieuDoList.forEach(b => {
      const match = (b.tuyen || '').match(/^([A-Za-z0-9]+)/);
      const bMa = match ? match[1] : '';
      if (bMa === maTuyen || b.tuyen === tenTuyen) {
        b.xn = xn;
        b.tuyen = tenTuyen;
      }
    });
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(busData, null, 2));
  res.json({ success: true, message: `Đã lưu cập nhật thông tin tuyến [${maTuyen}] thành công!` });
});

// 4. API đổi nhanh trạng thái tuyến (Khóa / Mở khóa)
app.post('/api/toggle-status-tuyen', (req, res) => {
  const { maTuyen, status } = req.body;
  if (!maTuyen || !busData.tuyenList || !busData.tuyenList[maTuyen]) {
    return res.json({ success: false, message: 'Tuyến không tồn tại!' });
  }

  busData.tuyenList[maTuyen].status = status;
  fs.writeFileSync(DATA_FILE, JSON.stringify(busData, null, 2));
  res.json({ 
    success: true, 
    message: `Đã ${status === 'locked' ? 'KHÓA (tạm dừng)' : 'KÍCH HOẠT'} hoạt động tuyến [${maTuyen}]!` 
  });
});

// 5. API lưu hoặc ghi đè biểu đồ
app.post('/api/luu-bieu-do', (req, res) => {
  const { xn, tuyen, bieuDo, tenTab, rawData } = req.body;
  if (!busData.bieuDoList) busData.bieuDoList = [];
  
  const idx = busData.bieuDoList.findIndex(b => b.tenTab === tenTab);
  if (idx !== -1) {
    busData.bieuDoList[idx] = { xn, tuyen, bieuDo, tenTab, rawData };
  } else {
    busData.bieuDoList.push({ xn, tuyen, bieuDo, tenTab, rawData });
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(busData, null, 2));
  res.json({ success: true, message: `Lưu biểu đồ [${tenTab}] thành công!` });
});

// 6. API xóa biểu đồ
app.post('/api/xoa-bieu-do', (req, res) => {
  const { tenTab } = req.body;
  if (!tenTab) return res.json({ success: false, message: 'Thiếu tên tab cần xóa!' });

  if (busData.bieuDoList) {
    const truocKhiXoa = busData.bieuDoList.length;
    busData.bieuDoList = busData.bieuDoList.filter(b => b.tenTab !== tenTab);
    
    if (busData.bieuDoList.length < truocKhiXoa) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(busData, null, 2));
      return res.json({ success: true, message: `Đã xóa vĩnh viễn biểu đồ [${tenTab}]!` });
    }
  }

  res.json({ success: false, message: 'Không tìm thấy biểu đồ này để xóa!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`=== HỆ THỐNG ĐIỀU HÀNH ĐANG CHẠY TẠI: http://localhost:${PORT} ===`);
});