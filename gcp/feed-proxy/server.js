import http from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 8080;
const FEEDS_PATH = join(__dirname, 'feeds.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://congressionalinsights.github.io,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const ACLED_PROXY = process.env.ACLED_PROXY || '';
const DEFAULT_LOOKBACK_DAYS = Number(process.env.ACLED_LOOKBACK_DAYS || 30);

const feedsConfig = JSON.parse(readFileSync(FEEDS_PATH, 'utf8'));
const appConfig = feedsConfig.app || { defaultRefreshMinutes: 60, userAgent: 'TheSituationRoom/0.1' };
const cache = new Map();
const FETCH_TIMEOUT_MS = feedsConfig.app?.fetchTimeoutMs || 12000;
const GPSJAM_ID = 'gpsjam';
const GPSJAM_CACHE_KEY = 'gpsjam:data';
const EIA_RETRY_ATTEMPTS = 5;
const EIA_RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setCors(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin', allowed || ALLOWED_ORIGINS[0] || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-openai-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, payload, origin) {
  setCors(res, origin);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function resolveServerKey(feed) {
  if (feed.keySource !== 'server') return null;
  if (feed.keyGroup === 'api.data.gov') return process.env.DATA_GOV;
  if (feed.keyGroup === 'eia') return process.env.EIA;
  if (feed.keyGroup === 'earthdata') return process.env.EARTHDATA_NASA;
  if (feed.id === 'openaq-api') return process.env.OPEN_AQ;
  if (feed.id === 'nasa-firms') return process.env.NASA_FIRMS;
  return null;
}

function formatIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function getAcledWindow() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - DEFAULT_LOOKBACK_DAYS);
  return { start: formatIsoDate(start), end: formatIsoDate(end) };
}

function buildGdeltConflictUrl(feed) {
  const { start, end } = getAcledWindow();
  const timespan = `${DEFAULT_LOOKBACK_DAYS}d`;
  const query = feed.defaultQuery || '';
  let url = feed.url || '';
  url = url.replaceAll('{{query}}', encodeURIComponent(query));
  url = url.replaceAll('{{timespan}}', encodeURIComponent(timespan));
  if (!url.includes('timespan=')) {
    const parsed = new URL(url);
    parsed.searchParams.set('timespan', timespan);
    url = parsed.toString();
  }
  if (!url.includes('startdatetime') && !url.includes('enddatetime')) {
    // Some GDELT endpoints ignore timespan; still safe to include for clarity.
  }
  return url;
}

function buildUcdpCandidateUrl(feed) {
  const { start, end } = getAcledWindow();
  let url = feed.url || '';
  url = url.replaceAll('{{start}}', encodeURIComponent(start));
  url = url.replaceAll('{{end}}', encodeURIComponent(end));
  return url;
}

function buildEiaLegacyUrl(feed, apiKey) {
  if (!apiKey) return null;
  try {
    const parsed = new URL(feed.url || '');
    const parts = parsed.pathname.split('/').filter(Boolean);
    const seriesIndex = parts.findIndex((part) => part === 'seriesid');
    if (seriesIndex === -1 || !parts[seriesIndex + 1]) return null;
    const seriesId = parts[seriesIndex + 1];
    const legacy = new URL('https://api.eia.gov/series/');
    legacy.searchParams.set('api_key', apiKey);
    legacy.searchParams.set('series_id', seriesId);
    return legacy.toString();
  } catch {
    return null;
  }
}

function normalizeEiaSeriesUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.pathname.includes('/v2/seriesid/')) return rawUrl;
    if (!parsed.searchParams.has('data[0]')) parsed.searchParams.set('data[0]', 'value');
    if (!parsed.searchParams.has('sort[0][column]')) parsed.searchParams.set('sort[0][column]', 'period');
    if (!parsed.searchParams.has('sort[0][direction]')) parsed.searchParams.set('sort[0][direction]', 'desc');
    if (!parsed.searchParams.has('length')) parsed.searchParams.set('length', '10');
    if (!parsed.searchParams.has('offset')) parsed.searchParams.set('offset', '0');
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function buildUrl(template, params = {}) {
  let url = template;
  Object.entries(params).forEach(([key, value]) => {
    url = url.replaceAll(`{{${key}}}`, encodeURIComponent(value ?? ''));
  });
  return url;
}

