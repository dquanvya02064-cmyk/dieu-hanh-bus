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

// Schema dữ liệu MongoDB Atlas
const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

mongoose.connect(MONGO_URI)
  .then(() => console.log('>>> Ket noi thanh cong MongoDB Atlas!'))
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

// Hàm đọc dữ liệu thô
async function getRawData() {
  const doc = await BusModel.findOne({ key: 'main_data' });
  if (doc && doc.data && Object.keys(doc.data).length > 0) {
    return doc.data;
  }
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }
  return { tuyenList: {}, bieuDoList: [] };
}

// Hàm lưu dữ liệu vào MongoDB
async function saveRawData(data) {
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: data },
    { upsert: true, returnDocument: 'after' }
  );
}

// 1. API LẤY DANH MỤC CHO TRANG TRA CỨU (CHỈ HIỆN TUYẾN KHÔNG BỊ KHÓA)
app.get('/api/danh-muc', async (req, res) => {
  try {
    const raw = await getRawData();
    let danhMucList = [];
    let allRoutesList = [];

    const activeRouteKeys = new Set();

    if (raw.tuyenList && typeof raw.tuyenList === 'object') {
      for (let k in raw.tuyenList) {
        const item = raw.tuyenList[k];
        // Chỉ lấy tuyến đang hoạt động, bỏ qua các tuyến có status là 'locked'
        if (item.status !== 'locked') {
          activeRouteKeys.add(item.tenTuyen || k);
          allRoutesList.push({
            maTuyen: item.maTuyen || k,
            tenTuyen: item.tenTuyen || k,
            xn: item.xn || "",
            dauA: item.dauA || "",
            dauB: item.dauB || ""
          });
        }
      }
    }

    if (Array.isArray(raw.bieuDoList)) {
      danhMucList = raw.bieuDoList
        .filter(item => activeRouteKeys.has(item.tuyen))
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
      allRoutes: allRoutesList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi khi tải danh mục' });
  }
});

// 2. API LẤY DỮ LIỆU BIỂU ĐỒ (RAW DATA)
app.get('/api/table-data', async (req, res) => {
  try {
    const { tab, tuyen } = req.query;
    const raw = await getRawData();

    let foundItem = null;
    if (Array.isArray(raw.bieuDoList)) {
      foundItem = raw.bieuDoList.find(b => {
        const matchTab = String(b.tenTab || '').trim() === String(tab || '').trim();
        const matchTuyen = !tuyen || String(b.tuyen || '').trim() === String(tuyen || '').trim();
        return matchTab && matchTuyen;
      });

      if (!foundItem && tab) {
        foundItem = raw.bieuDoList.find(b => String(b.tenTab || '').trim() === String(tab || '').trim());
      }
    }

    if (!foundItem) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu biểu đồ' });
    }

    let customDauA = "";
    let customDauB = "";
    if (raw.tuyenList) {
      for (let k in raw.tuyenList) {
        const t = raw.tuyenList[k];
        if (t.tenTuyen === foundItem.tuyen || t.tenTuyen === tuyen) {
          customDauA = t.dauA || "";
          customDauB = t.dauB || "";
          break;
        }
      }
    }

    res.json({
      success: true,
      rawData: foundItem.rawData || [],
      dauA: customDauA,
      dauB: customDauB
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi nạp bảng biểu đồ' });
  }
});

// 3. API DÀNH RIÊNG CHO TRANG QUẢN TRỊ ADMIN (LẤY TẤT CẢ TUYẾN KỂ CẢ KHÓA)
app.get('/api/bus-data', async (req, res) => {
  try {
    const data = await getRawData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. API LƯU TOÀN BỘ DỮ LIỆU / IMPORT
app.post(['/api/bus-data', '/api/danh-muc', '/api/save-data'], async (req, res) => {
  try {
    await saveRawData(req.body);
    res.json({ success: true, message: 'Lưu thành công!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Lỗi ghi database' });
  }
});

// 5. API LƯU / CẬP NHẬT RIÊNG THÔNG TIN MỘT TUYẾN TỪ ADMIN
app.post('/api/save-tuyen', async (req, res) => {
  try {
    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};

    const { maTuyen, xn, tenTuyen, dauA, dauB, soXe, loaiXe, sucChua, status } = req.body;
    if (!maTuyen) {
      return res.status(400).json({ success: false, message: 'Thiếu mã tuyến' });
    }

    raw.tuyenList[maTuyen] = {
      maTuyen,
      xn: xn || "",
      tenTuyen: tenTuyen || `${maTuyen}. Tuyến ${maTuyen}`,
      dauA: dauA || "",
      dauB: dauB || "",
      soXe: soXe || "",
      loaiXe: loaiXe || "",
      sucChua: sucChua || "",
      status: status || "active"
    };

    await saveRawData(raw);
    res.json({ success: true, message: 'Cập nhật thông tin tuyến thành công!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi lưu thông tin tuyến' });
  }
});

app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
