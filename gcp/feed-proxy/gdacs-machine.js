export const sourceUrl = 'https://www.gdacs.org/gdacsapi/api/Events/geteventlist/events4app';
const maxItems = 100;
const maxBytes = 512 * 1024;
export const gdacsMachineMime = 'application/vnd.tsr.gdacs-updates+json';
export const gdacsMachineFallback = 'gdacs-recent-events-api';
const freshnessMs = 90 * 60_000;

// Schema validation is intentionally strict. A future provider shape change fails back to cache.
function text(value, max) {
  return typeof value === 'string' && value.length <= max && value.trim() && !/[<>\u0000-\u001f]/u.test(value)
    ? value.trim() : null;
}

function providerTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) return null;
  const ms = Date.parse(value + 'Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value ? ms : null;
}

function reportLink(value, eventType, eventId, episodeId) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.gdacs.org' || url.pathname !== '/report.aspx'
      || url.username || url.password || url.hash) return null;
    const clean = new URL('/report.aspx', url.origin);
    for (const [key, expected] of Object.entries({ eventtype: eventType, eventid: eventId, episodeid: episodeId })) {
      const actual = url.searchParams.getAll(key);
      if (actual.length !== 1 || actual[0] !== String(expected)) return null;
      clean.searchParams.set(key, actual[0]);
    }
    return clean.toString();
  } catch {
    return null;
  }
}

export function normalizeGdacsMachine(value, now) {
  if (!Number.isFinite(now) || value?.type !== 'FeatureCollection' || !Array.isArray(value.features)
    || !value.features.length || value.features.length > maxItems) return null;
  const seen = new Set();
  const items = [];
  for (const feature of value.features) {
    if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Point') return null;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2) return null;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const p = feature.properties;
    if (!p || !Number.isSafeInteger(p.eventid) || p.eventid < 1
      || !Number.isSafeInteger(p.episodeid) || p.episodeid < 1 || !/^[A-Z]{2,4}$/.test(p.eventtype ?? '')) return null;
    const key = `${p.eventtype}:${p.eventid}:${p.episodeid}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const title = text(p.eventname, 400) || text(p.name, 400);
    const severity = text(p.alertlevel, 32);
    const source = text(p.source, 100);
    const url = reportLink(p.url?.report, p.eventtype, p.eventid, p.episodeid);
    const updatedAt = providerTime(p.datemodified);
    const startsAt = providerTime(p.fromdate);
    const endsAt = providerTime(p.todate);
    if (!title || !severity || !source || !url || updatedAt === null || updatedAt > now
      || startsAt === null || endsAt === null || endsAt < startsAt) return null;
    items.push({ id: key, title, url, severity, eventType: p.eventtype, source: 'GDACS',
      providerSource: source, geo: { lat, lon }, startsAt, endsAt, updatedAt, publishedAt: null });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const newestUpdateAt = items[0].updatedAt;
  return {
    sourceUrl, fallback: gdacsMachineFallback, coverage: { product: 'events4app', recentDays: 4, itemLimit: maxItems, truncatedOrAtLimit: items.length === maxItems },
    timeSemantics: 'updated', newestUpdateAt, items
  };
}

export async function readGdacsMachine({ fetchImpl = fetch, now = Date.now, timeoutMs = 20_000 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return null;
  try {
    const response = await fetchImpl(sourceUrl, {
      method: 'GET', headers: { Accept: 'application/geo+json, application/json' },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(Math.min(20_000, Math.floor(timeoutMs)))
    });
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || !['application/json', 'application/geo+json'].includes(mime) || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) return null;
      chunks.push(chunk);
    }
    const observedAt = now();
    const normalized = normalizeGdacsMachine(JSON.parse(Buffer.concat(chunks).toString('utf8')), observedAt);
    return normalized && observedAt - normalized.newestUpdateAt <= freshnessMs ? normalized : null;
  } catch {
    return null;
  }
}

// JSON carried in the existing body field. The marker is also checked at each consumer.
export function parseGdacsMachineBody(body) {
  if (typeof body !== 'string' || body.length > maxBytes) return null;
  try {
    const value = JSON.parse(body);
    if (value?.sourceUrl !== sourceUrl || value.fallback !== gdacsMachineFallback
      || value.timeSemantics !== 'updated' || value.coverage?.product !== 'events4app'
      || value.coverage.recentDays !== 4 || value.coverage.itemLimit !== 100
      || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > maxItems) return null;
    const ids = new Set();
    const items = [];
    for (const row of value.items) {
      const [type, event, episode] = typeof row?.id === 'string' ? row.id.split(':') : [];
      if (!/^[A-Z]{2,4}$/.test(type || '') || !/^[1-9][0-9]*$/.test(event || '')
        || !/^[1-9][0-9]*$/.test(episode || '') || row.id !== [type, event, episode].join(':') || row.eventType !== type || ids.has(row.id)
        || !text(row.title,400) || !text(row.severity,32) || !text(row.providerSource,100) || row.source !== 'GDACS'
        || !reportLink(row.url,type,event,episode) || row.publishedAt !== null
        || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0
        || !Number.isFinite(row.startsAt) || !Number.isFinite(row.endsAt) || row.endsAt < row.startsAt
        || !Number.isFinite(row.geo?.lat) || !Number.isFinite(row.geo?.lon)
        || Math.abs(row.geo.lat) > 90 || Math.abs(row.geo.lon) > 180) return null;
      ids.add(row.id);
      items.push({ id: row.id, title: row.title, url: reportLink(row.url, type, event, episode), severity: row.severity,
        eventType: type, source: 'GDACS', providerSource: row.providerSource, geo: { lat: row.geo.lat, lon: row.geo.lon },
        startsAt: row.startsAt, endsAt: row.endsAt, updatedAt: row.updatedAt, publishedAt: null });
    }
    if (value.newestUpdateAt !== Math.max(...value.items.map(row => row.updatedAt))) return null;
    return { sourceUrl, fallback: gdacsMachineFallback,
      coverage: { product: 'events4app', recentDays: 4, itemLimit: maxItems, truncatedOrAtLimit: items.length === maxItems },
      timeSemantics: 'updated', newestUpdateAt: value.newestUpdateAt, items };
  } catch { return null; }
}

export async function fetchGdacsMachinePayload(options) {
  const value = await readGdacsMachine(options);
  if (!value) return null;
  return {
    id: 'gdacs-alerts', httpStatus: 200, fetchedAt: Date.now(), contentType: gdacsMachineMime,
    body: JSON.stringify(value), fallback: gdacsMachineFallback, fallbackUsed: true, stale: true,
    sourceUrl, fetchedUrl: sourceUrl, proxyUsed: null
  };
}