function applyKey(url, feed, key, keyParam, keyHeader) {
  if (!key) return { url, headers: {} };
  const header = keyHeader || feed.keyHeader;
  if (header) {
    return { url, headers: { [header]: key } };
  }
  const param = keyParam || feed.keyParam;
  if (param) {
    const parsed = new URL(url);
    parsed.searchParams.set(param, key);
    return { url: parsed.toString(), headers: {} };
  }
  return { url, headers: {} };
}

function applyProxy(url, proxy) {
  if (!proxy) return url;
  if (proxy === 'allorigins') {
    return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  }
  if (proxy === 'jina') {
    const stripped = url.replace(/^https?:\/\//, '');
    return `https://r.jina.ai/http://${stripped}`;
  }
  return url;
}

function decodeMaybeGzip(buffer) {
  if (!buffer || buffer.length < 2) return Buffer.from(buffer || []);
  const signature = buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!signature) return Buffer.from(buffer);
  try {
    return gunzipSync(Buffer.from(buffer));
  } catch (err) {
    return Buffer.from(buffer);
  }
}

function stripApiKeys(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((entry) => stripApiKeys(entry));
    return value;
  }
  Object.keys(value).forEach((key) => {
    if (key.toLowerCase() === 'api_key') {
      delete value[key];
      return;
    }
    stripApiKeys(value[key]);
  });
  return value;
}

function parseGpsJamManifest(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  let latest = null;
  lines.forEach((line) => {
    const [date, suspect, bad] = line.split(',');
    if (!date || date === 'date') return;
    if (!latest || Date.parse(date) > Date.parse(latest.date)) {
      latest = { date: date.trim(), suspect, bad };
    }
  });
  return latest;
}

async function fetchGpsJam(force = false) {
  const feed = feedsConfig.feeds.find((entry) => entry.id === GPSJAM_ID);
  if (!feed) {
    return { error: 'missing_feed', message: 'GPSJam feed missing.' };
  }
  const ttlMs = (feed.ttlMinutes || appConfig.defaultRefreshMinutes) * 60 * 1000;
  const cached = cache.get(GPSJAM_CACHE_KEY);
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  const manifestRes = await fetchWithTimeout(feed.url, {
    headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'text/plain,*/*' }
  }, FETCH_TIMEOUT_MS);
  const manifestBuf = Buffer.from(await manifestRes.arrayBuffer());
  const manifestText = decodeMaybeGzip(manifestBuf).toString('utf8');
  const manifest = parseGpsJamManifest(manifestText);
  if (!manifest?.date) {
    return { error: 'manifest_empty', message: 'No GPSJam date found.' };
  }

  const dataUrl = `https://gpsjam.org/data/${manifest.date}-h3_4.csv`;
  const dataRes = await fetchWithTimeout(dataUrl, {
    headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'text/plain,*/*' }
  }, FETCH_TIMEOUT_MS);
  const dataBuf = Buffer.from(await dataRes.arrayBuffer());
  const dataText = decodeMaybeGzip(dataBuf).toString('utf8');
  const payload = {
    fetchedAt: Date.now(),
    httpStatus: dataRes.status,
    date: manifest.date,
    body: dataText
  };
  cache.set(GPSJAM_CACHE_KEY, payload);
  return payload;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallbacks(url, headers, proxies = []) {
  let primaryResponse = null;
  try {
    primaryResponse = await fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);
    if (primaryResponse.ok) return primaryResponse;
  } catch {
    primaryResponse = null;
  }

  const fallbackUrls = [];
  if (url.startsWith('https://')) {
    fallbackUrls.push(`http://${url.slice('https://'.length)}`);
  }
  proxies.forEach((proxy) => {
    fallbackUrls.push(applyProxy(url, proxy));
  });

  let lastResponse = primaryResponse;
  for (const fallbackUrl of fallbackUrls) {
    try {
      const response = await fetchWithTimeout(fallbackUrl, { headers }, FETCH_TIMEOUT_MS);
      if (response.ok) return response;
      lastResponse = lastResponse || response;
    } catch {
      // ignore
    }
  }

  if (lastResponse) return lastResponse;
  throw new Error('fetch_failed');
}

