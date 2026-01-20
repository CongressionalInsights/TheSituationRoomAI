import http from 'http';
import AdmZip from 'adm-zip';

const PORT = process.env.PORT || 8080;
const ACLED_NAME = process.env.ACLED_NAME;
const ACLED_PASS = process.env.ACLED_PASS;
const DEFAULT_LOOKBACK_DAYS = Number(process.env.ACLED_LOOKBACK_DAYS || 30);
const AGGREGATED_LIST_URL = 'https://acleddata.com/conflict-data/download-data-files/aggregated-data';
const AGGREGATED_CACHE_TTL = Number(process.env.ACLED_AGG_TTL_MS || 6 * 60 * 60 * 1000);
const AGGREGATED_REGIONS = {
  global: ['africa', 'asia-pacific', 'europe-central-asia', 'latin-america-caribbean', 'middle-east-north-africa', 'us-canada'],
  africa: ['africa'],
  'asia-pacific': ['asia-pacific'],
  'europe-central-asia': ['europe-central-asia'],
  'latin-america-caribbean': ['latin-america-caribbean'],
  'middle-east-north-africa': ['middle-east-north-africa'],
  'us-canada': ['us-canada']
};
const TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_ENDPOINT = 'https://acleddata.com/api/acled/read';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://congressionalinsights.github.io,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;
const aggregatedCache = new Map();

function setCors(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin', allowed || ALLOWED_ORIGINS[0] || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload, origin) {
  setCors(res, origin);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function formatIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function normalizeHeader(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(current);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length || row.length) {
    row.push(current);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}

function parseCsvObjects(text) {
  const rows = parseCsvRows(String(text || '').trim());
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((row) => {
    const entry = {};
    headers.forEach((header, idx) => {
      entry[header] = row[idx] ?? '';
    });
    return entry;
  });
}

function extractCsvLinks(html) {
  const links = [];
  const regex = new RegExp('<a[^>]+href="([^"]+\\.(?:csv|zip))"[^>]*>(.*?)</a>', 'gi');
  let match;
  while ((match = regex.exec(html))) {
    links.push({
      url: match[1],
      label: match[2] ? match[2].replace(/<[^>]*>/g, '').trim() : ''
    });
  }
  return links;
}

function absolutizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `https://acleddata.com${url.startsWith('/') ? '' : '/'}${url}`;
}

