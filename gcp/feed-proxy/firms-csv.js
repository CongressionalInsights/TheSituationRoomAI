const MAX_FIRMS_ITEMS = 200;
const FIRMS_FIELDS = [
  'latitude', 'longitude', 'acq_date', 'acq_time',
  'bright_ti4', 'bright_ti5', 'frp', 'confidence'
];

function* parseCsvRecords(text) {
  let cells = [];
  let value = '';
  let state = 'start';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          state = 'closed';
        }
      } else {
        value += char;
      }
      continue;
    }
    if (char === ',' || char === '\n' || char === '\r') {
      cells.push(value);
      value = '';
      state = 'start';
      if (char !== ',') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        yield cells;
        cells = [];
      }
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
    } else if (char === '"' || state === 'closed') {
      throw new Error('invalid_firms_csv_record');
    } else {
      value += char;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('invalid_firms_csv_record');
  if (cells.length || state !== 'start') yield [...cells, value];
}

export function parseNasaFirmsRows(body, contentType = '') {
  if (String(contentType).toLowerCase().includes('json')) return JSON.parse(body);

  const records = parseCsvRecords(String(body || '').replace(/^\uFEFF/, ''));
  const header = records.next().value;
  const names = header?.map((name) => name.trim().toLowerCase()) || [];
  if (!['latitude', 'longitude', 'acq_date', 'acq_time'].every((name) => names.includes(name))
    || names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('invalid_firms_csv_header');
  }
  const indexes = Object.fromEntries(FIRMS_FIELDS.map((name) => [name, names.indexOf(name)]));
  const rows = [];
  for (const cells of records) {
    if (cells.length === 1 && !cells[0].trim()) continue;
    if (cells.length !== names.length) throw new Error('invalid_firms_csv_record');
    const row = Object.fromEntries(FIRMS_FIELDS.map((name) => [
      name, indexes[name] < 0 ? '' : cells[indexes[name]].trim()
    ]));
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(row.latitude)
      || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(row.longitude)) continue;
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.acq_date)) continue;
    const dateMs = Date.parse(row.acq_date + 'T00:00:00Z');
    if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== row.acq_date) continue;
    if (!/^\d{1,4}$/.test(row.acq_time)) continue;
    const time = row.acq_time.padStart(4, '0');
    if (Number(time.slice(0, 2)) > 23 || Number(time.slice(2)) > 59) continue;
    rows.push({ ...row, latitude, longitude, acq_time: time });
    if (rows.length === MAX_FIRMS_ITEMS) break;
  }
  return rows;
}