function buildAcledProxyUrl(feed) {
  const { start, end } = getAcledWindow();
  const params = new URLSearchParams();
  params.set('start', start);
  params.set('end', end);
  params.set('limit', String(feed.limit || 500));
  if (feed.acledMode === 'aggregated') {
    params.set('region', feed.acledRegion || 'global');
  }
  const base = ACLED_PROXY.endsWith('/') ? ACLED_PROXY.slice(0, -1) : ACLED_PROXY;
  const endpoint = feed.acledMode === 'aggregated' ? 'aggregated' : 'events';
  return `${base}/${endpoint}?${params.toString()}`;
}

async function fetchFeed(feed, { query, force = false, key, keyParam, keyHeader } = {}) {
  const cacheKey = `${feed.id}:${query || ''}`;
  const ttlMs = (feed.ttlMinutes || appConfig.defaultRefreshMinutes) * 60 * 1000;
  const cached = cache.get(cacheKey);
  const staleCache = cached;
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  const serverKey = resolveServerKey(feed);
  const effectiveKey = key || serverKey;
  if (feed.requiresKey && !effectiveKey) {
    return {
      id: feed.id,
      fetchedAt: Date.now(),
      contentType: 'application/json',
      body: JSON.stringify({
        error: feed.keySource === 'server' ? 'missing_server_key' : 'requires_key',
        message: feed.keySource === 'server' ? 'Server API key required for this feed.' : 'API key required for this feed.'
      })
    };
  }

  if (feed.requiresConfig && !feed.url) {
    return {
      id: feed.id,
      fetchedAt: Date.now(),
      contentType: 'application/json',
      body: JSON.stringify({ error: 'requires_config', message: 'Feed URL not configured.' })
    };
  }

  const finalQuery = feed.supportsQuery ? (query || feed.defaultQuery || '') : undefined;
  let url = feed.supportsQuery ? buildUrl(feed.url, { query: finalQuery }) : buildUrl(feed.url, {});
  const isEiaSeries = feed.id === 'energy-eia'
    || feed.id === 'energy-eia-brent'
    || feed.id === 'energy-eia-ng';
  if (isEiaSeries) {
    url = normalizeEiaSeriesUrl(url);
  }
  if (feed.id === 'acled-events' && ACLED_PROXY) {
    url = buildAcledProxyUrl(feed);
  }
  if (feed.id === 'gdelt-conflict-geo') {
    url = buildGdeltConflictUrl(feed);
  }
  if (feed.id === 'ucdp-candidate-events') {
    url = buildUcdpCandidateUrl(feed);
  }

  const applied = applyKey(url, feed, effectiveKey, keyParam, keyHeader);
  const headers = {
    'User-Agent': appConfig.userAgent,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...applied.headers
  };

  const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
  let response;
  let responseOk = false;
  let contentType = 'text/plain';
  let body = '';
  try {
    if (isEiaSeries) {
      for (let attempt = 0; attempt < EIA_RETRY_ATTEMPTS; attempt += 1) {
        response = await fetchWithTimeout(applied.url, { headers }, FETCH_TIMEOUT_MS * 2);
        responseOk = response.ok;
        if (responseOk) break;
        if (attempt < EIA_RETRY_ATTEMPTS - 1) {
          await sleep(EIA_RETRY_DELAY_MS);
        }
      }
    } else {
      response = await fetchWithFallbacks(applied.url, headers, proxyList);
      responseOk = response.ok;
    }
    contentType = response.headers.get('content-type') || 'text/plain';
    body = await response.text();
    if (isEiaSeries && typeof body === 'string' && body.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(body);
        stripApiKeys(parsed);
        body = JSON.stringify(parsed);
      } catch {
        // ignore JSON parsing failures
      }
    }
    if (isEiaSeries && responseOk && typeof body === 'string' && body.includes('Something unexpected happened')) {
      responseOk = false;
    }
  } catch (error) {
    if (!isEiaSeries) throw error;
  }

  if (isEiaSeries && (!response || !responseOk)) {
    const hasUsableStale = staleCache
      && staleCache.httpStatus
      && staleCache.httpStatus >= 200
      && staleCache.httpStatus < 300;
    if (hasUsableStale) {
      return { ...staleCache, stale: true, fetchedAt: Date.now() };
    }
    const legacyUrl = buildEiaLegacyUrl(feed, effectiveKey);
    if (legacyUrl) {
      try {
        const legacyResponse = await fetchWithTimeout(legacyUrl, { headers }, FETCH_TIMEOUT_MS * 2);
        if (legacyResponse.ok) {
          response = legacyResponse;
          contentType = legacyResponse.headers.get('content-type') || 'text/plain';
          body = await legacyResponse.text();
        }
      } catch {
        // fallthrough to error
      }
    }
  }
  if (!response) {
    throw new Error('fetch_failed');
  }

  if (feed.id === 'ucdp-candidate-events' && response.ok) {
    try {
      const parsed = JSON.parse(body || '{}');
      const total = Number(parsed?.TotalCount || 0);
      if (!total) {
        const fallbackEnd = new Date();
        fallbackEnd.setFullYear(fallbackEnd.getFullYear() - 1);
        const fallbackStart = new Date(fallbackEnd);
        fallbackStart.setDate(fallbackEnd.getDate() - DEFAULT_LOOKBACK_DAYS);
        const fallbackUrl = (feed.url || '')
          .replaceAll('{{start}}', encodeURIComponent(formatIsoDate(fallbackStart)))
          .replaceAll('{{end}}', encodeURIComponent(formatIsoDate(fallbackEnd)));
        const fallbackResponse = await fetchWithFallbacks(fallbackUrl, headers, proxyList);
        if (fallbackResponse.ok) {
          body = await fallbackResponse.text();
        }
      }
    } catch {
      // ignore parsing failures
    }
  }

  const payload = {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: response.status
  };
  if (!isEiaSeries || responseOk) {
    cache.set(cacheKey, payload);
  }
  return payload;
}