function pickLinksForRegion(links, regionKey) {
  if (!links.length) return [];
  const keywordsMap = {
    africa: ['africa'],
    'asia-pacific': ['asia', 'pacific'],
    'europe-central-asia': ['europe', 'central', 'asia', 'eurasia'],
    'latin-america-caribbean': ['latin', 'america', 'caribbean'],
    'middle-east-north-africa': ['middle', 'east', 'north', 'africa', 'mena'],
    'us-canada': ['united states', 'united-states', 'u.s.', 'us', 'canada', 'north america']
  };
  const keywords = keywordsMap[regionKey] || [];
  if (!keywords.length) return links;
  return links.filter((link) => {
    const haystack = `${link.url} ${link.label}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function getCookieHeader(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  }
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return '';
  const parts = setCookie.split(/,(?=[^;]+?=)/g);
  return parts.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function getSessionCookie() {
  if (!ACLED_NAME || !ACLED_PASS) {
    throw new Error('missing_acled_credentials');
  }
  const response = await fetch('https://acleddata.com/user/login?_format=json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ name: ACLED_NAME, pass: ACLED_PASS })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `login_error_${response.status}`);
  }
  const cookieHeader = getCookieHeader(response);
  if (!cookieHeader) {
    throw new Error('missing_session_cookie');
  }
  return cookieHeader;
}

async function fetchAggregatedLinks(cookieHeader) {
  const response = await fetch(AGGREGATED_LIST_URL, {
    headers: { Cookie: cookieHeader, 'Accept': 'text/html' }
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`aggregated_list_error_${response.status}`);
  }
  return extractCsvLinks(html).map((link) => ({
    ...link,
    url: absolutizeUrl(link.url)
  }));
}

async function downloadAggregatedCsv(url, cookieHeader) {
  const response = await fetch(url, {
    headers: { Cookie: cookieHeader, 'Accept': 'text/csv,application/zip,application/octet-stream,*/*' }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `download_error_${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  const isZip = url.toLowerCase().endsWith('.zip') || contentType.includes('zip');
  if (!isZip) {
    return response.text();
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((entry) => entry.entryName.toLowerCase().endsWith('.csv'));
  if (!entries.length) {
    throw new Error('zip_missing_csv');
  }
  return entries[0].getData().toString('utf8');
}

function detectDateField(entry) {
  const candidates = ['event_date', 'week', 'week_start', 'week_end', 'date'];
  return candidates.find((field) => Object.prototype.hasOwnProperty.call(entry, field)) || '';
}

function filterAggregatedRows(rows, { start, end, country, limit }) {
  if (!rows.length) return [];
  const dateField = detectDateField(rows[0]);
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;
  const filtered = rows.filter((row) => {
    if (country && row.country && String(row.country).toLowerCase() !== String(country).toLowerCase()) {
      return false;
    }
    if (!dateField || (!startDate && !endDate)) return true;
    const raw = row[dateField];
    if (!raw) return true;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return true;
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  });
  if (!limit) return filtered;
  return filtered.slice(0, limit);
}

async function getAggregatedData({ region = 'global', start, end, country, limit }) {
  const cacheKey = `${region}:${start || ''}:${end || ''}:${country || ''}:${limit || ''}`;
  const cached = aggregatedCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AGGREGATED_CACHE_TTL) {
    return cached.payload;
  }
  const cookieHeader = await getSessionCookie();
  const links = await fetchAggregatedLinks(cookieHeader);
  const regionKeys = AGGREGATED_REGIONS[region] || AGGREGATED_REGIONS.global;
  const selectedLinks = regionKeys.flatMap((key) => pickLinksForRegion(links, key));
  const uniqueLinks = Array.from(new Map(selectedLinks.map((link) => [link.url, link])).values());
  if (!uniqueLinks.length) {
    throw new Error('aggregated_links_missing');
  }
  const rows = [];
  for (const link of uniqueLinks) {
    // eslint-disable-next-line no-await-in-loop
    const csvText = await downloadAggregatedCsv(link.url, cookieHeader);
    rows.push(...parseCsvObjects(csvText));
  }
  const filtered = filterAggregatedRows(rows, { start, end, country, limit });
  const payload = { data: filtered, count: filtered.length, source: 'acled', region };
  aggregatedCache.set(cacheKey, { fetchedAt: Date.now(), payload });
  return payload;
}

async function requestToken(params) {
  const body = new URLSearchParams(params);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `token_error_${response.status}`);
  }
  return response.json();
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  if (refreshToken) {
    try {
      const refreshed = await requestToken({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        client_id: 'acled'
      });
      accessToken = refreshed.access_token || null;
      refreshToken = refreshed.refresh_token || refreshToken;
      const ttl = Number(refreshed.expires_in) || 86400;
      tokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
      if (accessToken) return accessToken;
    } catch (err) {
      // fall through to password grant
    }
  }
  if (!ACLED_NAME || !ACLED_PASS) {
    throw new Error('missing_acled_credentials');
  }
  const token = await requestToken({
    username: ACLED_NAME,
    password: ACLED_PASS,
    grant_type: 'password',
    client_id: 'acled'
  });
  accessToken = token.access_token || null;
  refreshToken = token.refresh_token || null;
  const ttl = Number(token.expires_in) || 86400;
  tokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
  if (!accessToken) throw new Error('missing_access_token');
  return accessToken;
}

function buildAcledUrl(params) {
  const query = new URLSearchParams();
  query.set('_format', 'json');
  if (params.limit) query.set('limit', params.limit);
  if (params.page) query.set('page', params.page);
  if (params.country) query.set('country', params.country);
  if (params.event_date) query.set('event_date', params.event_date);
  if (params.event_date_where) query.set('event_date_where', params.event_date_where);
  if (params.fields) query.set('fields', params.fields);
  return `${ACLED_ENDPOINT}?${query.toString()}`;
}

async function handleEvents(req, res) {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const country = url.searchParams.get('country');
  const limit = url.searchParams.get('limit') || '500';
  const page = url.searchParams.get('page');

  const event_date = start && end ? `${start}|${end}` : (start || end || '');
  const event_date_where = start && end ? 'BETWEEN' : '';
  const fields = url.searchParams.get('fields') || [
    'event_id_cnty',
    'event_date',
    'disorder_type',
    'event_type',
    'sub_event_type',
    'actor1',
    'actor2',
    'fatalities',
    'latitude',
    'longitude',
    'country',
    'admin1',
    'admin2',
    'location',
    'notes',
    'source'
  ].join('|');

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    return sendJson(res, 401, { error: 'auth_error', message: err.message }, origin);
  }

  const apiUrl = buildAcledUrl({
    limit,
    page,
    country: country || '',
    event_date: event_date || '',
    event_date_where,
    fields
  });

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      return sendJson(res, response.status, { error: 'acled_error', message: text || 'ACLED request failed.' }, origin);
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      return sendJson(res, 500, { error: 'parse_error', message: 'Invalid ACLED response.' }, origin);
    }
    if (payload?.count === 0 && Array.isArray(payload?.data) && payload.data.length === 0) {
      const recency = payload?.data_query_restrictions?.date_recency?.date;
      if (recency && (!event_date || !event_date.includes(recency))) {
        const recencyEnd = new Date(recency);
        if (!Number.isNaN(recencyEnd.getTime())) {
          const recencyStart = new Date(recencyEnd);
          recencyStart.setDate(recencyEnd.getDate() - DEFAULT_LOOKBACK_DAYS);
          const fallbackEventDate = `${formatIsoDate(recencyStart)}|${formatIsoDate(recencyEnd)}`;
          const fallbackUrl = buildAcledUrl({
            limit,
            page,
            country: country || '',
            event_date: fallbackEventDate,
            fields
          });
          if (fallbackUrl && fallbackUrl !== apiUrl) {
            const fallbackResponse = await fetch(fallbackUrl, {
              headers: { Authorization: `Bearer ${token}` }
            });
            const fallbackText = await fallbackResponse.text();
            if (fallbackResponse.ok) {
              try {
                const fallbackPayload = JSON.parse(fallbackText);
                fallbackPayload.acled_lag_date = recency;
                return sendJson(res, 200, fallbackPayload, origin);
              } catch (err) {
                // ignore parse errors and return original payload
              }
            }
          }
        }
      }
    }
    return sendJson(res, 200, payload, origin);
  } catch (err) {
    return sendJson(res, 500, { error: 'proxy_error', message: err.message || 'Proxy error' }, origin);
  }
}

