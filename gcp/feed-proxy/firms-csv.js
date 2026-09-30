const MAX_FIRMS_ITEMS = 200;
const FIRMS_FIELDS = [
  'latitude', 'longitude', 'acq_date', 'acq_time',
  'bright_ti4', 'bright_ti5', 'frp', 'confidence'
];

export function parseFirmsTimestamp(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return null;
  const dateMs = Date.parse(match[1] + 'T00:00:00Z');
  if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== match[1]) return null;
  if (Number(match[2] || 0) > 23 || Number(match[3] || 0) > 59 || Number(match[4] || 0) > 59) return null;
  const parsed = Date.parse(value + (match[2] && !match[5] ? 'Z' : ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function nasaFirmsTimestamp(entry) {
  if (entry?.acq_date !== undefined) {
    const date = entry.acq_date;
    const time = String(entry.acq_time ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(time)) return null;
    const padded = time.padStart(4, '0');
    return parseFirmsTimestamp(date + 'T' + padded.slice(0, 2) + ':' + padded.slice(2) + ':00Z');
  }
  return parseFirmsTimestamp(entry?.publishedAt ?? entry?.date ?? entry?.timestamp ?? entry?.acquired);
}

export function nasaFirmsCoordinates(entry) {
  const numeric = (value) => typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
  const point = (lat, lon) => {
    lat = numeric(lat);
    lon = numeric(lon);
    return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180
      ? { lat, lon } : null;
  };
  return point(entry?.geo?.lat, entry?.geo?.lon)
    || point(entry?.latitude ?? entry?.lat ?? entry?.Latitude ?? entry?.lat_deg ?? entry?.latitude_deg,
      entry?.longitude ?? entry?.lon ?? entry?.Longitude ?? entry?.lon_deg ?? entry?.longitude_deg);
}

export function nasaFirmsObservationKey(entry) {
  return JSON.stringify([
    entry.source, entry.id || entry.docId || null, nasaFirmsCoordinates(entry),
    entry.publishedAt, entry.satellite || null, entry.instrument || null, entry.summary
  ]);
}

function selectionKey(item) {
  return (item.observationKey || nasaFirmsObservationKey(item)) + JSON.stringify([item.title || '', item.url || '']);
}

function createNewestSelection() {
  const retained = [];
  return {
    add(value, timestamp, key) {
      const candidate = { value, timestamp: timestamp ?? -Infinity, key };
      const compare = (left, right) => right.timestamp - left.timestamp
        || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      let low = 0;
      let high = retained.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(candidate, retained[middle]) < 0) high = middle;
        else low = middle + 1;
      }
      if (low >= MAX_FIRMS_ITEMS) return;
      retained.splice(low, 0, candidate);
      if (retained.length > MAX_FIRMS_ITEMS) retained.pop();
    },
    values() { return retained.map((entry) => entry.value); }
  };
}

export function selectNewestFirmsItems(items) {
  const selection = createNewestSelection();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    selection.add(item, nasaFirmsTimestamp(item), selectionKey(item));
  }
  return selection.values();
}

function normalizeNasaFirmsItem(entry, source = 'NASA FIRMS') {
  const geo = nasaFirmsCoordinates(entry);
  const publishedAt = nasaFirmsTimestamp(entry);
  if (!geo || publishedAt === null) return null;
  const brightness = entry.bright_ti4 ?? entry.brightness ?? entry.bright_ti5 ?? entry.bright;
  const frp = entry.frp ?? entry.fire_radiative_power;
  const confidence = entry.confidence ?? entry.conf ?? entry.confidence_level;
  const parts = [];
  if (brightness) parts.push('Brightness ' + brightness);
  if (frp) parts.push('FRP ' + frp);
  if (confidence) parts.push('Confidence ' + confidence);
  return {
    title: entry.title || 'Fire detection',
    summary: entry.summary || (parts.length ? parts.join(' | ') : 'Active fire detection'),
    latitude: geo.lat,
    longitude: geo.lon,
    publishedAt,
    source: entry.source || source,
    alertType: 'Fire'
  };
}

export function normalizeNasaFirmsItems(data, source = 'NASA FIRMS') {
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  const selection = createNewestSelection();
  for (const entry of rows) {
    const item = normalizeNasaFirmsItem(entry, source);
    if (item) selection.add(item, item.publishedAt, selectionKey(item));
  }
  return selection.values();
}

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
  const selection = createNewestSelection();
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
    const validRow = { ...row, latitude, longitude, acq_time: time };
    const item = normalizeNasaFirmsItem(validRow);
    selection.add(validRow, item.publishedAt, selectionKey(item) + JSON.stringify(FIRMS_FIELDS.map((name) => validRow[name])));
  }
  // Consume the whole payload so malformed trailing records cannot be hidden by the cap.
  return selection.values();
}
