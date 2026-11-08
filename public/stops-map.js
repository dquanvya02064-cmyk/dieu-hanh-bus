(() => {
  const mapElement = document.getElementById('stopsPublicMap');
  if (!mapElement) return;
  if (typeof L === 'undefined') {
    document.getElementById('stopMapSummary').textContent = 'Không tải được thư viện bản đồ. Hãy tải lại trang hoặc kiểm tra kết nối mạng.';
    console.error('Leaflet không tải được; bản đồ điểm dừng chưa thể khởi tạo.');
    return;
  }

  const map = L.map(mapElement).setView([21.0285, 105.8542], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);
  let stops = [];
  let routes = [];
  const search = document.getElementById('stopMapSearch');
  const district = document.getElementById('stopMapDistrict');
  const route = document.getElementById('stopMapRoute');
  const showWithdrawn = document.getElementById('stopMapShowWithdrawn');
  const summary = document.getElementById('stopMapSummary');
  const results = document.getElementById('stopMapResults');

  function getRouteCodes(stop) {
    const values = Array.isArray(stop.tuyenDiQua) ? stop.tuyenDiQua : String(stop.tuyenDiQua || '').split(/[,;|\n]+/);
    return values.map(value => {
      const match = String(value).trim().match(/^([a-z0-9]+)/i);
      return match ? match[1].toUpperCase() : '';
    }).filter(Boolean);
  }

  function escapeText(value) {
    return String(value || '').trim();
  }

  function updateFilters() {
    const districts = [...new Set(stops.map(stop => stop.tenQuanHuyen).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'vi'));
    district.replaceChildren(new Option('Tất cả quận / huyện', ''));
    districts.forEach(name => district.add(new Option(name, name)));

    route.replaceChildren(new Option('Tất cả tuyến', ''));
    routes.slice().sort((a, b) => String(a.maTuyen).localeCompare(String(b.maTuyen), 'vi', { numeric: true }))
      .forEach(item => {
        const status = item.status === 'locked' ? ' · Tạm dừng' : '';
        route.add(new Option(`${item.maTuyen} · ${item.tenTuyen || ''}${status}`, item.maTuyen));
      });
  }

  function render() {
    layer.clearLayers();
    results.replaceChildren();

    const query = search.value.trim().toLocaleLowerCase('vi');
    const selectedDistrict = district.value;
    const selectedRoute = route.value.toUpperCase();
    const visible = stops.filter(stop => {
      if (!showWithdrawn.checked && stop.thuHoi) return false;
      if (selectedDistrict && stop.tenQuanHuyen !== selectedDistrict) return false;
      if (selectedRoute && !getRouteCodes(stop).includes(selectedRoute)) return false;
      if (query && ![stop.maDiem, stop.maKhachHang, stop.tenDiem, stop.tenDuong, stop.tenQuanHuyen]
        .some(value => String(value || '').toLocaleLowerCase('vi').includes(query))) return false;
      return true;
    });

    visible.forEach(stop => {
      const lat = Number(stop.viDo);
      const lng = Number(stop.kinhDo);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const marker = L.circleMarker([lat, lng], {
        radius: 7,
        color: stop.thuHoi ? '#b42318' : '#1d70b8',
        fillColor: stop.thuHoi ? '#f97066' : '#59a6e8',
        fillOpacity: 0.9,
        weight: 2
      }).addTo(layer);
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = stop.tenDiem || 'Điểm dừng';
      popup.append(title);
      const details = [
        `Mã điểm: ${escapeText(stop.maDiem)}`,
        stop.tenDuong,
        stop.tenQuanHuyen,
        getRouteCodes(stop).length ? `Tuyến: ${getRouteCodes(stop).join(', ')}` : '',
        stop.thuHoi ? 'Đang thu hồi' : ''
      ].filter(Boolean);
      details.forEach(text => {
        const line = document.createElement('div');
        line.textContent = text;
        popup.append(line);
      });
      marker.bindPopup(popup);
      const button = document.createElement('button');
      button.type = 'button';
      button.addEventListener('click', () => {
        map.setView([lat, lng], Math.max(map.getZoom(), 16));
        marker.openPopup();
      });
      const label = document.createElement('span');
      label.textContent = `${stop.maDiem} · ${stop.tenDiem}`;
      const state = document.createElement('span');
      state.textContent = stop.thuHoi ? 'Thu hồi' : (stop.tenQuanHuyen || '');
      button.append(label, state);
      results.append(button);
    });

    if (selectedRoute) {
      const points = visible
        .filter(stop => getRouteCodes(stop).includes(selectedRoute))
        .map(stop => [Number(stop.viDo), Number(stop.kinhDo)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      if (points.length > 1) {
        L.polyline(points, { color: '#1d70b8', weight: 4, opacity: 0.72, dashArray: '7 7' }).addTo(layer);
      }
    }

    summary.textContent = `${visible.length.toLocaleString('vi-VN')} điểm dừng${selectedRoute ? ` · tuyến ${selectedRoute}` : ''}`;
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'Không tìm thấy điểm dừng phù hợp.';
      empty.style.padding = '12px';
      results.append(empty);
    }
  }

  async function loadStops() {
    try {
      const response = await fetch(`${API_BASE}/api/diem-dung`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Không thể tải dữ liệu điểm dừng.');
      stops = Array.isArray(data.diemDungList) ? data.diemDungList : [];
      routes = Array.isArray(data.tuyenList) ? data.tuyenList : [];
      updateFilters();
      render();
    } catch (error) {
      summary.textContent = error.message || 'Có lỗi khi tải bản đồ điểm dừng.';
      console.error('Lỗi tải bản đồ điểm dừng:', error);
    }
  }

  [search, district, route, showWithdrawn].forEach(element => {
    element.addEventListener(element === search ? 'input' : 'change', render);
  });
  window.addEventListener('stops-map-visible', () => map.invalidateSize());
  loadStops();
})();
