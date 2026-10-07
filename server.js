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
  .then(async () => {
    console.log('>>> Ket noi thanh cong MongoDB Atlas!');
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (!doc || !doc.data || !doc.data.tuyenList || !doc.data.tuyenList['14']) {
      const localPath = path.join(__dirname, 'bus_full_data.json');
      if (fs.existsSync(localPath)) {
        const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        await BusModel.findOneAndUpdate(
          { key: 'main_data' },
          { key: 'main_data', data: fileData },
          { upsert: true }
        );
        console.log('>>> Da tu dong nap lai du lieu goc co day du tuyen khoa!');
      }
    }
  })
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

async function getRawData() {
  const doc = await BusModel.findOne({ key: 'main_data' });
  if (doc && doc.data && doc.data.tuyenList && Object.keys(doc.data.tuyenList).length > 0) {
    if (!Array.isArray(doc.data.xeList)) doc.data.xeList = [];
    return doc.data;
  }
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    if (!Array.isArray(fileData.xeList)) fileData.xeList = [];
    return fileData;
  }
  return { tuyenList: {}, bieuDoList: [], xeList: [] };
}

async function saveRawData(data) {
  if (!Array.isArray(data.xeList)) data.xeList = [];
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: data },
    { upsert: true, returnDocument: 'after' }
  );
}

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
        const isLocked = item.status === 'locked';

        if (isAdmin || !isLocked) {
          activeRouteNames.add(item.tenTuyen || k);
          allRoutesList.push({
            maTuyen: item.maTuyen || k,
            tenTuyen: item.tenTuyen || k,
            xn: item.xn || "",
            dauA: item.dauA || "",
            dauB: item.dauB || "",
            soXeVd: item.soXeVd || "",
            soXeKh: item.soXeKh || item.soXe || "",
            soXe: item.soXe || "",
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
      allRoutes: allRoutesList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi khi tải danh mục: ' + err.message });
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
    res.status(500).json({ success: false, message: 'Lỗi nạp bảng biểu đồ: ' + err.message });
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
    console.error(err);
    res.status(500).json({ success: false, error: 'Lỗi ghi database' });
  }
});

