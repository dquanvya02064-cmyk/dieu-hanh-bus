const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Chuỗi kết nối MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://dquan4701_db_user:Quanbus123456@cluster0.sur3koa.mongodb.net/dieuhanhbus?retryWrites=true&w=majority';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Schema lưu trữ dữ liệu
const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

// Kết nối database
mongoose.connect(MONGO_URI)
  .then(() => console.log('>>> Da ket noi thanh cong voi MongoDB Atlas!'))
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

// Hàm phụ trợ lấy dữ liệu
async function getBusData(res) {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (!doc || !doc.data) {
      return res.status(404).json({ error: 'Chua co du lieu tren database' });
    }
    return res.json(doc.data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Loi he thong khi doc database' });
  }
}

// Cung cấp cả 2 đường dẫn API để tương thích hoàn toàn giao diện
app.get('/api/danh-muc', (req, res) => getBusData(res));
app.get('/api/bus-data', (req, res) => getBusData(res));

// API lưu dữ liệu (hỗ trợ cả 2 endpoint ghi)
async function saveBusData(req, res) {
  try {
    const updatedData = req.body;
    await BusModel.findOneAndUpdate(
      { key: 'main_data' },
      { key: 'main_data', data: updatedData },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true, message: 'Luu du lieu len MongoDB thanh cong' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi ghi du lieu len database' });
  }
}

app.post('/api/danh-muc', (req, res) => saveBusData(req, res));
app.post('/api/bus-data', (req, res) => saveBusData(req, res));

// Chạy server
app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
