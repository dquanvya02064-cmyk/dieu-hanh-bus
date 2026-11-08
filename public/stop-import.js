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
    return '';
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

  return { mergeDuplicateStopRows, routeDirection };
});
