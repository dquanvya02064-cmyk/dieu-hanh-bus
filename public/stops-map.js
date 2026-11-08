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

  const markerRenderer = L.canvas({ padding: 0.5 });
  const layer = L.layerGroup().addTo(map);
  const MAX_RESULT_ROWS = 100;
  let searchTimer;
  let stops = [];
  let routes = [];
  const search = document.getElementById('stopMapSearch');
  const district = document.getElementById('stopMapDistrict');
  const route = document.getElementById('stopMapRoute');
  const direction = document.getElementById('stopMapDirection');
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
    const selectedDirection = direction.value;
    const visible = stops.filter(stop => {
      if (!showWithdrawn.checked && stop.thuHoi) return false;
      if (selectedDistrict && stop.tenQuanHuyen !== selectedDistrict) return false;
      if (selectedRoute && !getRouteCodes(stop).includes(selectedRoute)) return false;
      if (selectedRoute && selectedDirection && !(stop.tuyenTheoChieu || []).some(item =>
        item.maTuyen.toUpperCase() === selectedRoute && item.chieu === selectedDirection
      )) return false;
      if (query && ![stop.maDiem, stop.maKhachHang, stop.tenDiem, stop.tenDuong, stop.tenQuanHuyen]
        .some(value => String(value || '').toLocaleLowerCase('vi').includes(query))) return false;
      return true;
    });
    if (selectedRoute && selectedDirection) {
      visible.sort((a, b) => {
        const orderFor = stop => (stop.tuyenTheoChieu || []).find(item =>
          item.maTuyen.toUpperCase() === selectedRoute && item.chieu === selectedDirection
        )?.thuTu ?? Number.MAX_SAFE_INTEGER;
        return orderFor(a) - orderFor(b) || a.maDiem.localeCompare(b.maDiem, 'vi');
      });
    }

    visible.forEach((stop, index) => {
      const lat = Number(stop.viDo);
      const lng = Number(stop.kinhDo);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const marker = L.circleMarker([lat, lng], {
        renderer: markerRenderer,
        radius: map.getZoom() < 14 ? 4 : 6,
        color: stop.thuHoi ? '#b42318' : '#1d70b8',
        fillColor: stop.thuHoi ? '#f97066' : '#59a6e8',
        fillOpacity: 0.85,
        weight: 1
      }).addTo(layer);
      marker.bindPopup(() => {
        const popup = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = stop.tenDiem || 'Điểm dừng';
        popup.append(title);
        const stopRoutes = getRouteCodes(stop);
        const directionDetails = (stop.tuyenTheoChieu || [])
          .filter(item => item.maTuyen.toUpperCase() === selectedRoute && item.chieu === selectedDirection)
          .map(item => `${Number.isInteger(item.thuTu) ? `Thứ tự ${item.thuTu}` : 'Chưa xếp thứ tự'} · Chiều ${item.chieu === 'di' ? 'Đi' : 'Về'}`);
        const details = [
          `Mã điểm: ${escapeText(stop.maDiem)}`,
          stop.tenDuong,
          stop.tenQuanHuyen,
          stopRoutes.length ? `Tuyến: ${stopRoutes.join(', ')}` : '',
          ...directionDetails,
          stop.thuHoi ? 'Đang thu hồi' : ''
        ].filter(Boolean);
        details.forEach(text => {
          const line = document.createElement('div');
          line.textContent = text;
          popup.append(line);
        });
        return popup;
      });

      if (index < MAX_RESULT_ROWS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.addEventListener('click', () => {
          map.setView([lat, lng], Math.max(map.getZoom(), 16));
          marker.openPopup();
        });
        const label = document.createElement('span');
        label.textContent = `${stop.maDiem} · ${stop.tenDiem}`;
        const state = document.createElement('span');
        const assignment = (stop.tuyenTheoChieu || []).find(item =>
          item.maTuyen.toUpperCase() === selectedRoute && item.chieu === selectedDirection
        );
        state.textContent = assignment
          ? `${Number.isInteger(assignment.thuTu) ? `#${assignment.thuTu}` : 'Chưa xếp thứ tự'} · ${selectedDirection === 'di' ? 'Đi' : 'Về'}` :
          (stop.thuHoi ? 'Thu hồi' : (stop.tenQuanHuyen || ''));
        button.append(label, state);
        results.append(button);
      }
    });

    if (selectedRoute && selectedDirection) {
      const routeStops = stops.flatMap(stop => {
        if (!showWithdrawn.checked && stop.thuHoi) return [];
        const assignment = (stop.tuyenTheoChieu || []).find(item =>
          item.maTuyen.toUpperCase() === selectedRoute && item.chieu === selectedDirection
        );
        if (!assignment) return [];
        const lat = Number(stop.viDo);
        const lng = Number(stop.kinhDo);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [{ stop, assignment, lat, lng }] : [];
      }).sort((a, b) => a.assignment.thuTu - b.assignment.thuTu || a.stop.maDiem.localeCompare(b.stop.maDiem, 'vi'));
      const definedOrders = routeStops.map(item => item.assignment.thuTu).filter(Number.isInteger);
      const hasDuplicateOrders = new Set(definedOrders).size !== definedOrders.length;
      const hasMissingOrders = routeStops.some(item => !Number.isInteger(item.assignment.thuTu));
      if (routeStops.length > 1 && !hasDuplicateOrders && !hasMissingOrders) {
        L.polyline(routeStops.map(item => [item.lat, item.lng]), {
          color: selectedDirection === 'di' ? '#1d70b8' : '#d97706',
          weight: 4,
          opacity: 0.8
        }).addTo(layer);
        L.circleMarker([routeStops[0].lat, routeStops[0].lng], {
          renderer: markerRenderer, radius: 8, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1
        }).bindPopup(document.createTextNode(`Bắt đầu · ${routeStops[0].stop.tenDiem}`)).addTo(layer);
        const lastStop = routeStops[routeStops.length - 1];
        L.circleMarker([lastStop.lat, lastStop.lng], {
          renderer: markerRenderer, radius: 8, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1
        }).bindPopup(document.createTextNode(`Kết thúc · ${lastStop.stop.tenDiem}`)).addTo(layer);
      }
      const directionNote = document.createElement('div');
      directionNote.style.padding = '8px 10px';
      directionNote.style.color = '#64748B';
      directionNote.textContent = hasDuplicateOrders
        ? 'Có điểm bị trùng thứ tự trong chiều này; đã ẩn đường nối để tránh vẽ sai. Quản trị viên cần sửa thứ tự.'
        : hasMissingOrders
          ? `Có điểm chiều này chưa được xếp thứ tự; đã ẩn đường nối để tránh vẽ thiếu. Quản trị viên cần nhập thứ tự cho tất cả điểm.`
        : routeStops.length > 1
        ? `Chiều ${selectedDirection === 'di' ? 'Đi A → B' : 'Về B → A'} · ${routeStops.length} điểm đã xếp thứ tự. Nét nối là sơ đồ, chưa bám sát đường phố.`
        : `Chưa đủ điểm có thứ tự cho tuyến ${selectedRoute} chiều ${selectedDirection === 'di' ? 'Đi' : 'Về'}. Quản trị viên cần cập nhật ít nhất 2 điểm.`;
      results.prepend(directionNote);
    } else if (selectedRoute) {
      const directionNote = document.createElement('div');
      directionNote.style.padding = '8px 10px';
      directionNote.style.color = '#64748B';
      directionNote.textContent = 'Chọn chiều Đi hoặc Về để xem thứ tự các điểm của tuyến.';
      results.prepend(directionNote);
    }

    summary.textContent = `${visible.length.toLocaleString('vi-VN')} điểm dừng${selectedRoute ? ` · tuyến ${selectedRoute}` : ''}${selectedDirection ? ` · chiều ${selectedDirection === 'di' ? 'Đi' : 'Về'}` : ''}`;
    if (visible.length > MAX_RESULT_ROWS) {
      const note = document.createElement('div');
      note.style.padding = '8px 10px';
      note.textContent = `Danh sách bên dưới hiển thị ${MAX_RESULT_ROWS} điểm đầu tiên. Hãy tìm theo tên hoặc mã để thu hẹp kết quả.`;
      results.append(note);
    }
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

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(render, 180);
  });
  route.addEventListener('change', () => {
    direction.disabled = !route.value;
    direction.value = '';
    render();
  });
  [district, direction, showWithdrawn].forEach(element => element.addEventListener('change', render));
  window.addEventListener('stops-map-visible', () => map.invalidateSize());
  loadStops();
})();
