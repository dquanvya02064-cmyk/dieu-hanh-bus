(() => {
  const mapElement = document.getElementById('stopsAdminMap');
  if (!mapElement) return;
  const map = typeof L === 'undefined' ? null : L.map(mapElement).setView([21.0285, 105.8542], 12);
  if (map) {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  } else {
    mapElement.textContent = 'Không tải được thư viện bản đồ. Có thể tiếp tục nhập và sửa dữ liệu bằng biểu mẫu.';
    console.error('Leaflet không tải được; bản đồ quản trị chưa thể khởi tạo.');
  }
  const markerLayer = map ? L.layerGroup().addTo(map) : null;
  const routeLayer = map ? L.layerGroup().addTo(map) : null;
  let stops = [];
  let routes = [];
  let filteredStops = [];
  let importRows = [];
  let importSkippedSummary = '';
  let temporaryMarker = null;
  const get = id => document.getElementById(id);
  const mapInputIds = ['stopAdminLongitude', 'stopAdminLatitude'];

  function can(permission) {
    return typeof coQuyenAdmin === 'function' && coQuyenAdmin(permission);
  }

  function safeToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.append(container);
    }
    const toast = document.createElement('div');
    toast.className = `custom-toast ${type}`;
    const text = document.createElement('span');
    text.textContent = String(message || '');
    toast.append(text);
    container.append(toast);
    window.setTimeout(() => toast.remove(), 3000);
  }

  function routeCodes(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(/[,;|\n]+/);
    return [...new Set(list.map(item => {
      const match = String(item).trim().match(/^([a-z0-9]+)/i);
      return match ? match[1].toUpperCase() : '';
    }).filter(Boolean))];
  }

  function addCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = String(value ?? '');
    row.append(cell);
    return cell;
  }

  function populateRouteSelects() {
    const sorted = routes.slice().sort((a, b) => String(a.maTuyen).localeCompare(String(b.maTuyen), 'vi', { numeric: true }));
    const routeFilter = get('stopAdminRouteFilter');
    const routeEditor = get('stopAdminRoutes');
    const routeStatus = get('stopAdminRouteStatus');
    routeFilter.replaceChildren(new Option('Tất cả tuyến', ''));
    routeEditor.replaceChildren();
    routeStatus.replaceChildren(new Option('Chọn tuyến để bật / tắt', ''));
    sorted.forEach(item => {
      const code = String(item.maTuyen || '');
      const label = `${code} · ${item.tenTuyen || ''}${item.status === 'locked' ? ' · Tạm dừng' : ''}`;
      routeFilter.add(new Option(label, code));
      routeEditor.add(new Option(label, code));
      routeStatus.add(new Option(label, code));
    });
  }

  function renderHistory(history) {
    const body = get('stopAdminHistory');
    body.replaceChildren();
    if (!history.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 4;
      cell.textContent = 'Chưa có lịch sử cập nhật.';
      return;
    }
    history.forEach(entry => {
      const row = body.insertRow();
      const date = entry.changedAt ? new Date(entry.changedAt).toLocaleString('vi-VN') : '';
      addCell(row, date);
      const actionLabel = entry.action === 'import'
        ? `Import (${entry.added || 0} mới, ${entry.updated || 0} cập nhật)`
        : entry.action === 'route-status' ? 'Đổi trạng thái tuyến'
          : entry.action === 'status' ? 'Đổi trạng thái điểm'
            : entry.action === 'create' ? 'Thêm điểm' : 'Sửa điểm';
      addCell(row, actionLabel);
      addCell(row, entry.maDiem || (entry.maTuyen ? `Tuyến ${entry.maTuyen}` : '—'));
      addCell(row, entry.changedBy || '');
    });
  }

  function renderStops() {
    markerLayer?.clearLayers();
    routeLayer?.clearLayers();
    const body = get('stopAdminTable');
    body.replaceChildren();
    const query = get('stopAdminSearch').value.trim().toLocaleLowerCase('vi');
    const district = get('stopAdminDistrict').value;
    const route = get('stopAdminRouteFilter').value.toUpperCase();
    const status = get('stopAdminStatusFilter').value;
    const visible = stops.filter(stop => {
      if (district && stop.tenQuanHuyen !== district) return false;
      if (route && !routeCodes(stop.tuyenDiQua).includes(route)) return false;
      if (status === 'active' && stop.thuHoi) return false;
      if (status === 'withdrawn' && !stop.thuHoi) return false;
      return !query || [stop.maDiem, stop.maKhachHang, stop.tenDiem, stop.tenDuong, stop.tenQuanHuyen]
        .some(value => String(value || '').toLocaleLowerCase('vi').includes(query));
    });
    filteredStops = visible;

    visible.forEach(stop => {
      const lat = Number(stop.viDo);
      const lng = Number(stop.kinhDo);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (markerLayer) {
        const marker = L.circleMarker([lat, lng], {
          radius: 7,
          color: stop.thuHoi ? '#b42318' : '#1d70b8',
          fillColor: stop.thuHoi ? '#f97066' : '#59a6e8',
          fillOpacity: 0.9,
          weight: 2
        }).addTo(markerLayer);
        marker.on('click', () => chonDiemDung(stop.id));
      }

      const row = body.insertRow();
      addCell(row, stop.maDiem);
      addCell(row, stop.tenDiem);
      addCell(row, stop.tenQuanHuyen);
      addCell(row, routeCodes(stop.tuyenDiQua).join(', '));
      addCell(row, `${lng}, ${lat}`);
      addCell(row, stop.thuHoi ? 'Đang thu hồi' : 'Hoạt động');
      const actions = row.insertCell();
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-primary';
      edit.textContent = 'Sửa';
      edit.hidden = !can('stops.edit');
      edit.addEventListener('click', () => chonDiemDung(stop.id));
      actions.append(edit);
      if (can('stops.status')) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `btn ${stop.thuHoi ? 'btn-success' : 'btn-warning'}`;
        toggle.style.marginLeft = '5px';
        toggle.textContent = stop.thuHoi ? 'Mở lại' : 'Thu hồi';
        toggle.addEventListener('click', () => capNhatThuHoi(stop));
        actions.append(toggle);
      }
    });

    if (!visible.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 7;
      cell.textContent = stops.length ? 'Không có điểm dừng phù hợp.' : 'Chưa có dữ liệu. Hãy import Excel hoặc thêm điểm dừng mới.';
    }
    get('stopAdminSummary').textContent = `Đang hiển thị ${visible.length.toLocaleString('vi-VN')} / ${stops.length.toLocaleString('vi-VN')} điểm dừng.`;

    if (route && routeLayer) {
      const points = visible.filter(stop => routeCodes(stop.tuyenDiQua).includes(route))
        .map(stop => [Number(stop.viDo), Number(stop.kinhDo)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      if (points.length > 1) {
        L.polyline(points, { color: '#1d70b8', weight: 4, opacity: 0.72, dashArray: '7 7' }).addTo(routeLayer);
      }
    }
  }

  async function requestJson(path, body) {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'Thao tác không thành công.');
    return result;
  }

  async function taiDiemDungAdmin() {
    if (!can('stops.view')) {
      get('stopAdminSummary').textContent = 'Tài khoản chưa được cấp quyền xem dữ liệu điểm dừng.';
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/admin/diem-dung?readOnly=true`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Không thể tải dữ liệu điểm dừng.');
      stops = Array.isArray(data.diemDungList) ? data.diemDungList : [];
      routes = Array.isArray(data.tuyenList) ? data.tuyenList : [];
      const districts = [...new Set(stops.map(stop => stop.tenQuanHuyen).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'vi'));
      const selectedDistrict = get('stopAdminDistrict').value;
      get('stopAdminDistrict').replaceChildren(new Option('Tất cả quận / huyện', ''));
      districts.forEach(name => get('stopAdminDistrict').add(new Option(name, name)));
      get('stopAdminDistrict').value = districts.includes(selectedDistrict) ? selectedDistrict : '';
      populateRouteSelects();
      renderHistory(Array.isArray(data.diemDungHistory) ? data.diemDungHistory : []);
      renderStops();
    } catch (error) {
      get('stopAdminSummary').textContent = error.message || 'Có lỗi khi tải dữ liệu.';
      console.error('Lỗi tải dữ liệu điểm dừng quản trị:', error);
    }
  }

  function fillForm(stop) {
    get('stopAdminId').value = stop.id || '';
    get('stopAdminCode').value = stop.maDiem || '';
    get('stopAdminCustomerCode').value = stop.maKhachHang || '';
    get('stopAdminName').value = stop.tenDiem || '';
    get('stopAdminDistrictName').value = stop.tenQuanHuyen || '';
    get('stopAdminStreet').value = stop.tenDuong || '';
    get('stopAdminLongitude').value = stop.kinhDo ?? '';
    get('stopAdminLatitude').value = stop.viDo ?? '';
    get('stopAdminSound').value = stop.maAmThanh || '';
    get('stopAdminRadius').value = stop.banKinhQuet || '';
    get('stopAdminDirection').value = stop.huong || '';
    get('stopAdminShelter').value = stop.nhaChoTCT || '';
    get('stopAdminLed').value = stop.nhaChoLED || '';
    get('stopAdminSign').value = stop.bienBao || '';
    get('stopAdminAudio').value = stop.anhThanh || '';
    get('stopAdminStartDate').value = stop.ngayBatDau || '';
    get('stopAdminEndDate').value = stop.ngayKetThuc || '';
    get('stopAdminNote').value = stop.ghiChu || '';
    const historyPanel = get('stopAdminHistoryNotes');
    historyPanel.replaceChildren();
    const history = Array.isArray(stop.lichSuDiemDung) ? stop.lichSuDiemDung : [];
    if (history.length) {
      const heading = document.createElement('strong');
      heading.textContent = `Lịch sử điểm dừng (${history.length} mục):`;
      historyPanel.append(heading);
      const list = document.createElement('ul');
      history.forEach(entry => {
        const item = document.createElement('li');
        const period = [entry.ngayBatDau, entry.ngayKetThuc].filter(Boolean).join(' – ');
        item.textContent = [period, entry.ghiChu].filter(Boolean).join(' · ') || 'Không có ghi chú';
        list.append(item);
      });
      historyPanel.append(list);
    } else {
      historyPanel.textContent = 'Chưa có mục lịch sử riêng.';
    }
    get('stopAdminWithdrawn').checked = Boolean(stop.thuHoi);
    const selected = new Set(routeCodes(stop.tuyenDiQua));
    [...get('stopAdminRoutes').options].forEach(option => { option.selected = selected.has(option.value.toUpperCase()); });
    get('stopFormHeading').textContent = `Sửa điểm dừng · ${stop.maDiem}`;
  }

  function chonDiemDung(id) {
    const stop = stops.find(item => item.id === id);
    if (!stop) return;
    fillForm(stop);
    if (!map) return;
    const location = [Number(stop.viDo), Number(stop.kinhDo)];
    map.setView(location, 17);
    if (temporaryMarker) temporaryMarker.remove();
    temporaryMarker = L.marker(location, { draggable: can('stops.edit') }).addTo(map);
    temporaryMarker.bindPopup(document.createTextNode(`${stop.maDiem} · ${stop.tenDiem}`)).openPopup();
    temporaryMarker.on('dragend', event => {
      const point = event.target.getLatLng();
      get('stopAdminLatitude').value = point.lat.toFixed(7);
      get('stopAdminLongitude').value = point.lng.toFixed(7);
    });
  }

  function lamMoiFormDiemDung() {
    get('stopAdminForm').reset();
    get('stopAdminId').value = '';
    get('stopFormHeading').textContent = 'Thêm điểm dừng';
    get('stopAdminHistoryNotes').replaceChildren();
    [...get('stopAdminRoutes').options].forEach(option => { option.selected = false; });
    if (temporaryMarker) {
      temporaryMarker.remove();
      temporaryMarker = null;
    }
  }

  async function saveStop(event) {
    event.preventDefault();
    if (!can('stops.edit')) return;
    const record = {
      id: get('stopAdminId').value || undefined,
      maDiem: get('stopAdminCode').value,
      maKhachHang: get('stopAdminCustomerCode').value,
      tenDiem: get('stopAdminName').value,
      tenQuanHuyen: get('stopAdminDistrictName').value,
      tenDuong: get('stopAdminStreet').value,
      tuyenDiQua: [...get('stopAdminRoutes').selectedOptions].map(option => option.value),
      kinhDo: get('stopAdminLongitude').value,
      viDo: get('stopAdminLatitude').value,
      maAmThanh: get('stopAdminSound').value,
      banKinhQuet: get('stopAdminRadius').value,
      huong: get('stopAdminDirection').value,
      nhaChoTCT: get('stopAdminShelter').value,
      nhaChoLED: get('stopAdminLed').value,
      bienBao: get('stopAdminSign').value,
      anhThanh: get('stopAdminAudio').value,
      ngayBatDau: get('stopAdminStartDate').value,
      ngayKetThuc: get('stopAdminEndDate').value,
      ghiChu: get('stopAdminNote').value,
      thuHoi: get('stopAdminWithdrawn').checked
    };
    try {
      const result = await requestJson('/api/admin/diem-dung', record);
      safeToast(result.message, 'success');
      await taiDiemDungAdmin();
      lamMoiFormDiemDung();
    } catch (error) {
      safeToast(error.message, 'error');
    }
  }

  async function capNhatThuHoi(stop) {
    try {
      const result = await requestJson('/api/admin/diem-dung/trang-thai', {
        id: stop.id,
        thuHoi: !stop.thuHoi
      });
      safeToast(result.message, 'success');
      await taiDiemDungAdmin();
    } catch (error) {
      safeToast(error.message, 'error');
    }
  }

  async function doiTrangThaiTuyenDiemDung() {
    const code = get('stopAdminRouteStatus').value;
    const selected = routes.find(item => String(item.maTuyen) === code);
    if (!selected) return safeToast('Hãy chọn tuyến cần cập nhật.', 'error');
    const status = selected.status === 'locked' ? 'active' : 'locked';
    try {
      const result = await requestJson('/api/admin/diem-dung/trang-thai-tuyen', { maTuyen: code, status });
      safeToast(result.message, 'success');
      await taiDiemDungAdmin();
    } catch (error) {
      safeToast(error.message, 'error');
    }
  }

  function normalizeHeader(value) {
    return String(value || '').trim().toLocaleLowerCase('vi')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
      .replace(/[^a-z0-9]/g, '');
  }

  const importHeaderAliases = {
    thuTu: ['tt', 'stt', 'thutu'],
    maDiem: ['matheoqdtct', 'matheoqdbtct', 'madiem', 'mastop', 'matheoqd'],
    maKhachHang: ['makhachhang', 'makh'],
    tenQuanHuyen: ['tenquanhuyen', 'quanhuyen', 'quan', 'huyen'],
    tenDuong: ['tenduongphonguoclo', 'tenduongphoquoclo', 'tenduong', 'duongpho', 'quoclo'],
    tenDiem: ['tendiemdung', 'tendiem', 'tendiemdungxe', 'tendiembus'],
    anhThanh: ['anhthanh', 'anhamthanh', 'amthanh'],
    bienBao: ['bienbao'],
    nhaChoTCT: ['nhachotct', 'nhacho'],
    nhaChoLED: ['nhachocoled', 'led'],
    tuyenDiQua: ['tuyendiqua', 'tuyen'],
    thuHoi: ['dangthuhoi', 'thuhoi'],
    kinhDo: ['kinhdo', 'longitude', 'long'],
    viDo: ['vido', 'latitude', 'lat'],
    banKinhQuet: ['bankinhquet', 'bankinhquetm'],
    huong: ['huong'],
    maAmThanh: ['maamthanh'],
    ngayBatDau: ['ngaybatdau'],
    ngayKetThuc: ['ngayketthuc'],
    ghiChu: ['ghichu']
  };

  const stopExcelHeaders = [
    'TT', 'Mã theo QĐ TCT', 'Mã Khách Hàng', 'Tên Quận - Huyện', 'Tên Đường, Phố - Quốc lộ',
    'Tên Điểm dừng', 'Âm Thanh', 'Biển báo', 'Nhà chờ', 'Nhà chờ có LED',
    'Tuyến đi qua', 'Đang thu hồi', 'Kinh độ', 'Vĩ độ', 'Bán kính quét (m)', 'Hướng',
    'Mã Âm thanh', 'Ngày bắt đầu', 'Ngày kết thúc', 'Ghi chú'
  ];

  function mapExcelRow(row, columns) {
    const value = field => columns[field] === undefined ? '' : row[columns[field]];
    const toNumber = input => {
      const normalized = String(input ?? '').trim().replace(',', '.');
      return normalized ? Number(normalized) : '';
    };
    const withdrawnText = String(value('thuHoi') || '').trim().toLocaleLowerCase('vi');
    return {
      thuTu: String(value('thuTu') || '').trim(),
      maDiem: String(value('maDiem') || '').trim(),
      maKhachHang: String(value('maKhachHang') || '').trim(),
      tenQuanHuyen: String(value('tenQuanHuyen') || '').trim(),
      tenDuong: String(value('tenDuong') || '').trim(),
      tenDiem: String(value('tenDiem') || '').trim(),
      anhThanh: String(value('anhThanh') || '').trim(),
      bienBao: String(value('bienBao') || '').trim(),
      nhaChoTCT: String(value('nhaChoTCT') || '').trim(),
      nhaChoLED: String(value('nhaChoLED') || '').trim(),
      tuyenDiQua: routeCodes(value('tuyenDiQua')),
      thuHoi: ['x', '1', 'true', 'yes', 'y', 'co', 'có', 'thu hồi'].includes(withdrawnText),
      kinhDo: toNumber(value('kinhDo')),
      viDo: toNumber(value('viDo')),
      banKinhQuet: String(value('banKinhQuet') || '').trim(),
      huong: String(value('huong') || '').trim(),
      maAmThanh: String(value('maAmThanh') || '').trim(),
      ngayBatDau: String(value('ngayBatDau') || '').trim(),
      ngayKetThuc: String(value('ngayKetThuc') || '').trim(),
      ghiChu: String(value('ghiChu') || '').trim()
    };
  }

  function taoWorksheetDiemDung(dataRows) {
    const sheet = XLSX.utils.aoa_to_sheet([
      Array(17).fill('').concat(['Lịch sử điểm dừng', '', '']),
      stopExcelHeaders,
      ...dataRows
    ]);
    sheet['!merges'] = [{ s: { r: 0, c: 17 }, e: { r: 0, c: 19 } }];
    if (sheet.R1) sheet.R1.s = { alignment: { horizontal: 'center', vertical: 'center' } };
    return sheet;
  }

  function showImportPreview(rows, errors, duplicateInfo = { duplicateCount: 0, conflicts: [] }, sourceCount = rows.length) {
    importRows = rows;
    importSkippedSummary = errors.length || duplicateInfo.conflicts.length
      ? `Bỏ qua ${errors.length} dòng lỗi và ${duplicateInfo.conflicts.length} mã mâu thuẫn; sửa file để nhập lại phần này.`
      : '';
    const preview = get('stopImportPreview');
    preview.replaceChildren();
    preview.style.display = 'block';
    const header = document.createElement('div');
    const existing = new Set(stops.map(stop => stop.maDiem.toLocaleUpperCase('vi')));
    const addCount = rows.filter(row => !existing.has(row.maDiem.toLocaleUpperCase('vi'))).length;
    const updateCount = rows.length - addCount;
    header.textContent = `Xem trước: ${sourceCount} dòng trong file · ${duplicateInfo.duplicateCount} dòng trùng mã sẽ gộp · ${rows.length} điểm hợp lệ · ${addCount} điểm mới · ${updateCount} điểm cập nhật · ${errors.length} dòng lỗi sẽ bỏ qua · ${duplicateInfo.conflicts.length} mã mâu thuẫn sẽ bỏ qua.`;
    preview.append(header);
    if (errors.length) {
      const errorSummary = document.createElement('div');
      errorSummary.style.color = '#b54708';
      errorSummary.textContent = 'Các dòng lỗi sẽ không được nhập; có thể sửa file rồi nhập lại sau.';
      preview.append(errorSummary);
      const list = document.createElement('ul');
      errors.slice(0, 20).forEach(message => {
        const item = document.createElement('li');
        item.textContent = message;
        list.append(item);
      });
      preview.append(list);
      if (errors.length > 20) {
        const remaining = document.createElement('div');
        remaining.textContent = `Còn ${errors.length - 20} lỗi chưa hiển thị.`;
        preview.append(remaining);
      }
    }
    if (duplicateInfo.conflicts.length) {
      const conflictHeader = document.createElement('div');
      conflictHeader.style.color = '#b42318';
      conflictHeader.style.fontWeight = 'bold';
      conflictHeader.textContent = `${duplicateInfo.conflicts.length} mã điểm có thông tin cốt lõi mâu thuẫn; các mã này sẽ được bỏ qua, những điểm khác vẫn nhập bình thường.`;
      preview.append(conflictHeader);
      const conflictList = document.createElement('ul');
      duplicateInfo.conflicts.slice(0, 20).forEach(conflict => {
        const item = document.createElement('li');
        item.textContent = `${conflict.maDiem}: ${conflict.fields.join(', ')}`;
        conflictList.append(item);
      });
      preview.append(conflictList);
      if (duplicateInfo.conflicts.length > 20) {
        const remaining = document.createElement('div');
        remaining.textContent = `Còn ${duplicateInfo.conflicts.length - 20} mã mâu thuẫn chưa hiển thị.`;
        preview.append(remaining);
      }
    }
    if (rows.length) {
      const sample = document.createElement('div');
      sample.textContent = `Ví dụ dòng đầu: ${rows[0].maDiem} · ${rows[0].tenDiem}`;
      preview.append(sample);
    }
    if (rows.length && can('stops.import')) {
      const commit = document.createElement('button');
      commit.type = 'button';
      commit.className = 'btn btn-success';
      commit.style.marginTop = '8px';
      commit.textContent = `Nhập ${rows.length} điểm hợp lệ`;
      commit.addEventListener('click', commitImport);
      preview.append(commit);
    } else if (errors.length || duplicateInfo.conflicts.length) {
      const emptySummary = document.createElement('div');
      emptySummary.style.color = '#b42318';
      emptySummary.style.fontWeight = 'bold';
      emptySummary.textContent = 'Không có điểm hợp lệ để nhập. Hãy sửa các dòng lỗi rồi thử lại.';
      preview.append(emptySummary);
    }
  }

  async function xuLyExcelDiemDung(file) {
    get('stopImportMessage').textContent = '';
    try {
      if (!window.XLSX) throw new Error('Không tải được thư viện đọc Excel. Hãy tải lại trang.');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('File không có trang tính.');
      const values = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const headerIndex = values.findIndex(row => {
        const headers = row.map(normalizeHeader);
        const hasCode = importHeaderAliases.maDiem.some(alias => headers.includes(alias));
        const hasName = importHeaderAliases.tenDiem.some(alias => headers.includes(alias));
        return hasCode && hasName;
      });
      if (headerIndex < 0) throw new Error('Không nhận diện được dòng tiêu đề. Hãy dùng mẫu Excel hoặc kiểm tra cột mã điểm và tên điểm.');
      const headers = values[headerIndex].map(normalizeHeader);
      const columns = {};
      Object.entries(importHeaderAliases).forEach(([field, aliases]) => {
        columns[field] = headers.findIndex(header => aliases.includes(header));
        if (columns[field] < 0) delete columns[field];
      });
      const records = [];
      const errors = [];
      let sourceCount = 0;
      values.slice(headerIndex + 1).forEach((row, index) => {
        if (!row.some(value => String(value || '').trim())) return;
        sourceCount++;
        const record = mapExcelRow(row, columns);
        const line = headerIndex + index + 2;
        if (!record.maDiem) errors.push(`Dòng ${line}: thiếu mã điểm.`);
        else if (!record.tenDiem) errors.push(`Dòng ${line}: thiếu tên điểm.`);
        else if (record.kinhDo === '' || !Number.isFinite(record.kinhDo) || record.kinhDo < -180 || record.kinhDo > 180) errors.push(`Dòng ${line}: kinh độ không hợp lệ.`);
        else if (record.viDo === '' || !Number.isFinite(record.viDo) || record.viDo < -90 || record.viDo > 90) errors.push(`Dòng ${line}: vĩ độ không hợp lệ.`);
        else records.push(record);
      });
      const duplicateInfo = StopImport.mergeDuplicateStopRows(records);
      showImportPreview(duplicateInfo.rows, errors, duplicateInfo, sourceCount);
    } catch (error) {
      get('stopImportPreview').style.display = 'none';
      get('stopImportMessage').textContent = error.message || 'Không thể đọc file.';
      get('stopImportMessage').style.color = '#b42318';
    }
  }

  async function commitImport() {
    try {
      const result = await requestJson('/api/admin/diem-dung/import', { diemDungList: importRows });
      safeToast([result.message, importSkippedSummary].filter(Boolean).join(' '), 'success');
      get('stopImportPreview').style.display = 'none';
      get('stopExcelFile').value = '';
      importSkippedSummary = '';
      await taiDiemDungAdmin();
    } catch (error) {
      safeToast(error.message, 'error');
    }
  }

  function taiMauExcelDiemDung() {
    if (!window.XLSX) return safeToast('Không tải được thư viện Excel.', 'error');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, taoWorksheetDiemDung([Array(stopExcelHeaders.length).fill('')]), 'Diem dung');
    XLSX.writeFile(workbook, 'mau-diem-dung.xlsx');
  }

  function xuatDiemDungDangLoc() {
    if (!window.XLSX) return safeToast('Không tải được thư viện Excel.', 'error');
    const rows = filteredStops.flatMap((stop, index) => {
      const history = Array.isArray(stop.lichSuDiemDung) && stop.lichSuDiemDung.length
        ? stop.lichSuDiemDung
        : [{ ngayBatDau: stop.ngayBatDau, ngayKetThuc: stop.ngayKetThuc, ghiChu: stop.ghiChu }];
      return history.map((entry, historyIndex) => [
        stop.thuTu || index + 1, stop.maDiem, stop.maKhachHang, stop.tenQuanHuyen,
        stop.tenDuong, stop.tenDiem, stop.anhThanh, stop.bienBao, stop.nhaChoTCT,
        stop.nhaChoLED, routeCodes(stop.tuyenDiQua).join(', '), stop.thuHoi ? 'X' : '',
        stop.kinhDo, stop.viDo, stop.banKinhQuet, stop.huong, stop.maAmThanh,
        entry.ngayBatDau, entry.ngayKetThuc, entry.ghiChu
      ]);
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, taoWorksheetDiemDung(rows), 'Diem dung');
    XLSX.writeFile(workbook, 'diem-dung-da-loc.xlsx');
  }

  function setCoordinateFromMap(event) {
    if (!map || !can('stops.edit')) return;
    const { lat, lng } = event.latlng;
    get('stopAdminLatitude').value = lat.toFixed(7);
    get('stopAdminLongitude').value = lng.toFixed(7);
    if (temporaryMarker) temporaryMarker.remove();
    temporaryMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
    temporaryMarker.on('dragend', dragEvent => {
      const point = dragEvent.target.getLatLng();
      get('stopAdminLatitude').value = point.lat.toFixed(7);
      get('stopAdminLongitude').value = point.lng.toFixed(7);
    });
  }

  function updateMapFromFields() {
    if (!map || !can('stops.edit')) return;
    const lng = Number(get('stopAdminLongitude').value);
    const lat = Number(get('stopAdminLatitude').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (temporaryMarker) temporaryMarker.setLatLng([lat, lng]);
    else temporaryMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
    map.setView([lat, lng], Math.max(map.getZoom(), 16));
  }

  function initialize() {
    get('stopAdminForm').addEventListener('submit', saveStop);
    get('stopExcelFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file) xuLyExcelDiemDung(file);
    });
    ['stopAdminSearch', 'stopAdminDistrict', 'stopAdminRouteFilter', 'stopAdminStatusFilter']
      .forEach(id => get(id).addEventListener(id === 'stopAdminSearch' ? 'input' : 'change', renderStops));
    get('stopAdminRouteStatus').addEventListener('change', event => {
      const selected = routes.find(item => String(item.maTuyen) === event.target.value);
      const button = event.target.parentElement.querySelector('[data-action-permission="stops.status"]');
      if (selected && button) button.lastChild.textContent = selected.status === 'locked' ? ' Mở tuyến' : ' Tạm dừng tuyến';
    });
    if (map) map.on('click', setCoordinateFromMap);
    mapInputIds.forEach(id => get(id).addEventListener('change', updateMapFromFields));
    window.addEventListener('stops-admin-visible', () => map?.invalidateSize());
  }

  window.taiDiemDungAdmin = taiDiemDungAdmin;
  window.chonDiemDung = chonDiemDung;
  window.lamMoiFormDiemDung = lamMoiFormDiemDung;
  window.doiTrangThaiTuyenDiemDung = doiTrangThaiTuyenDiemDung;
  window.taiMauExcelDiemDung = taiMauExcelDiemDung;
  window.xuatDiemDungDangLoc = xuatDiemDungDangLoc;
  window.addEventListener('DOMContentLoaded', initialize);
})();
