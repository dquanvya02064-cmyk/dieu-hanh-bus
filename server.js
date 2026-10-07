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

// Schema lưu trữ dữ liệu MongoDB
const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

mongoose.connect(MONGO_URI)
  .then(() => console.log('>>> Da ket noi thanh cong voi MongoDB Atlas!'))
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

// Hàm lấy dữ liệu thô
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

// 1. API TRẢ DANH MỤC (ĐÚNG CẤU TRÚC INDEX.HTML ĐÒI HỎI)
app.get('/api/danh-muc', async (req, res) => {
  try {
    const raw = await getRawData();
    let danhMucList = [];
    let allRoutesList = [];

    // Nếu cấu trúc gốc đã lưu sẵn danhMuc / allRoutes
    if (raw.danhMuc || raw.data || raw.allRoutes) {
      danhMucList = raw.data || raw.danhMuc || [];
      allRoutesList = raw.allRoutes || [];
    } else {
      // Tự động phân tích từ tuyenList hoặc danh sách tuyến
      const tuyens = raw.tuyenList || raw;
      for (let k in tuyens) {
        const item = tuyens[k];
        if (typeof item === 'object' && item !== null) {
          allRoutesList.push({
            maTuyen: item.maTuyen || k,
            tenTuyen: item.tenTuyen || item.tuyen || k,
            xn: item.xn || item.donVi || "Xí nghiệp xe buýt",
            dauA: item.dauA || "",
            dauB: item.dauB || ""
          });

          // Nếu có danh sách biểu đồ theo tab
          if (item.tabs && Array.isArray(item.tabs)) {
            item.tabs.forEach(t => {
              danhMucList.push({
                xn: item.xn || item.donVi || "Xí nghiệp xe buýt",
                tuyen: item.tenTuyen || item.tuyen || k,
                bieuDo: t.tenBieuDo || t.bieuDo || t.tenTab || "",
                tenTab: t.tenTab || t.bieuDo || ""
              });
            });
          } else if (item.bieuDo) {
            danhMucList.push({
              xn: item.xn || item.donVi || "Xí nghiệp xe buýt",
              tuyen: item.tenTuyen || item.tuyen || k,
              bieuDo: item.bieuDo,
              tenTab: item.tenTab || item.bieuDo
            });
          }
        }
      }
    }

    // Trả về đúng format { success: true, data: [...], allRoutes: [...] }
    res.json({
      success: true,
      data: danhMucList,
      allRoutes: allRoutesList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Loi khi tai danh muc' });
  }
});

// 2. API LẤY CHI TIẾT BẢNG BIỂU ĐỒ CHẠY XE
app.get('/api/table-data', async (req, res) => {
  try {
    const { tab, tuyen } = req.query;
    const raw = await getRawData();

    // Tìm dữ liệu bảng tương ứng với tab / tuyến
    let foundTable = null;
    let customDauA = "";
    let customDauB = "";

    if (raw.tables && raw.tables[tab]) {
      foundTable = raw.tables[tab];
    } else {
      const tuyens = raw.tuyenList || raw;
      for (let k in tuyens) {
        const t = tuyens[k];
        if (t.tenTuyen === tuyen || t.tuyen === tuyen || k === tuyen) {
          customDauA = t.dauA || "";
          customDauB = t.dauB || "";
          if (t.tables && t.tables[tab]) {
            foundTable = t.tables[tab];
          } else if (t.rawData) {
            foundTable = t.rawData;
          }
          break;
        }
      }
    }

    if (!foundTable && raw.rawData) {
      foundTable = raw.rawData;
    }

    res.json({
      success: true,
      rawData: foundTable || [],
      dauA: customDauA,
      dauB: customDauB
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Loi tai du lieu bieu do' });
  }
});

// Endpoint dự phòng tương thích quản trị
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
    res.json({ success: true, message: 'Luu thanh cong vao MongoDB Atlas' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Loi ghi database' });
  }
});

app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