function weekStartSaturday(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getUTCDay(); // 0=Sun, 6=Sat
  const diff = (day + 1) % 7;
  date.setUTCDate(date.getUTCDate() - diff);
  return formatIsoDate(date);
}

function parseIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function shiftIsoDate(value, days) {
  const date = parseIsoDate(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

function daysBetween(start, end) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  if (!startDate || !endDate) return 0;
  const diffMs = endDate.getTime() - startDate.getTime();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

async function probeEventRange({ start, end, country }) {
  const fields = 'event_date';
  const event_date = start && end ? `${start}|${end}` : (start || end || '');
  const event_date_where = start && end ? 'BETWEEN' : '';
  const token = await getAccessToken();
  const apiUrl = buildAcledUrl({
    limit: 1,
    page: 1,
    country: country || '',
    event_date,
    event_date_where,
    fields
  });
  const response = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `acled_error_${response.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('acled_parse_error');
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.length > 0;
}

async function fetchEventRows({ start, end, country, limit }) {
  const fields = [
    'event_date',
    'disorder_type',
    'event_type',
    'sub_event_type',
    'fatalities',
    'latitude',
    'longitude',
    'country',
    'admin1',
    'admin2',
    'location'
  ].join('|');
  const event_date = start && end ? `${start}|${end}` : (start || end || '');
  const event_date_where = start && end ? 'BETWEEN' : '';
  const token = await getAccessToken();
  const pageLimit = Math.max(1, Number(limit) || 5000);
  const rows = [];
  let page = 1;
  const maxPages = 6;
  while (page <= maxPages) {
    const apiUrl = buildAcledUrl({
      limit: pageLimit,
      page,
      country: country || '',
      event_date,
      event_date_where,
      fields
    });
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `acled_error_${response.status}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error('acled_parse_error');
    }
    const data = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...data);
    if (data.length < pageLimit) break;
    page += 1;
  }
  return rows;
}

