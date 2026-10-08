const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://dquan4701_db_user:Quanbus123456@cluster0.sur3koa.mongodb.net/dieuhanhbus?retryWrites=true&w=majority';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

// HÀM LÀM SẠCH VÀ ĐỒNG BỘ DỮ LIỆU TỰ ĐỘNG
async function cleanAndSyncData(data) {
  if (!data) return data;
  if (!Array.isArray(data.xeList)) data.xeList = [];
  if (!data.tuyenList) data.tuyenList = {};

  const uniqueXeMap = new Map();
  data.xeList.forEach(x => {
    if (x && x.bks) {
      uniqueXeMap.set(x.bks.trim().toUpperCase(), {
        ...x,
        bks: x.bks.trim().toUpperCase(),
        maTuyen: String(x.maTuyen || '').trim().toUpperCase()
      });
    }
  });
  data.xeList = Array.from(uniqueXeMap.values());

  const realKhCounts = {};
  data.xeList.forEach(x => {
    if (x.maTuyen) {
      realKhCounts[x.maTuyen] = (realKhCounts[x.maTuyen] || 0) + 1;
    }
  });

  const maxNotMap = {};
  if (Array.isArray(data.bieuDoList)) {
    data.bieuDoList.forEach(item => {
      const rawData = item.rawData;
      if (Array.isArray(rawData)) {
        let maxNot = 0;
        rawData.forEach(row => {
          let val = parseInt(String(row[0] || '').trim(), 10);
          if (!isNaN(val) && val > maxNot) maxNot = val;
        });

        if (maxNot > 0 && item.tuyen) {
          let tuyenStr = String(item.tuyen).trim();
          let matchMa = tuyenStr.match(/^([A-Za-z0-9]+)/);
          if (matchMa) {
            let ma = matchMa[1].toUpperCase();
            if (!maxNotMap[ma] || maxNot > maxNotMap[ma]) {
              maxNotMap[ma] = maxNot;
            }
          }
        }
      }
    });
  }

  for (let k in data.tuyenList) {
    let tObj = data.tuyenList[k];
    let maT = (tObj.maTuyen || k).toUpperCase();

    let realKh = realKhCounts[maT] || 0;
    if (realKh > 0) {
      tObj.soXeKh = realKh;
      tObj.soXe = realKh;
    }

    let foundVd = maxNotMap[maT];
    if (foundVd && foundVd > 0) {
      tObj.soXeVd = foundVd;
    } else {
      tObj.soXeVd = tObj.soXeVd && tObj.soXeVd > 0 ? tObj.soXeVd : (tObj.soXeKh || 0);
    }
  }

  return data;
}

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('>>> Ket noi thanh cong MongoDB Atlas!');
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      if (!doc.data.taiKhoanList || doc.data.taiKhoanList.length === 0) {
        doc.data.taiKhoanList = [
          { username: 'quan', password: '123', role: 'master', status: 'active' },
          { username: 'nhansu01', password: '123', role: 'staff', status: 'active' }
        ];
      }
      const cleanedData = await cleanAndSyncData(doc.data);
      await BusModel.findOneAndUpdate({ key: 'main_data' }, { key: 'main_data', data: cleanedData }, { upsert: true });
      console.log('>>> Đã tự động làm sạch và đồng bộ dữ liệu thành công!');
    }
  })
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

async function getRawData() {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      return await cleanAndSyncData(doc.data);
    }
  } catch (err) {
    console.error('Loi doc db:', err);
  }
  
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    return await cleanAndSyncData(fileData);
  }
  return { tuyenList: {}, bieuDoList: [], xeList: [], taiKhoanList: [] };
}

// Hàm lưu nhanh tốc độ cao (dùng cho các API lưu tuyến, lưu biểu đồ)
async function saveRawDataFast(data) {
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: data },
    { upsert: true, returnDocument: 'after' }
  );
}

// Hàm lưu chuẩn (dùng khi khởi động server hoặc lúc import file Excel danh sách xe)
async function saveRawData(data) {
  const cleaned = await cleanAndSyncData(data);
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: cleaned },
    { upsert: true, returnDocument: 'after' }
  );
}

