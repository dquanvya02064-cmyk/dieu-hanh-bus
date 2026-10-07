const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://dquan4701_db_user:Quanbus123456@cluster0.sur3koa.mongodb.net/dieuhanhbus?retryWrites=true&w=majority';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

mongoose.connect(MONGO_URI)
  .then(() => console.log('>>> Da ket noi thanh cong voi MongoDB Atlas!'))
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

// Trả dữ liệu phù hợp với frontend
app.get(['/api/danh-muc', '/api/bus-data'], async (req, res) => {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (!doc || !doc.data) {
      return res.status(404).json({ error: 'Chua co du lieu tren database' });
    }

    // Nếu frontend gọi /api/danh-muc và trong data có chứa tuyenList thì bóc tách chuẩn xác
    if (req.path === '/api/danh-muc' && doc.data.tuyenList) {
      return res.json(doc.data.tuyenList);
    }

    return res.json(doc.data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Loi doc database' });
  }
});

// Lưu dữ liệu
app.post(['/api/danh-muc', '/api/bus-data'], async (req, res) => {
  try {
    let payload = req.body;
    if (req.path === '/api/danh-muc') {
      const doc = await BusModel.findOne({ key: 'main_data' });
      let currentData = (doc && doc.data) ? doc.data : {};
      currentData.tuyenList = payload;
      payload = currentData;
    }

    await BusModel.findOneAndUpdate(
      { key: 'main_data' },
      { key: 'main_data', data: payload },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true, message: 'Luu thanh cong vao MongoDB Atlas' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi ghi database' });
  }
});

app.listen(PORT, () => {
  console.log(`=== HE THONG DANG CHAY TAI PORT: ${PORT} ===`);
});