// 5. API LƯU THÔNG TIN TUYẾN TỪ ADMIN
app.post(['/api/save-tuyen', '/api/tuyen-moi'], async (req, res) => {
  try {
    const { maTuyen, tenTuyen, xn, dauA, dauB, soXeVd, soXeKh, soXe, loaiXe, sucChua, status } = req.body;
    if (!maTuyen) {
      return res.status(400).json({ success: false, message: 'Vui lòng cung cấp mã tuyến!' });
    }

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};

    const oldStatus = raw.tuyenList[maTuyen] ? raw.tuyenList[maTuyen].status : "active";

    raw.tuyenList[maTuyen] = {
      maTuyen,
      tenTuyen: tenTuyen || `${maTuyen}. Tuyến ${maTuyen}`,
      xn: xn || "",
      dauA: dauA || "",
      dauB: dauB || "",
      soXeVd: soXeVd || raw.tuyenList[maTuyen]?.soXeVd || "",
      soXeKh: soXeKh || soXe || "",
      soXe: soXeKh || soXe || "",
      loaiXe: loaiXe || "",
      sucChua: sucChua || "",
      status: status || oldStatus
    };

    await saveRawData(raw);
    res.json({ success: true, message: `Lưu thông tin tuyến [${maTuyen}] thành công!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi lưu thông tin tuyến: ' + err.message });
  }
});

// 6. API KHÓA / MỞ LẠI TUYẾN
app.post('/api/toggle-status-tuyen', async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    const raw = await getRawData();
    if (!raw.tuyenList || !raw.tuyenList[maTuyen]) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy mã tuyến này!' });
    }

    raw.tuyenList[maTuyen].status = status;
    await saveRawData(raw);

    const msg = status === 'locked' ? `Đã khóa tuyến [${maTuyen}] thành công!` : `Đã mở lại tuyến [${maTuyen}] thành công!`;
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi cập nhật trạng thái: ' + err.message });
  }
});

// 7. API LƯU BIỂU ĐỒ (QUÉT NỐT CUỐI CÙNG LÀM SOXEVĐ VÀ KHỚP CHUẨN THEO MÃ TUYẾN)
app.post('/api/luu-bieu-do', async (req, res) => {
  try {
    const { xn, tuyen, bieuDo, tenTab, rawData } = req.body;
    if (!tenTab || !rawData) {
      return res.status(400).json({ success: false, message: 'Thiếu tên tab hoặc dữ liệu bảng!' });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];

    const newTabObj = {
      xn: xn || "",
      tuyen: tuyen || "",
      bieuDo: bieuDo || "Cả tuần",
      tenTab: tenTab,
      rawData: rawData
    };

    const idx = raw.bieuDoList.findIndex(b => String(b.tenTab || '').trim() === String(tenTab).trim());
    if (idx >= 0) {
      raw.bieuDoList[idx] = newTabObj;
    } else {
      raw.bieuDoList.push(newTabObj);
    }

    // Quét số nốt lớn nhất
    let maxNot = 0;
    if (Array.isArray(rawData)) {
      rawData.forEach(row => {
        const val = parseInt(String(row[0] || '').trim(), 10);
        if (!isNaN(val) && val > maxNot) {
          maxNot = val;
        }
      });
    }

    // Lấy mã tuyến từ tên tuyến hoặc tên tab (ví dụ "E05. Long Biên..." -> mã tuyến là "E05")
    let matchMa = String(tuyen || '').match(/^([A-Za-z0-9]+)/);
    let maTuyenTarget = matchMa ? matchMa[1].toUpperCase() : '';

    if (maxNot > 0 && raw.tuyenList) {
      for (let k in raw.tuyenList) {
        const tObj = raw.tuyenList[k];
        const kUpper = k.toUpperCase();
        const tMaUpper = (tObj.maTuyen || '').toUpperCase();
        
        if (kUpper === maTuyenTarget || tMaUpper === maTuyenTarget || tObj.tenTuyen === tuyen) {
          raw.tuyenList[k].soXeVd = maxNot;
          break;
        }
      }
    }

    await saveRawData(raw);
    res.json({ 
      success: true, 
      message: `Lưu biểu đồ [${tenTab}] thành công! Đã tự động cập nhật số xe Vận doanh = ${maxNot} (theo nốt cuối cùng).` 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi lưu biểu đồ: ' + err.message });
  }
});

// 8. API XÓA BIỂU ĐỒ
app.post('/api/xoa-bieu-do', async (req, res) => {
  try {
    const { tenTab } = req.body;
    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];

    const beforeLen = raw.bieuDoList.length;
    raw.bieuDoList = raw.bieuDoList.filter(b => String(b.tenTab || '').trim() !== String(tenTab).trim());

    if (raw.bieuDoList.length === beforeLen) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy biểu đồ này để xóa!' });
    }

    await saveRawData(raw);
    res.json({ success: true, message: `Đã xóa biểu đồ [${tenTab}] khỏi hệ thống!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi xóa biểu đồ: ' + err.message });
  }
});

// 9. API TRA CỨU XE / TÌM KIẾM ĐỊNH DANH (DÒ CHUẨN THEO MÃ TUYẾN)
app.get('/api/tim-kiem-xe', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const maTuyenQuery = (req.query.tuyen || '').trim().toUpperCase();
    const raw = await getRawData();
    let xeList = Array.isArray(raw.xeList) ? raw.xeList : [];

    let ketQua = [];
    if (maTuyenQuery) {
      ketQua = xeList.filter(x => (x.maTuyen || '').toUpperCase() === maTuyenQuery);
    } else if (q) {
      ketQua = xeList.filter(x => {
        const cleanBks = (x.bks || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanBks.includes(q);
      });
    } else {
      ketQua = xeList;
    }

    const tuyenMap = raw.tuyenList || {};
    ketQua = ketQua.map(x => {
      const maXe = (x.maTuyen || '').toUpperCase();
      // Dò chính xác theo mã tuyến
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
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi tra cứu xe: ' + err.message });
  }
});

// 10. API IMPORT DANH SÁCH XE EXCEL
app.post(['/api/import-xe-excel', '/api/import-danh-sach-xe'], async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Vui lòng dán dữ liệu bảng xe!' });

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const lines = rawText.split('\n');
    let currentMaTuyen = '';
    let currentTenLoTrinh = '';
    const importedCars = [];
    const countMap = {};

    lines.forEach(line => {
      const fullLine = line.trim();
      if (!fullLine) return;
      const parts = line.split('\t').map(p => p.trim());

      const matchTuyen = fullLine.match(/^Tuyến\s+([0-9A-Za-z]+)\s*[:\-]?\s*(.*)/i);
      if (matchTuyen) {
        currentMaTuyen = matchTuyen[1].toUpperCase();
        currentTenLoTrinh = matchTuyen[2] ? matchTuyen[2].trim() : '';
        currentTenLoTrinh = currentTenLoTrinh.replace(/\t.*$/, '').trim();

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
            dauA: dauA,
            dauB: dauB,
            soXeVd: 0,
            soXeKh: 0,
            soXe: 0,
            loaiXe: "",
            sucChua: "",
            status: "active"
          };
        }
        return;
      }

      const bks = parts[0] || '';
      if ((bks.includes('-') || bks.includes('.')) && currentMaTuyen) {
        const nhanHieu = parts[1] || '';
        const chungLoai = parts[2] || '';
        const namSx = parts[3] || '';
        const sucChua = parts[4] || '';
        const donVi = parts[5] || '';

        importedCars.push({
          bks: bks.toUpperCase(),
          maTuyen: currentMaTuyen,
          nhanHieu,
          chungLoai,
          namSx,
          sucChua,
          donVi
        });

        countMap[currentMaTuyen] = (countMap[currentMaTuyen] || 0) + 1;

        if (raw.tuyenList[currentMaTuyen] && (!raw.tuyenList[currentMaTuyen].loaiXe || raw.tuyenList[currentMaTuyen].loaiXe === '')) {
          raw.tuyenList[currentMaTuyen].loaiXe = `${nhanHieu} ${chungLoai}`.trim();
          raw.tuyenList[currentMaTuyen].sucChua = sucChua ? `${sucChua} chỗ` : '';
        }
      }
    });

    if (importedCars.length === 0) {
      return res.status(400).json({ success: false, message: 'Không tìm thấy dòng xe hợp lệ nào để nạp!' });
    }

    const existingMap = new Map();
    raw.xeList.forEach(x => existingMap.set(x.bks.toUpperCase(), x));
    importedCars.forEach(x => existingMap.set(x.bks, x));
    raw.xeList = Array.from(existingMap.values());

    const finalCounts = {};
    raw.xeList.forEach(x => {
      finalCounts[x.maTuyen] = (finalCounts[x.maTuyen] || 0) + 1;
    });

    for (let k in raw.tuyenList) {
      if (finalCounts[k] !== undefined) {
        raw.tuyenList[k].soXeKh = finalCounts[k];
        raw.tuyenList[k].soXe = finalCounts[k];
      }
    }

    await saveRawData(raw);
    res.json({
      success: true,
      message: `Đã xử lý ${importedCars.length} xe! Tự động cập nhật số xe kế hoạch cho ${Object.keys(countMap).length} tuyến.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi nạp bảng xe: ' + err.message });
  }
});

// 11. API ĐIỀU CHUYỂN PHƯƠNG TIỆN SANG TUYẾN KHÁC
app.post('/api/dieu-chuyen-xe', async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;
    if (!bks || !tuyenMoi) return res.status(400).json({ success: false, message: 'Thiếu biển số xe hoặc tuyến đích!' });

    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    if (!raw.tuyenList) raw.tuyenList = {};

    const xe = raw.xeList.find(x => x.bks.toUpperCase() === bks.toUpperCase());
    if (!xe) return res.status(404).json({ success: false, message: `Không tìm thấy xe [${bks}] trong cơ sở dữ liệu!` });

    const tuyenCu = xe.maTuyen;
    const dest = tuyenMoi.toUpperCase();
    if (tuyenCu === dest) return res.json({ success: false, message: `Xe ${bks} hiện đã thuộc tuyến ${dest} rồi!` });

    xe.maTuyen = dest;

    const finalCounts = {};
    raw.xeList.forEach(x => {
      finalCounts[x.maTuyen] = (finalCounts[x.maTuyen] || 0) + 1;
    });

    for (let k in raw.tuyenList) {
      raw.tuyenList[k].soXeKh = finalCounts[k] || 0;
      raw.tuyenList[k].soXe = finalCounts[k] || 0;
    }

    await saveRawData(raw);
    res.json({
      success: true,
      message: `Đã điều chuyển xe [${bks}] từ tuyến ${tuyenCu} sang tuyến ${dest}. Số xe kế hoạch của cả hai tuyến đã tự động cập nhật!`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi điều chuyển xe: ' + err.message });
  }
});

// 12. API CỨU HỘ
app.get('/api/restore-backup', async (req, res) => {
  try {
    const localPath = path.join(__dirname, 'bus_full_data.json');
    if (fs.existsSync(localPath)) {
      const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      await saveRawData(fileData);
      res.json({ success: true, message: 'Khôi phục dữ liệu gốc thành công!' });
    } else {
      res.status(404).json({ success: false, message: 'Không tìm thấy file bus_full_data.json' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
