const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Đường dẫn kết nối MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://dquan4701_db_user:Quanbus123456@cluster0.sur3koa.mongodb.net/dieuhanhbus?retryWrites=true&w=majority';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Định nghĩa cấu trúc lưu dữ liệu
const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

// Kết nối database
mongoose.connect(MONGO_URI)
  .then(() => console.log('>>> Da ket noi thanh cong voi MongoDB Atlas!'))
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

// API 1: Lấy dữ liệu cho trang biểu đồ và tìm kiếm
app.get('/api/bus-data', async (req, res) => {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (!doc) {
      return res.status(404).json({ error: 'Chua co du lieu tren database' });
    }
    res.json(doc.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi doc du lieu tu database' });
  }
});

// API 2: Lưu dữ liệu khi chỉnh sửa từ trang Admin
app.post('/api/bus-data', async (req, res) => {
  try {
    const updatedData = req.body;
    await BusModel.findOneAndUpdate(
      { key: 'main_data' },
      { key: 'main_data', data: updatedData },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Luu du lieu len MongoDB thanh cong' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi ghi du lieu len database' });
  }
});

// Khởi chạy server
app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
