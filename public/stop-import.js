(function exposeStopImport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StopImport = api;
})(globalThis, function createStopImport() {
  const ROUTE_FIELDS = new Set(['tuyenDiQua']);
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
    let duplicateCount = 0;

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

      duplicateCount++;
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

      for (const [field, value] of Object.entries(row)) {
        if (ROUTE_FIELDS.has(field)) {
          existing.tuyenDiQua = [...new Set([...routes(existing.tuyenDiQua), ...routes(value)])];
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

  return { mergeDuplicateStopRows };
});