function aggregateEvents(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const week = weekStartSaturday(row.event_date || row.event_date || '');
    if (!week) return;
    const country = row.country || '';
    const admin1 = row.admin1 || '';
    const disorder = row.disorder_type || '';
    const eventType = row.event_type || '';
    const subEvent = row.sub_event_type || '';
    const key = `${week}|${country}|${admin1}|${disorder}|${eventType}|${subEvent}`;
    const entry = grouped.get(key) || {
      week,
      country,
      admin1,
      disorder_type: disorder,
      event_type: eventType,
      sub_event_type: subEvent,
      event_count: 0,
      fatalities: 0,
      lat_sum: 0,
      lon_sum: 0,
      geo_count: 0
    };
    entry.event_count += 1;
    const fatalities = Number(row.fatalities || 0);
    if (Number.isFinite(fatalities)) entry.fatalities += fatalities;
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      entry.lat_sum += lat;
      entry.lon_sum += lon;
      entry.geo_count += 1;
    }
    grouped.set(key, entry);
  });
  return Array.from(grouped.values()).map((entry) => ({
    week: entry.week,
    country: entry.country,
    admin1: entry.admin1,
    disorder_type: entry.disorder_type,
    event_type: entry.event_type,
    sub_event_type: entry.sub_event_type,
    event_count: entry.event_count,
    fatalities: entry.fatalities,
    centroid_latitude: entry.geo_count ? entry.lat_sum / entry.geo_count : '',
    centroid_longitude: entry.geo_count ? entry.lon_sum / entry.geo_count : ''
  }));
}

async function handleAggregated(req, res) {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');
  const region = url.searchParams.get('region') || 'global';
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';
  const country = url.searchParams.get('country') || '';
  const limit = Number(url.searchParams.get('limit') || 2000);
  try {
    const cacheKey = `${region}:${start || ''}:${end || ''}:${country || ''}:${limit || ''}`;
    const cached = aggregatedCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < AGGREGATED_CACHE_TTL) {
      return sendJson(res, 200, cached.payload, origin);
    }
    let effectiveStart = start;
    let effectiveEnd = end;
    let rows = [];
    if (start && end) {
      const windowDays = Math.max(1, daysBetween(start, end));
      let probeStart = start;
      let probeEnd = end;
      let found = false;
      for (let i = 0; i < 24; i += 1) {
        const hasEvents = await probeEventRange({ start: probeStart, end: probeEnd, country });
        if (hasEvents) {
          found = true;
          effectiveStart = probeStart;
          effectiveEnd = probeEnd;
          break;
        }
        probeStart = shiftIsoDate(probeStart, -windowDays);
        probeEnd = shiftIsoDate(probeEnd, -windowDays);
        if (!probeStart || !probeEnd) break;
      }
      if (found) {
        rows = await fetchEventRows({ start: effectiveStart, end: effectiveEnd, country, limit: 5000 });
      }
    } else {
      rows = await fetchEventRows({ start, end, country, limit: 5000 });
    }
    if (!rows.length && start && end) {
      const fallbackStart = shiftIsoDate(start, -365);
      const fallbackEnd = shiftIsoDate(end, -365);
      if (fallbackStart && fallbackEnd) {
        rows = await fetchEventRows({ start: fallbackStart, end: fallbackEnd, country, limit: 5000 });
        effectiveStart = fallbackStart;
        effectiveEnd = fallbackEnd;
      }
    }
    const aggregated = aggregateEvents(rows);
    const payload = {
      data: aggregated.slice(0, limit),
      count: aggregated.length,
      source: 'acled',
      region,
      range_start: effectiveStart || start || '',
      range_end: effectiveEnd || end || ''
    };
    aggregatedCache.set(cacheKey, { fetchedAt: Date.now(), payload });
    return sendJson(res, 200, payload, origin);
  } catch (err) {
    return sendJson(res, 502, { error: 'aggregated_error', message: err.message || 'Aggregated fetch failed.' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true }, origin);
  }

  if (req.url?.startsWith('/api/acled/events')) {
    return handleEvents(req, res);
  }
  if (req.url?.startsWith('/api/acled/aggregated')) {
    return handleAggregated(req, res);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

server.listen(PORT, () => {
  console.log(`ACLED proxy listening on ${PORT}`);
});
