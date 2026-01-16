import http from 'http';
import { mkdirSync, readFile, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = normalize(join(__dirname, 'public'));
const DATA = normalize(join(__dirname, 'data', 'feeds.json'));
const GEO_CACHE_PATH = normalize(join(__dirname, 'analysis', 'geo', 'geocode_cache.json'));

const feedsConfig = JSON.parse(readFileSync(DATA, 'utf8'));
const appConfig = feedsConfig.app || { defaultRefreshMinutes: 60, userAgent: 'TheSituationRoom/0.1' };
const cache = new Map();
const energyMapCache = { data: null, fetchedAt: 0 };
let geoCache = {};
let lastGeocodeAt = 0;
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENSKY_CLIENTID = process.env.OPENSKY_CLIENTID;
const OPENSKY_CLIENTSECRET = process.env.OPENSKY_CLIENTSECRET;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
let openSkyToken = null;
let openSkyTokenExpiresAt = 0;
const FETCH_TIMEOUT_MS = feedsConfig.app?.fetchTimeoutMs || 12000;
const GPSJAM_ID = 'gpsjam';
const GPSJAM_CACHE_KEY = 'gpsjam:data';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function loadLocalFeed(feed) {
  if (!feed.localPath) return null;
  const filePath = normalize(join(__dirname, feed.localPath));
  if (!filePath.startsWith(__dirname)) return null;
  if (!existsSync(filePath)) return null;
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'text/plain; charset=utf-8';
  const body = readFileSync(filePath, 'utf8');
  return {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: 200
  };
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function safePath(urlPath) {
  const cleaned = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = normalize(join(ROOT, cleaned));
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

function buildUrl(template, params = {}) {
  let url = template;
  Object.entries(params).forEach(([key, value]) => {
    url = url.replaceAll(`{{${key}}}`, encodeURIComponent(value ?? ''));
  });
  return url;
}

function loadGeoCache() {
  if (existsSync(GEO_CACHE_PATH)) {
    try {
      geoCache = JSON.parse(readFileSync(GEO_CACHE_PATH, 'utf8'));
    } catch (err) {
      geoCache = {};
    }
  }
}

function saveGeoCache() {
  mkdirSync(join(__dirname, 'analysis', 'geo'), { recursive: true });
  writeFileSync(GEO_CACHE_PATH, JSON.stringify(geoCache, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function getOpenSkyToken() {
  if (!OPENSKY_CLIENTID || !OPENSKY_CLIENTSECRET) return null;
  if (openSkyToken && Date.now() < openSkyTokenExpiresAt) {
    return openSkyToken;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OPENSKY_CLIENTID,
    client_secret: OPENSKY_CLIENTSECRET
  });
  const response = await fetch(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.access_token) return null;
  const ttl = Number(data.expires_in) || 1800;
  openSkyToken = data.access_token;
  openSkyTokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
  return openSkyToken;
}

async function geocodeQuery(query) {
  const key = query.toLowerCase();
  if (geoCache[key]) {
    return { ...geoCache[key], cached: true };
  }

  const now = Date.now();
  const delta = now - lastGeocodeAt;
  if (delta < 1100) {
    await new Promise((resolve) => setTimeout(resolve, 1100 - delta));
  }
  lastGeocodeAt = Date.now();

  const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
  geoUrl.searchParams.set('format', 'json');
  geoUrl.searchParams.set('limit', '1');
  geoUrl.searchParams.set('q', query);

  const response = await fetchWithTimeout(geoUrl.toString(), {
    headers: {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }
  }, FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Geocode failed (${response.status})`);
  }

  const data = await response.json();
  const result = data?.[0];
  if (!result) {
    const payload = { query, notFound: true };
    geoCache[key] = payload;
    saveGeoCache();
    return payload;
  }

  const payload = {
    query,
    lat: Number(result.lat),
    lon: Number(result.lon),
    displayName: result.display_name
  };
  geoCache[key] = payload;
  saveGeoCache();
  return payload;
}

async function handleChat(payload, apiKey) {
  if (!apiKey) {
    return { status: 401, body: { error: 'missing_api_key', message: 'Provide an OpenAI API key.' } };
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const model = payload.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.2;
  const context = payload.context ? JSON.stringify(payload.context) : '';

  const input = [
    {
      role: 'system',
      content: 'You are the Situation Room assistant. Use only the provided context. Keep responses concise, actionable, and include feed/source names when referencing signals. If data is missing, say so explicitly.'
    }
  ];

  if (context) {
    input.push({
      role: 'system',
      content: `Context snapshot: ${context}`
    });
  }

  input.push(...messages);

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input, temperature })
  });

  const data = await response.json();
  if (!response.ok) {
    return { status: response.status, body: { error: 'openai_error', message: data.error?.message || 'OpenAI request failed.' } };
  }

  const text = data.output_text
    || data.output?.map((item) => item.content?.map((c) => c.text).join('')).join('')
    || '';

  return {
    status: 200,
    body: {
      id: data.id,
      model: data.model,
      text,
      usage: data.usage || null
    }
  };
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

function resolveServerKey(feed) {
  if (feed.keySource !== 'server') return null;
  if (feed.keyGroup === 'api.data.gov') return process.env.DATA_GOV;
  if (feed.keyGroup === 'eia') return process.env.EIA;
  if (feed.keyGroup === 'earthdata') return process.env.EARTHDATA_NASA;
  if (feed.id === 'openaq-api') return process.env.OPEN_AQ;
  if (feed.id === 'nasa-firms') return process.env.NASA_FIRMS;
  return null;
}

async function fetchWithFallbacks(url, headers, proxies = []) {
  let primaryResponse = null;
  try {
    primaryResponse = await fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);
    if (primaryResponse.ok) return primaryResponse;
  } catch (err) {
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
  let lastError = null;
  for (const fallbackUrl of fallbackUrls) {
    try {
      const response = await fetchWithTimeout(fallbackUrl, { headers }, FETCH_TIMEOUT_MS);
      if (response.ok) return response;
      lastResponse = lastResponse || response;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResponse) return lastResponse;
  if (lastError) throw lastError;
  throw new Error('fetch_failed');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEnergyMap() {
  const apiKey = process.env.EIA;
  if (!apiKey) {
    return { error: 'missing_server_key', message: 'Server EIA key required for energy map.' };
  }

  const ttlMs = 60 * 60 * 1000;
  if (energyMapCache.data && Date.now() - energyMapCache.fetchedAt < ttlMs) {
    return { data: energyMapCache.data };
  }

  const url = new URL('https://api.eia.gov/v2/electricity/retail-sales/data/');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'price');
  url.searchParams.set('facets[sectorid][]', 'RES');
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('offset', '0');
  url.searchParams.set('length', '200');

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }
  }, FETCH_TIMEOUT_MS);

  if (!response.ok) {
    return { error: 'fetch_failed', message: `EIA energy map request failed (${response.status})` };
  }

  const data = await response.json();
  const rows = Array.isArray(data?.response?.data) ? data.response.data : [];
  const latestByState = {};
  rows.forEach((row) => {
    if (!row.stateid || latestByState[row.stateid]) return;
    const value = Number(row.price);
    if (!Number.isFinite(value)) return;
    latestByState[row.stateid] = {
      value,
      period: row.period,
      state: row.stateDescription || row.stateid
    };
  });
  const values = Object.values(latestByState).map((entry) => entry.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const payload = {
    period: rows[0]?.period || '',
    units: rows[0]?.['price-units'] || 'cents/kWh',
    values: latestByState,
    min,
    max
  };

  energyMapCache.data = payload;
  energyMapCache.fetchedAt = Date.now();
  return { data: payload };
}

async function fetchFeed(feed, { query, force = false, key, keyParam, keyHeader } = {}) {
  const cacheKey = `${feed.id}:${query || ''}`;
  const ttlMs = (feed.ttlMinutes || appConfig.defaultRefreshMinutes) * 60 * 1000;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  const localPayload = loadLocalFeed(feed);
  if (localPayload) {
    cache.set(cacheKey, localPayload);
    return localPayload;
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
  const baseUrl = feed.supportsQuery
    ? buildUrl(feed.url, { query: finalQuery, key: effectiveKey })
    : buildUrl(feed.url, { key: effectiveKey });
  const useClientKey = Boolean(key);
  const applied = applyKey(baseUrl, feed, effectiveKey, useClientKey ? keyParam : undefined, useClientKey ? keyHeader : undefined);
  const headers = {
    'User-Agent': appConfig.userAgent,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (feed.id === 'transport-opensky') {
    const token = await getOpenSkyToken();
    if (!token) {
      return {
        id: feed.id,
        fetchedAt: Date.now(),
        contentType: 'application/json',
        body: JSON.stringify({ error: 'missing_server_key', message: 'OpenSky OAuth token unavailable.' })
      };
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
  const response = await fetchWithFallbacks(applied.url, { ...headers, ...applied.headers }, proxyList);
  const contentType = response.headers.get('content-type') || 'text/plain';
  const body = await response.text();

  const payload = {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: response.status
  };
  cache.set(cacheKey, payload);
  return payload;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/feeds') {
    const sanitized = feedsConfig.feeds.map((feed) => ({
      ...feed,
      url: feed.requiresKey ? feed.url : feed.url
    }));
    return sendJson(res, 200, { app: feedsConfig.app, feeds: sanitized });
  }

  if (url.pathname === '/api/gpsjam') {
    const force = url.searchParams.get('force') === '1';
    try {
      const payload = await fetchGpsJam(force);
      if (payload.error) {
        return sendJson(res, 502, payload);
      }
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/feed') {
    let body = {};
    if (req.method === 'POST') {
      try {
        const raw = await readRequestBody(req);
        body = JSON.parse(raw || '{}');
      } catch (error) {
        return sendJson(res, 400, { error: 'invalid_json', message: error.message });
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
      return sendJson(res, 404, { error: 'unknown_feed', id });
    }

    try {
      const payload = await fetchFeed(feed, { query, force, key, keyParam, keyHeader });
      return sendJson(res, 200, payload);
    } catch (error) {
      const extra = error?.cause?.code || error?.code;
      const message = [error?.message, extra].filter(Boolean).join(' ');
      return sendJson(res, 502, { error: 'fetch_failed', message: message || 'fetch failed' });
    }
  }

  if (url.pathname === '/api/energy-map') {
    try {
      const result = await fetchEnergyMap();
      if (result.error) {
        return sendJson(res, 200, result);
      }
      return sendJson(res, 200, result.data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/geocode') {
    const query = url.searchParams.get('q');
    if (!query) {
      return sendJson(res, 400, { error: 'missing_query' });
    }
    try {
      const payload = await geocodeQuery(query);
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, { error: 'geocode_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw || '{}');
      const apiKey = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY || process.env.OPEN_AI;
      const result = await handleChat(payload, apiKey);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      return sendJson(res, 400, { error: 'invalid_request', message: error.message });
    }
  }

  if (url.pathname === '/api/snapshot' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const dir = join(__dirname, 'analysis', 'denario', 'snapshots');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = join(dir, `snapshot-${stamp}.json`);
        writeFileSync(filePath, JSON.stringify(parsed, null, 2));
        return sendJson(res, 200, { saved: true, path: filePath });
      } catch (error) {
        return sendJson(res, 400, { error: 'invalid_json', message: error.message });
      }
    });
    return;
  }

  const filePath = safePath(url.pathname);
  if (!filePath) return notFound(res);

  readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = 5173;
const HOST = '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`The Situation Room running at http://localhost:${PORT}`);
});

loadGeoCache();
