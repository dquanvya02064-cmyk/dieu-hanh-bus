(function exposeStopImport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StopImport = api;
})(globalThis, function createStopImport() {
  const HISTORY_FIELDS = new Set(['thuTu', 'thuHoi', 'ngayBatDau', 'ngayKetThuc', 'ghiChu', 'lichSuDiemDung']);
  const CONFLICT_FIELDS = ['maKhachHang', 'tenQuanHuyen', 'tenDuong', 'tenDiem', 'kinhDo', 'viDo'];

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function routes(value) {
    const values = Array.isArray(value) ? value : text(value).split(/[,;|\n]+/);
    return [...new Set(values.map(item => {
      const match = text(item).match(/^([a-z0-9]+)/i);
      return match ? match[1].toUpperCase() : '';
    }).filter(Boolean))];
  }

  function routeDirection(value) {
    const direction = text(value).toLocaleLowerCase('vi')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
      .replace(/[^a-z]/g, '');
    if (['di', 'chieudi', 'ab'].includes(direction)) return 'di';
    if (['ve', 'chieuve', 'ba'].includes(direction)) return 've';
    if (text(value) === '1') return 'di';
    if (text(value) === '2') return 've';
    return '';
  }

  function itineraryDirection(value) {
    const heading = text(value).toLocaleLowerCase('vi')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
      .replace(/[^a-z0-9]/g, '');
    if (heading.includes('chieudi') || heading.includes('outbound')) return 'di';
    if (heading.includes('chieuve') || heading.includes('return')) return 've';
    return '';
  }

  function normalizeStopName(value) {
    return text(value).toLocaleLowerCase('vi')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
      .replace(/[^a-z0-9]/g, '');
  }

  function itineraryRouteCode(sectionText, routeCodes) {
    const normalizedText = text(sectionText).toLocaleUpperCase('vi');
    const matchedRoute = routeCodes.find(code => {
      const escaped = text(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(normalizedText);
    });
    if (matchedRoute) return text(matchedRoute).toUpperCase();
    const match = normalizedText.match(/\bTUYEN\s+([A-Z0-9]+)\b/i);
    return match && !['DI', 'VE', 'QUA'].includes(match[1]) ? match[1] : '';
  }

  function parseRouteItinerarySheet(matrix, existingStops, knownRoutes) {
    const routeCodes = (Array.isArray(knownRoutes) ? knownRoutes : [])
      .map(code => text(code).toUpperCase()).filter(Boolean);
    let headerIndex = -1;
    let routeColumns = [];

    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
      const headers = (matrix[rowIndex] || []).map(value =>
        text(value).toLocaleLowerCase('vi')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
          .replace(/[^a-z0-9]/g, '')
      );
      const candidates = headers
        .map((header, index) => header === 'tuyendiqua' ? index : -1)
        .filter(index => index >= 0);
      if (candidates.length >= 2) {
        headerIndex = rowIndex;
        routeColumns = candidates;
        break;
      }
    }
    if (headerIndex < 0) return null;

    const header = matrix[headerIndex] || [];
    const sections = routeColumns.map((routeColumn, sectionIndex) => {
      const sectionStart = sectionIndex === 0 ? 0 : routeColumns[sectionIndex - 1] + 1;
      let nameColumn = -1;
      for (let column = routeColumn - 1; column >= sectionStart; column--) {
        if (text(header[column])) {
          nameColumn = column;
          break;
        }
      }
      if (nameColumn < 0) return { routeColumn, nameColumn, direction: '', route: '' };

      const parentTexts = [];
      for (let rowIndex = headerIndex - 1; rowIndex >= 0; rowIndex--) {
        const row = matrix[rowIndex] || [];
        for (let column = nameColumn; column >= 0; column--) {
          if (text(row[column])) {
            parentTexts.push(text(row[column]));
            break;
          }
        }
      }
      const direction = parentTexts.map(itineraryDirection).find(Boolean) || '';
      const sectionTexts = [
        ...parentTexts,
        ...header.slice(sectionStart, routeColumn).map(text)
      ].join(' ');
      return {
        routeColumn,
        nameColumn,
        direction,
        route: itineraryRouteCode(sectionTexts, routeCodes)
      };
    });
    if (sections.some(section => !section.direction)) return null;

    const stopsByName = new Map();
    (Array.isArray(existingStops) ? existingStops : []).forEach(stop => {
      const key = normalizeStopName(stop.tenDiem);
      if (!key) return;
      const matches = stopsByName.get(key) || [];
      matches.push(stop);
      stopsByName.set(key, matches);
    });

    const recordsById = new Map();
    const errors = [];
    let sourceCount = 0;
    const assignedCounts = { di: 0, ve: 0 };
    const seenStops = new Set();
    sections.forEach(section => {
      if (!section.route || !routeCodes.includes(section.route)) {
        errors.push(`Không xác định được mã tuyến trong tiêu đề chiều ${section.direction === 'di' ? 'Đi' : 'Về'}.`);
        return;
      }
      let order = 0;
      for (let rowIndex = headerIndex + 1; rowIndex < matrix.length; rowIndex++) {
        const row = matrix[rowIndex] || [];
        const stopName = text(row[section.nameColumn]);
        if (!stopName) continue;
        sourceCount++;
        order++;
        const line = rowIndex + 1;
        const matches = stopsByName.get(normalizeStopName(stopName)) || [];
        if (!matches.length) {
          errors.push(`Dòng ${line}: không tìm thấy điểm “${stopName}” trong dữ liệu hiện có.`);
          continue;
        }
        if (matches.length > 1) {
          errors.push(`Dòng ${line}: tên điểm “${stopName}” khớp nhiều điểm; cần đổi tên trong file.`);
          continue;
        }
        const stop = matches[0];
        const duplicateKey = `${section.route}:${section.direction}:${stop.id || stop.maDiem}`;
        if (seenStops.has(duplicateKey)) {
          errors.push(`Dòng ${line}: điểm “${stopName}” xuất hiện lặp trong cùng một chiều.`);
          continue;
        }
        seenStops.add(duplicateKey);

        const id = text(stop.id) || text(stop.maDiem);
        const record = recordsById.get(id) || {
          ...stop,
          tuyenDiQua: routes(stop.tuyenDiQua),
          tuyenTheoChieu: Array.isArray(stop.tuyenTheoChieu)
            ? stop.tuyenTheoChieu.map(item => ({ ...item }))
            : []
        };
        record.tuyenDiQua = [...new Set([...record.tuyenDiQua, section.route])];
        record.tuyenTheoChieu = record.tuyenTheoChieu.filter(item =>
          text(item.maTuyen).toUpperCase() !== section.route || routeDirection(item.chieu) !== section.direction
        );
        record.tuyenTheoChieu.push({ maTuyen: section.route, chieu: section.direction, thuTu: order });
        recordsById.set(id, record);
        assignedCounts[section.direction]++;
      }
    });

    const rows = [...recordsById.values()];
    const warnings = rows.length
      ? [`Đã gán ${assignedCounts.di} điểm chiều Đi và ${assignedCounts.ve} điểm chiều Về. Chỉ cập nhật các điểm có tên khớp duy nhất với dữ liệu hiện có.`]
      : [];
    return { rows, errors, sourceCount, warnings };
  }

  function isWithdrawn(value) {
    if (typeof value === 'boolean') return value;
    return ['x', '1', 'true', 'yes', 'y', 'co', 'có', 'thu hồi']
      .includes(text(value).toLocaleLowerCase('vi'));
  }

  function comparable(field, value) {
    const normalized = text(value).replace(/\s+/g, ' ').toLocaleLowerCase('vi');
    if (field === 'kinhDo' || field === 'viDo') {
      const numeric = Number(normalized.replace(',', '.'));
      return Number.isFinite(numeric) ? String(Math.round(numeric * 100000) / 100000) : normalized;
    }
    return normalized;
  }

  function historyRows(row) {
    const history = Array.isArray(row.lichSuDiemDung) ? [...row.lichSuDiemDung] : [];
    const current = {
      ngayBatDau: text(row.ngayBatDau),
      ngayKetThuc: text(row.ngayKetThuc),
      ghiChu: text(row.ghiChu)
    };
    if (Object.values(current).some(Boolean) && !history.some(entry =>
      text(entry.ngayBatDau) === current.ngayBatDau &&
      text(entry.ngayKetThuc) === current.ngayKetThuc &&
      text(entry.ghiChu) === current.ghiChu
    )) history.push(current);
    return history;
  }

  function mergeDuplicateStopRows(inputRows) {
    const rowsByCode = new Map();
    const conflictsByCode = new Map();
    const duplicateCountsByCode = new Map();
    const rowsWithoutCode = [];

    inputRows.forEach(row => {
      const code = text(row.maDiem);
      const normalizedCode = code.toLocaleUpperCase('vi');
      if (!normalizedCode) {
        rowsWithoutCode.push(row);
        return;
      }
      const existing = rowsByCode.get(normalizedCode);
      if (!existing) {
        rowsByCode.set(normalizedCode, {
          ...row,
          tuyenDiQua: routes(row.tuyenDiQua),
          lichSuDiemDung: historyRows(row)
        });
        return;
      }

      duplicateCountsByCode.set(normalizedCode, (duplicateCountsByCode.get(normalizedCode) || 0) + 1);
      for (const field of CONFLICT_FIELDS) {
        const previous = comparable(field, existing[field]);
        const incoming = comparable(field, row[field]);
        if (previous && incoming && previous !== incoming) {
          if (!conflictsByCode.has(normalizedCode)) {
            conflictsByCode.set(normalizedCode, { maDiem: code, fields: new Set() });
          }
          conflictsByCode.get(normalizedCode).fields.add(field);
        }
      }
      const currentDirections = Array.isArray(existing.tuyenTheoChieu) ? existing.tuyenTheoChieu : [];
      (Array.isArray(row.tuyenTheoChieu) ? row.tuyenTheoChieu : []).forEach(direction => {
        const previousIndex = currentDirections.findIndex(item =>
          text(item.maTuyen).toLocaleUpperCase('vi') === text(direction.maTuyen).toLocaleUpperCase('vi') &&
          routeDirection(item.chieu) === routeDirection(direction.chieu)
        );
        if (previousIndex < 0) return;
        const previous = currentDirections[previousIndex];
        const previousOrder = previous.thuTu == null || text(previous.thuTu) === '' ? null : Number(previous.thuTu);
        const incomingOrder = direction.thuTu == null || text(direction.thuTu) === '' ? null : Number(direction.thuTu);
        if (previousOrder !== null && incomingOrder !== null && previousOrder !== incomingOrder) {
          if (!conflictsByCode.has(normalizedCode)) {
            conflictsByCode.set(normalizedCode, { maDiem: code, fields: new Set() });
          }
          conflictsByCode.get(normalizedCode).fields.add('tuyenTheoChieu');
        }
        if (previousOrder === null && incomingOrder !== null) {
          currentDirections[previousIndex] = { ...previous, thuTu: incomingOrder };
        }
      });

      for (const [field, value] of Object.entries(row)) {
        if (field === 'tuyenDiQua') {
          existing.tuyenDiQua = [...new Set([...routes(existing.tuyenDiQua), ...routes(value)])];
        } else if (field === 'tuyenTheoChieu') {
          const currentDirections = Array.isArray(existing.tuyenTheoChieu) ? existing.tuyenTheoChieu : [];
          const incomingDirections = Array.isArray(value) ? value : [];
          const byDirection = new Map(currentDirections.map(item => [
            `${text(item.maTuyen).toLocaleUpperCase('vi')}:${routeDirection(item.chieu)}`,
            item
          ]));
          incomingDirections.forEach(item => {
            const key = `${text(item.maTuyen).toLocaleUpperCase('vi')}:${routeDirection(item.chieu)}`;
            if (!byDirection.has(key)) byDirection.set(key, item);
          });
          existing.tuyenTheoChieu = [...byDirection.values()];
        } else if (HISTORY_FIELDS.has(field)) {
          if (field === 'thuHoi') existing.thuHoi = isWithdrawn(existing.thuHoi) || isWithdrawn(value);
          else if (field === 'thuTu' && !text(existing.thuTu)) existing.thuTu = text(value);
        } else if (!text(existing[field]) && text(value)) {
          existing[field] = value;
        }
      }
      existing.lichSuDiemDung = [
        ...(existing.lichSuDiemDung || []),
        ...historyRows(row)
      ];
    });

    return {
      rows: [
        ...[...rowsByCode].filter(([code]) => !conflictsByCode.has(code)).map(([, row]) => row),
        ...rowsWithoutCode
      ],
      duplicateCount: [...duplicateCountsByCode]
        .filter(([code]) => !conflictsByCode.has(code))
        .reduce((count, [, duplicates]) => count + duplicates, 0),
      conflicts: [...conflictsByCode.values()].map(({ maDiem, fields }) => ({ maDiem, fields: [...fields] }))
    };
  }

  return { mergeDuplicateStopRows, parseRouteItinerarySheet, routeDirection };
});