async function fetchEnergyMap() {
  const apiKey = process.env.EIA;
  if (!apiKey) {
    return { error: 'missing_server_key', message: 'EIA key missing.' };
  }
  const url = new URL('https://api.eia.gov/v2/electricity/retail-sales/data/');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'price');
  url.searchParams.set('facets[sectorid][]', 'RES');
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '400');

  const response = await fetchWithTimeout(url.toString(), { headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'application/json' } }, FETCH_TIMEOUT_MS);
  const text = await response.text();
  if (!response.ok) {
    return { error: 'fetch_failed', message: text || 'EIA energy map fetch failed.' };
  }
  const payload = JSON.parse(text || '{}');
  const rows = payload.response?.data || [];
  const latestByState = {};
  rows.forEach((row) => {
    const state = row.stateid || row.state;
    if (!state) return;
    if (latestByState[state]?.period && latestByState[state].period >= row.period) return;
    latestByState[state] = {
      period: row.period,
      value: Number(row.price),
      state: row.stateDescription || row.stateid
    };
  });
  const values = Object.values(latestByState).map((entry) => entry.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  return {
    data: {
      period: rows[0]?.period || '',
      units: rows[0]?.['price-units'] || 'cents/kWh',
      values: latestByState,
      min,
      max
    }
  };
}