// API ĐĂNG NHẬP QUẢN TRỊ BẢO MẬT
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList || raw.taiKhoanList.length === 0) {
      raw.taiKhoanList = [
        { username: 'quan', password: '123', role: 'master', status: 'active' },
        { username: 'nhansu01', password: '123', role: 'staff', status: 'active' }
      ];
      await saveRawDataFast(raw);
    }

    const user = raw.taiKhoanList.find(u => u.username === username && u.password === password);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Tài khoản không tồn tại trên hệ thống' });
    }

    res.json({ success: true, role: user.role, message: 'Đăng nhập thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API LẤY DANH SÁCH TÀI KHOẢN
app.get('/api/admin/danh-sach-tai-khoan', async (req, res) => {
  try {
    const raw = await getRawData();
    if (!raw.taiKhoanList || raw.taiKhoanList.length === 0) {
      raw.taiKhoanList = [
        { username: 'quan', password: '123', role: 'master', status: 'active' },
        { username: 'nhansu01', password: '123', role: 'staff', status: 'active' }
      ];
      await saveRawDataFast(raw);
    }
    res.json({ success: true, data: raw.taiKhoanList });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API TẠO TÀI KHOẢN MỚI
app.post('/api/admin/dang-ky', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin tài khoản!' });

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    if (raw.taiKhoanList.some(u => u.username === username)) {
      return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    raw.taiKhoanList.push({
      username,
      password,
      role: role || 'staff',
      status: 'active'
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Tạo tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API XÓA TÀI KHOẢN
app.post('/api/admin/xoa-tai-khoan', async (req, res) => {
  try {
    const { username } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    raw.taiKhoanList = raw.taiKhoanList.filter(u => u.username !== username);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 1. API LẤY DANH MỤC
app.get('/api/danh-muc', async (req, res) => {
  try {
    const isAdmin = req.query.admin === 'true';
    const raw = await getRawData();
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
            soXeVd: item.soXeVd || 0,
            soXeKh: item.soXeKh || item.soXe || 0,
            loaiXe: item.loaiXe || "",
            sucChua: item.sucChua || "",
            status: item.status || "active"
          });
        }
      }
    }

    if (Array.isArray(raw.bieuDoList)) {
      danhMucList = raw.bieuDoList
        .filter(item => isAdmin || activeRouteNames.has(item.tuyen))
        .map(item => ({
          xn: item.xn || "",
          tuyen: item.tuyen || "",
          bieuDo: item.bieuDo || "",
          tenTab: item.tenTab || ""
        }));
    }

    res.json({ 
      success: true, 
      data: danhMucList, 
      allRoutes: allRoutesList, 
      bieuDoList: raw.bieuDoList || [] 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. API TABLE DATA
app.get('/api/table-data', async (req, res) => {
  try {
    const { tab, tuyen } = req.query;
    const raw = await getRawData();
    const foundItem = (raw.bieuDoList || []).find(b => String(b.tenTab || '').trim() === String(tab || '').trim());

    if (!foundItem) return res.status(404).json({ success: false, message: 'Không tìm thấy biểu đồ' });

    let dauA = "", dauB = "";
    for (let k in raw.tuyenList) {
      if (raw.tuyenList[k].tenTuyen === foundItem.tuyen || raw.tuyenList[k].maTuyen === tuyen) {
        dauA = raw.tuyenList[k].dauA || "";
        dauB = raw.tuyenList[k].dauB || "";
        break;
      }
    }

    res.json({ success: true, rawData: foundItem.rawData || [], dauA, dauB });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. API ĐỌC TOÀN BỘ DỮ LIỆU
app.get('/api/bus-data', async (req, res) => {
  try {
    const data = await getRawData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. API LƯU TOÀN BỘ DỮ LIỆU
app.post(['/api/bus-data', '/api/save-data'], async (req, res) => {
  try {
    await saveRawData(req.body);
    res.json({ success: true, message: 'Lưu thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. API LƯU TUYẾN
app.post(['/api/save-tuyen', '/api/tuyen-moi'], async (req, res) => {
  try {
    const { maTuyen, tenTuyen, xn, dauA, dauB, soXeVd, soXeKh, loaiXe, sucChua, status } = req.body;
    if (!maTuyen) return res.status(400).json({ success: false, message: 'Thiếu mã tuyến!' });

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};

    raw.tuyenList[maTuyen] = {
      maTuyen,
      tenTuyen: tenTuyen || `${maTuyen}. Tuyến ${maTuyen}`,
      xn: xn || "",
      dauA: dauA || "",
      dauB: dauB || "",
      soXeVd: parseInt(soXeVd, 10) || raw.tuyenList[maTuyen]?.soXeVd || 0,
      soXeKh: parseInt(soXeKh, 10) || 0,
      soXe: parseInt(soXeKh, 10) || 0,
      loaiXe: loaiXe || "",
      sucChua: sucChua || "",
      status: status || "active"
    };

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu tuyến thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. API KHÓA / MỞ LẠI TUYẾN
app.post('/api/toggle-status-tuyen', async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    const raw = await getRawData();
    if (!raw.tuyenList || !raw.tuyenList[maTuyen]) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy mã tuyến!' });
    }

    raw.tuyenList[maTuyen].status = status;
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật trạng thái thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. API LƯU BIỂU ĐỒ
app.post('/api/luu-bieu-do', async (req, res) => {
  try {
    const { xn, tuyen, bieuDo, tenTab, rawData } = req.body;
    if (!tenTab || !rawData) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });

    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];

    const newTabObj = { xn: xn || "", tuyen: tuyen || "", bieuDo: bieuDo || "Cả tuần", tenTab, rawData };
    const idx = raw.bieuDoList.findIndex(b => String(b.tenTab || '').trim() === String(tenTab).trim());
    if (idx >= 0) raw.bieuDoList[idx] = newTabObj;
    else raw.bieuDoList.push(newTabObj);

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu biểu đồ thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. API XÓA BIỂU ĐỒ
app.post('/api/xoa-bieu-do', async (req, res) => {
  try {
    const { tenTab } = req.body;
    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];

    raw.bieuDoList = raw.bieuDoList.filter(b => String(b.tenTab || '').trim() !== String(tenTab).trim());
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa biểu đồ!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 9. API TRA CỨU XE
app.get('/api/tim-kiem-xe', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const raw = await getRawData();
    let xeList = Array.isArray(raw.xeList) ? raw.xeList : [];

    let ketQua = q ? xeList.filter(x => (x.bks || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(q)) : xeList;

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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 10. API IMPORT XE EXCEL
app.post(['/api/import-xe-excel', '/api/import-danh-sach-xe'], async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const lines = rawText.split('\n');
    let currentMaTuyen = '';
    const importedCars = [];

    lines.forEach(line => {
      const fullLine = line.trim();
      if (!fullLine) return;
      const parts = line.split('\t').map(p => p.trim());

      const matchTuyen = fullLine.match(/^Tuyến\s+([0-9A-Za-z]+)\s*[:\-]?\s*(.*)/i);
      if (matchTuyen) {
        currentMaTuyen = matchTuyen[1].toUpperCase();
        let currentTenLoTrinh = matchTuyen[2] ? matchTuyen[2].trim().replace(/\t.*$/, '') : '';

        if (!raw.tuyenList[currentMaTuyen]) {
          let dauA = "", dauB = "";
          const loTrinhParts = currentTenLoTrinh.split('-');
          if (loTrinhParts.length >= 2) {
            dauA = loTrinhParts[0].trim();
            dauB = loTrinhParts[1].trim();
          }
          raw.tuyenList[currentMaTuyen] = {
            maTuyen: currentMaTuyen,
            tenTuyen: `${currentMaTuyen}. ${currentTenLoTrinh || 'Tuyến ' + currentMaTuyen}`,
            xn: "Transerco",
            dauA, dauB,
            soXeVd: 0, soXeKh: 0, soXe: 0,
            loaiXe: "", sucChua: "", status: "active"
          };
        }
        return;
      }

      const bks = parts[0] || '';
      if ((bks.includes('-') || bks.includes('.')) && currentMaTuyen) {
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
      const existingMap = new Map();
      raw.xeList.forEach(x => existingMap.set(x.bks.toUpperCase(), x));
      importedCars.forEach(x => existingMap.set(x.bks, x));
      raw.xeList = Array.from(existingMap.values());
    }

    await saveRawData(raw);
    res.json({ success: true, message: `Đã nhập xe và làm sạch dữ liệu thành công!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 11. API ĐIỀU CHUYỂN XE
app.post('/api/dieu-chuyen-xe', async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;
    if (!bks || !tuyenMoi) return res.status(400).json({ success: false, message: 'Thiếu thông tin điều chuyển!' });

    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const xe = raw.xeList.find(x => String(x.bks || '').trim().toUpperCase() === String(bks).trim().toUpperCase());
    if (!xe) return res.status(404).json({ success: false, message: 'Không tìm thấy biển kiểm soát xe!' });

    xe.maTuyen = String(tuyenMoi).trim().toUpperCase();
    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã điều chuyển xe [${bks}] sang tuyến [${tuyenMoi}] thành công!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message});
  }
});

app.listen(PORT, () => {
  console.log(`=== SERVER RUNNING ON PORT ${PORT} ===`);
});
