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
  if (doc && doc.data) {
    return doc.data;
  }
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }
  return {};
}

// 1. API TRẢ DANH MỤC CHO INDEX.HTML
app.get('/api/danh-muc', async (req, res) => {
  try {
    const raw = await getRawData();
    let danhMucList = [];
    let allRoutesList = [];

    // Lấy danh sách tuyến xe
    if (raw.tuyenList && typeof raw.tuyenList === 'object') {
      for (let k in raw.tuyenList) {
        const item = raw.tuyenList[k];
        allRoutesList.push({
          maTuyen: item.maTuyen || k,
          tenTuyen: item.tenTuyen || k,
          xn: item.xn || "",
          dauA: item.dauA || "",
          dauB: item.dauB || ""
        });
      }
    }

    // Lấy danh sách biểu đồ
    if (Array.isArray(raw.bieuDoList)) {
      danhMucList = raw.bieuDoList.map(item => ({
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

// 2. API TRẢ CHI TIẾT DỮ LIỆU BIỂU ĐỒ (RAW DATA)
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
      return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu biểu đồ phù hợp' });
    }

    // Tìm thông tin đầu bến A-B tương ứng
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

app.get('/api/bus-data', async (req, res) => {
  const data = await getRawData();
  res.json(data);
});

app.post(['/api/danh-muc', '/api/bus-data'], async (req, res) => {
  try {
    await BusModel.findOneAndUpdate(
      { key: 'main_data' },
      { key: 'main_data', data: req.body },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true, message: 'Lưu dữ liệu thành công' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Lỗi ghi database' });
  }
});

app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