async function geocodeQuery(query) {
  const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
  geoUrl.searchParams.set('format', 'json');
  geoUrl.searchParams.set('limit', '1');
  geoUrl.searchParams.set('q', query);

  try {
    const response = await fetchWithTimeout(geoUrl.toString(), {
      headers: {
        'User-Agent': appConfig.userAgent,
        'Accept': 'application/json'
      }
    }, FETCH_TIMEOUT_MS);

    if (response.ok) {
      const data = await response.json();
      const result = data?.[0];
      if (result) {
        return {
          query,
          lat: Number(result.lat),
          lon: Number(result.lon),
          displayName: result.display_name
        };
      }
    }
  } catch (error) {
    // fall through to secondary provider
  }

  const fallbackUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  fallbackUrl.searchParams.set('name', query);
  fallbackUrl.searchParams.set('count', '1');
  fallbackUrl.searchParams.set('language', 'en');
  fallbackUrl.searchParams.set('format', 'json');

  const fallbackResponse = await fetchWithTimeout(fallbackUrl.toString(), {
    headers: {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }
  }, FETCH_TIMEOUT_MS);

  if (!fallbackResponse.ok) {
    throw new Error(`Geocode failed (${fallbackResponse.status})`);
  }

  const fallbackData = await fallbackResponse.json();
  const fallback = fallbackData?.results?.[0];
  if (!fallback) {
    return { query, notFound: true };
  }

  const parts = [fallback.name, fallback.admin1, fallback.country].filter(Boolean);
  return {
    query,
    lat: Number(fallback.latitude),
    lon: Number(fallback.longitude),
    displayName: parts.join(', ')
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true }, origin);
  }

  if (url.pathname === '/api/feeds') {
    const sanitized = feedsConfig.feeds.map((feed) => ({ ...feed, url: feed.url }));
    return sendJson(res, 200, { app: feedsConfig.app, feeds: sanitized }, origin);
  }

  if (url.pathname === '/api/gpsjam') {
    const force = url.searchParams.get('force') === '1';
    try {
      const payload = await fetchGpsJam(force);
      if (payload.error) {
        return sendJson(res, 502, payload, origin);
      }
      return sendJson(res, 200, payload, origin);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message }, origin);
    }
  }

  if (url.pathname === '/api/congress-detail') {
    const target = url.searchParams.get('url');
    if (!target) {
      return sendJson(res, 400, { error: 'missing_url' }, origin);
    }
    let parsed;
    try {
      parsed = new URL(target);
    } catch (error) {
      return sendJson(res, 400, { error: 'invalid_url', message: error.message }, origin);
    }
    if (parsed.hostname !== 'api.congress.gov') {
      return sendJson(res, 400, { error: 'invalid_host' }, origin);
    }
    const key = process.env.DATA_GOV;
    if (!key) {
      return sendJson(res, 502, { error: 'missing_key', message: 'Server API key required.' }, origin);
    }
    parsed.searchParams.set('api_key', key);
    try {
      const response = await fetchWithTimeout(parsed.toString(), {
        headers: {
          'User-Agent': appConfig.userAgent,
          'Accept': 'application/json'
        }
      }, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        return sendJson(res, 502, { error: 'fetch_failed', status: response.status }, origin);
      }
      const data = await response.json();
      return sendJson(res, 200, data, origin);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message }, origin);
    }
  }

  if (url.pathname === '/api/feed') {
    let body = {};
    if (req.method === 'POST') {
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        return sendJson(res, 400, { error: 'invalid_json', message: error.message }, origin);
      }
    }
    const id = body.id || url.searchParams.get('id');
    const query = body.query || url.searchParams.get('query') || undefined;
    const force = body.force === true || url.searchParams.get('force') === '1';
    const key = body.key || url.searchParams.get('key') || undefined;
    const keyParam = body.keyParam || url.searchParams.get('keyParam') || undefined;
    const keyHeader = body.keyHeader || url.searchParams.get('keyHeader') || undefined;
    const feed = feedsConfig.feeds.find((f) => f.id === id);
    if (!feed) {
      return sendJson(res, 404, { error: 'unknown_feed', id }, origin);
    }
    try {
      const payload = await fetchFeed(feed, { query, force, key, keyParam, keyHeader });
      return sendJson(res, 200, payload, origin);
    } catch (error) {
      const message = error?.message || 'fetch failed';
      return sendJson(res, 502, { error: 'fetch_failed', message }, origin);
    }
  }

  if (url.pathname === '/api/energy-map') {
    try {
      const result = await fetchEnergyMap();
      if (result.error) {
        return sendJson(res, 200, result, origin);
      }
      return sendJson(res, 200, result.data, origin);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message }, origin);
    }
  }

  if (url.pathname === '/api/geocode') {
    const query = url.searchParams.get('q');
    if (!query) {
      return sendJson(res, 400, { error: 'missing_query' }, origin);
    }
    try {
      const payload = await geocodeQuery(query);
      return sendJson(res, 200, payload, origin);
    } catch (error) {
      return sendJson(res, 502, { error: 'geocode_failed', message: error.message }, origin);
    }
  }

  if (url.pathname === '/api/snapshot' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, origin);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

server.listen(PORT, () => {
  console.log(`Feed proxy listening on ${PORT}`);
});
