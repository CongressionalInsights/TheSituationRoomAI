import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';

const ROOT = process.cwd();
const FEEDS_PATH = join(ROOT, 'data', 'feeds.json');
const OUT_DIR = join(ROOT, 'public', 'data');
const FEED_DIR = join(OUT_DIR, 'feeds');
const TIMEOUT_MS = 12000;
const DEFAULT_LIVE_BASE = 'https://congressionalinsights.github.io/TheSituationRoomAI';
const LIVE_BASE = process.env.SR_LIVE_BASE
  || (process.env.GITHUB_REPOSITORY
    ? `https://${process.env.GITHUB_REPOSITORY.split('/')[0].toLowerCase()}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}`
    : DEFAULT_LIVE_BASE);
const OPENSKY_CLIENTID = process.env.OPENSKY_CLIENTID;
const OPENSKY_CLIENTSECRET = process.env.OPENSKY_CLIENTSECRET;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
let openSkyToken = null;
let openSkyTokenExpiresAt = 0;
const seededFeedFallbacks = new Map();
const SEEDED_JSON_FALLBACK_IDS = new Set(['eonet-events', 'nasa-firms']);

const feedsConfig = JSON.parse(await readFile(FEEDS_PATH, 'utf8'));
const appConfig = feedsConfig.app || { defaultRefreshMinutes: 60, userAgent: 'TheSituationRoom/0.1' };

function buildUrl(template, params = {}) {
  let url = template;
  Object.entries(params).forEach(([key, value]) => {
    url = url.replaceAll(`{{${key}}}`, encodeURIComponent(value ?? ''));
  });
  return url;
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

function normalizeContentType(contentType = '') {
  return String(contentType || '').toLowerCase();
}

function looksLikeHtmlDocument(text = '') {
  const sample = String(text || '').slice(0, 2048).trim().toLowerCase();
  if (!sample) return false;
  return sample.startsWith('<!doctype html')
    || sample.startsWith('<html')
    || sample.includes('<html')
    || sample.includes('<body');
}

function looksLikeXmlFeed(text = '') {
  const sample = String(text || '').slice(0, 4096).trim().toLowerCase();
  if (!sample) return false;
  return sample.startsWith('<?xml')
    || sample.includes('<rss')
    || sample.includes('<feed')
    || sample.includes('<rdf:rdf');
}

function isLikelyRssPayload(contentType = '', body = '') {
  const normalizedType = normalizeContentType(contentType);
  const xmlType = normalizedType.includes('rss')
    || normalizedType.includes('atom')
    || normalizedType.includes('xml');
  if (looksLikeXmlFeed(body)) return true;
  if (xmlType && !looksLikeHtmlDocument(body)) return true;
  return false;
}

function buildFetchCandidates(url, proxies = [], { includeHttpFallback = true } = {}) {
  const candidates = [];
  const seen = new Set();
  const push = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  push(url);
  if (includeHttpFallback && url.startsWith('https://')) {
    push(`http://${url.slice('https://'.length)}`);
  }
  proxies.forEach((proxy) => {
    push(applyProxy(url, proxy));
  });
  return candidates;
}

function resolveServerKey(feed) {
  if (feed.keySource !== 'server') return null;
  if (feed.keyGroup === 'api.data.gov') return process.env.DATA_GOV;
  if (feed.keyGroup === 'eia') return process.env.EIA;
  if (feed.id === 'openaq-api') return process.env.OPEN_AQ;
  if (feed.id === 'nasa-firms') return process.env.NASA_FIRMS;
  return null;
}

function applyKey(url, feed, key) {
  if (!key) return { url, headers: {} };
  if (feed.keyHeader) {
    return { url, headers: { [feed.keyHeader]: key } };
  }
  if (feed.keyParam) {
    const parsed = new URL(url);
    parsed.searchParams.set(feed.keyParam, key);
    return { url: parsed.toString(), headers: {} };
  }
  return { url, headers: {} };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildNasaFirmsItems(data, source = 'NASA FIRMS') {
  if (!Array.isArray(data)) return [];
  return data.slice(0, 200).map((entry) => {
    const lat = Number(entry.latitude ?? entry.lat ?? entry.Latitude ?? entry.lat_deg ?? entry.latitude_deg);
    const lon = Number(entry.longitude ?? entry.lon ?? entry.Longitude ?? entry.lon_deg ?? entry.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const brightness = entry.bright_ti4 ?? entry.brightness ?? entry.bright_ti5 ?? entry.bright;
    const frp = entry.frp ?? entry.fire_radiative_power;
    const confidence = entry.confidence ?? entry.conf ?? entry.confidence_level;
    const parts = [];
    if (brightness) parts.push(`Brightness ${brightness}`);
    if (frp) parts.push(`FRP ${frp}`);
    if (confidence) parts.push(`Confidence ${confidence}`);
    const date = entry.acq_date || entry.date || entry.timestamp || entry.acquired;
    let publishedAt = Date.now();
    if (date) {
      const time = String(entry.acq_time || '').padStart(4, '0');
      if (time && time.length === 4 && /^\d+$/.test(time)) {
        const stamp = `${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`;
        const parsed = Date.parse(stamp);
        if (!Number.isNaN(parsed)) publishedAt = parsed;
      } else {
        const parsed = Date.parse(date);
        if (!Number.isNaN(parsed)) publishedAt = parsed;
      }
    }
    return {
      title: entry.title || 'Fire detection',
      summary: parts.length ? parts.join(' | ') : 'Active fire detection',
      latitude: lat,
      longitude: lon,
      publishedAt,
      source,
      alertType: 'Fire'
    };
  }).filter(Boolean);
}

async function buildArcgisFireFallback() {
  const fireFeed = feedsConfig.feeds.find((feed) => feed.id === 'arcgis-hms-fire');
  if (!fireFeed?.url) return null;
  try {
    const response = await fetchWithFallbacks(fireFeed.url, { 'User-Agent': appConfig.userAgent }, [], TIMEOUT_MS);
    if (!response.ok) return null;
    const data = await response.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    const items = features.slice(0, 200).map((feature) => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [];
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const label = props.name || props.NAME || props.fire_name || 'Fire detection';
      const confidence = props.confidence || props.CONFIDENCE || props.confidence_level;
      const frp = props.frp || props.FRP;
      const parts = [];
      if (confidence) parts.push(`Confidence ${confidence}`);
      if (frp) parts.push(`FRP ${frp}`);
      return {
        title: label,
        summary: parts.length ? parts.join(' | ') : 'NOAA HMS fire detection',
        latitude: lat,
        longitude: lon,
        publishedAt: props.acq_date || props.date ? Date.parse(props.acq_date || props.date) : Date.now(),
        source: 'NOAA HMS',
        alertType: 'Fire'
      };
    }).filter(Boolean);
    if (!items.length) return null;
    return {
      id: 'nasa-firms',
      fetchedAt: Date.now(),
      contentType: 'application/json',
      body: JSON.stringify({ items }),
      httpStatus: 200,
      fallback: 'arcgis-hms-fire'
    };
  } catch {
    return null;
  }
}

function parseStooqCsv(text) {
  if (!text) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map((h) => h.trim());
  const values = lines[1].split(',').map((v) => v.trim());
  if (values.length < headers.length) return null;
  const row = headers.reduce((acc, key, idx) => {
    acc[key] = values[idx];
    return acc;
  }, {});
  if (!row.Symbol || !row.Close || row.Close === 'N/D') return null;
  const value = Number(row.Close);
  if (!Number.isFinite(value)) return null;
  const open = Number(row.Open);
  const deltaPct = Number.isFinite(open) && open ? ((value - open) / open) * 100 : null;
  return {
    symbol: row.Symbol,
    value,
    deltaPct,
    date: row.Date || '',
    time: row.Time || '',
    url: `https://stooq.com/q/?s=${encodeURIComponent(row.Symbol.toLowerCase())}`
  };
}

function extractTitlesFromPayload(feed, payload) {
  if (!payload?.body) return [];
  const titles = new Set();
  const source = payload.body;
  const feedName = (feed?.name || '').toLowerCase();

  const pushTitle = (raw) => {
    const cleaned = decodeHtml(decodeJsonString(raw))
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 8 || cleaned.length > 180) return;
    const lower = cleaned.toLowerCase();
    if (feedName && lower.includes(feedName) && cleaned.length - feedName.length < 12) return;
    if (lower.includes('rss') && cleaned.length < 24) return;
    titles.add(cleaned);
  };

  const titleRegex = /<title[^>]*>([^<]{4,200})<\/title>/gi;
  for (const match of source.matchAll(titleRegex)) {
    pushTitle(match[1]);
  }

  const jsonTitleRegex = /"title"\s*:\s*"([^"]{4,200})"/g;
  for (const match of source.matchAll(jsonTitleRegex)) {
    pushTitle(match[1]);
  }

  return Array.from(titles);
}

async function buildAnalysis(feedPayloads) {
  const allTitles = [];
  feedPayloads.forEach(({ feed, payload }) => {
    extractTitlesFromPayload(feed, payload).forEach((title) => allTitles.push(title));
  });
  const uniqueTitles = Array.from(new Set(allTitles)).slice(0, 60);
  const generatedAt = new Date().toISOString();

  const fallback = {
    generatedAt,
    source: 'fallback',
    text: uniqueTitles.length
      ? `Top signals:\n${uniqueTitles.slice(0, 8).map((title) => `- ${title}`).join('\n')}`
      : 'No signals available for briefing.'
  };

  const openaiKey = process.env.OPEN_AI || process.env.OPENAI_API_KEY;
  if (!openaiKey || uniqueTitles.length < 4) {
    return fallback;
  }

  const prompt = `Provide a concise situational briefing based on these headlines. Return 3 bullet sections with short labels.\n\nHeadlines:\n${uniqueTitles.map((title) => `- ${title}`).join('\n')}`;
  try {
    const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: [
          { role: 'system', content: 'You are an intelligence analyst. Produce a concise situational briefing with labeled bullet sections.' },
          { role: 'user', content: prompt }
        ],
        max_output_tokens: 320
      })
    }, 20000);
    if (!response.ok) {
      return fallback;
    }
    const data = await response.json();
    const outputText = data?.output_text
      || (Array.isArray(data?.output)
        ? data.output.map((item) => (item.content || []).map((c) => c.text || '').join('')).join('\n')
        : '');
    if (!outputText) return fallback;
    return {
      generatedAt,
      source: 'openai',
      text: outputText.trim()
    };
  } catch {
    return fallback;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const hasOptions = options && typeof options === 'object' && ('headers' in options || 'method' in options || 'body' in options);
  const fetchOptions = hasOptions ? { ...options } : { headers: options };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallbacks(url, headers, proxies = [], timeoutMs = TIMEOUT_MS) {
  const candidates = buildFetchCandidates(url, proxies, { includeHttpFallback: true });
  let lastResponse = null;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchWithTimeout(candidate, headers, timeoutMs);
      if (response.ok) return response;
      lastResponse = response;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResponse) return lastResponse;
  if (lastError) throw lastError;
  throw new Error('fetch_failed');
}

async function fetchRssWithFallbacks(url, headers, proxies = [], timeoutMs = TIMEOUT_MS) {
  const candidates = buildFetchCandidates(url, proxies, { includeHttpFallback: false });
  const effectiveTimeout = Math.max(8000, timeoutMs);
  const directTimeout = Math.max(15000, Math.floor(effectiveTimeout * 0.75));
  const fallbackTimeout = candidates.length > 1
    ? Math.max(4000, Math.floor((effectiveTimeout * 0.25) / (candidates.length - 1)))
    : directTimeout;
  let lastResponse = null;
  let lastError = null;
  let lastBody = '';
  let lastContentType = 'text/plain';

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const perAttemptTimeout = index === 0 ? directTimeout : fallbackTimeout;
    try {
      const response = await fetchWithTimeout(candidate, headers, perAttemptTimeout);
      const contentType = response.headers.get('content-type') || 'text/plain';
      const body = await response.text();
      lastResponse = response;
      lastBody = body;
      lastContentType = contentType;
      if (!response.ok) continue;
      if (isLikelyRssPayload(contentType, body)) {
        return {
          response,
          contentType,
          body,
          valid: true
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResponse) {
    return {
      response: lastResponse,
      contentType: lastContentType,
      body: lastBody,
      valid: false
    };
  }
  if (lastError) throw lastError;
  throw new Error('fetch_failed');
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
  const response = await fetchWithTimeout(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, 10000);
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.access_token) return null;
  const ttl = Number(data.expires_in) || 1800;
  openSkyToken = data.access_token;
  openSkyTokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
  return openSkyToken;
}

async function fetchLiveFallback(feedId) {
  if (!feedId) return null;
  const url = `${LIVE_BASE}/data/feeds/${feedId}.json?ts=${Date.now()}`;
  try {
    const response = await fetchWithTimeout(url, {}, 10000);
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || payload.error) return null;
    return payload;
  } catch {
    return null;
  }
}

function isUsableRssSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.error) return false;
  if (!payload.body) return false;
  return isLikelyRssPayload(payload.contentType || '', payload.body);
}

function isUsableJsonSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.error) return false;
  if (!payload.body) return false;
  try {
    JSON.parse(payload.body);
    return true;
  } catch {
    return false;
  }
}

async function loadSeedFeedFallbacks() {
  for (const feed of feedsConfig.feeds) {
    const shouldSeedRss = feed.format === 'rss';
    const shouldSeedJson = SEEDED_JSON_FALLBACK_IDS.has(feed.id);
    if (!shouldSeedRss && !shouldSeedJson) continue;
    const filePath = join(FEED_DIR, `${feed.id}.json`);
    try {
      const payload = JSON.parse(await readFile(filePath, 'utf8'));
      const usable = shouldSeedRss
        ? isUsableRssSnapshot(payload)
        : isUsableJsonSnapshot(payload);
      if (usable) {
        seededFeedFallbacks.set(feed.id, payload);
      }
    } catch {
      // ignore missing or invalid seed snapshot files
    }
  }
}

async function fetchFoiaCkanFallback() {
  const url = 'https://catalog.data.gov/api/3/action/package_search?q=foia&rows=15&sort=metadata_modified%20desc';
  try {
    const response = await fetchWithTimeout(url, {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }, 15000);
    if (!response.ok) return null;
    const body = await response.text();
    return {
      id: 'foia-api',
      fetchedAt: Date.now(),
      contentType: response.headers.get('content-type') || 'application/json',
      body,
      httpStatus: response.status,
      fallback: 'ckan'
    };
  } catch {
    return null;
  }
}

async function writeJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
}

async function buildFeedPayload(feed) {
  if (feed.requiresConfig && !feed.url) {
    if (feed.id !== 'acled-events') {
      return { id: feed.id, fetchedAt: Date.now(), error: 'requires_config', message: 'Feed URL not configured.' };
    }
  }

  const key = feed.requiresKey ? resolveServerKey(feed)?.trim() : null;
  if (feed.requiresKey && !key) {
    return {
      id: feed.id,
      fetchedAt: Date.now(),
      error: feed.keySource === 'server' ? 'missing_server_key' : 'requires_key',
      message: feed.keySource === 'server' ? 'Server API key required for this feed.' : 'API key required for this feed.'
    };
  }

  const query = feed.supportsQuery ? (feed.defaultQuery || '') : undefined;
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateParams = (feed.url || '').includes('{{start}}') || (feed.url || '').includes('{{end}}')
    ? { start, end }
    : {};
  const fallbackUrl = feed.id === 'acled-events'
    ? 'https://situation-room-acled-382918878290.us-central1.run.app/api/acled/events'
    : '';
  const baseUrl = feed.supportsQuery
    ? buildUrl(feed.url || fallbackUrl, { query, key, ...dateParams })
    : buildUrl(feed.url || fallbackUrl, { key, ...dateParams });
  const applied = applyKey(baseUrl, feed, key);
  const headers = {
    'User-Agent': appConfig.userAgent,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...applied.headers
  };
  if (feed.id === 'transport-opensky') {
    const token = await getOpenSkyToken();
    if (!token) {
      return {
        id: feed.id,
        fetchedAt: Date.now(),
        error: 'missing_server_key',
        message: 'OpenSky OAuth token unavailable.'
      };
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
  const isRssFeed = feed.format === 'rss';
  let response;
  let contentType = 'text/plain';
  let body = '';
  let rssValid = true;
  if (isRssFeed) {
    const rssResult = await fetchRssWithFallbacks(applied.url, headers, proxyList, feed.timeoutMs || TIMEOUT_MS);
    response = rssResult.response;
    contentType = rssResult.contentType;
    body = rssResult.body;
    rssValid = rssResult.valid;
  } else {
    response = await fetchWithFallbacks(applied.url, headers, proxyList, feed.timeoutMs || TIMEOUT_MS);
    contentType = response.headers.get('content-type') || 'text/plain';
    body = await response.text();
  }
  let payload = {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: response.status
  };
  if (!response.ok) {
    payload.error = `http_${response.status}`;
    payload.message = `HTTP ${response.status}`;
  } else if (isRssFeed && !rssValid) {
    payload.error = 'invalid_rss';
    payload.message = 'Upstream response was not valid RSS/Atom XML.';
  }

  if (!payload.error && feed.id === 'nasa-firms' && contentType.includes('json')) {
    try {
      const parsed = JSON.parse(body);
      const items = buildNasaFirmsItems(parsed);
      if (items.length) {
        payload.body = JSON.stringify({ items });
        payload.contentType = 'application/json';
        payload.transformed = true;
      }
    } catch {
      // ignore
    }
  }

  if (payload.error && (feed.id === 'nasa-firms' || feed.id === 'eonet-events')) {
    const fallback = await fetchLiveFallback(feed.id);
    if (fallback) {
      return { ...fallback, fallback: fallback.fallback || 'live-cache' };
    }
    const seeded = seededFeedFallbacks.get(feed.id);
    if (seeded && isUsableJsonSnapshot(seeded)) {
      return { ...seeded, fetchedAt: Date.now(), stale: true, fallback: 'seed-cache' };
    }
  }

  if (payload.error && isRssFeed) {
    const fallback = await fetchLiveFallback(feed.id);
    if (fallback && isUsableRssSnapshot(fallback)) {
      return { ...fallback, fetchedAt: Date.now(), fallback: 'live-cache' };
    }
    const seeded = seededFeedFallbacks.get(feed.id);
    if (seeded && isUsableRssSnapshot(seeded)) {
      return { ...seeded, fetchedAt: Date.now(), stale: true, fallback: 'seed-cache' };
    }
  }

  if (payload.error && feed.id === 'nasa-firms') {
    const fallbackUrl = buildUrl(feed.url, { key, dataset: 'VIIRS_NOAA20_NRT' })
      .replace('VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT');
    const fallbackApplied = applyKey(fallbackUrl, feed, key);
    try {
      const fallbackResponse = await fetchWithFallbacks(fallbackApplied.url, headers, proxyList, feed.timeoutMs || TIMEOUT_MS);
      const fallbackBody = await fallbackResponse.text();
      if (fallbackResponse.ok && fallbackBody) {
        payload = {
          id: feed.id,
          fetchedAt: Date.now(),
          contentType: fallbackResponse.headers.get('content-type') || 'text/plain',
          body: fallbackBody,
          httpStatus: fallbackResponse.status,
          fallback: 'VIIRS_NOAA20_NRT'
        };
      }
    } catch {
      // keep original payload
    }
  }

  const isEiaSeries = feed.id === 'energy-eia'
    || feed.id === 'energy-eia-brent'
    || feed.id === 'energy-eia-ng';
  if (payload.error && isEiaSeries) {
    const seriesId = feed.url?.split('/seriesid/')[1]?.split('?')[0];
    if (seriesId) {
      const legacyUrl = `https://api.eia.gov/series/?series_id=${encodeURIComponent(seriesId)}`;
      const legacyApplied = applyKey(legacyUrl, feed, key);
      try {
        const legacyResponse = await fetchWithFallbacks(legacyApplied.url, headers, proxyList, feed.timeoutMs || TIMEOUT_MS);
        const legacyBody = await legacyResponse.text();
        if (legacyResponse.ok && legacyBody) {
          payload = {
            id: feed.id,
            fetchedAt: Date.now(),
            contentType: legacyResponse.headers.get('content-type') || 'text/plain',
            body: legacyBody,
            httpStatus: legacyResponse.status,
            fallback: 'series_v1'
          };
        }
      } catch {
        // keep original payload
      }
    }
  }

  if (payload.error && isEiaSeries) {
    const fallback = await fetchLiveFallback(feed.id);
    if (fallback) {
      return {
        ...fallback,
        fetchedAt: Date.now(),
        fallback: 'live-cache'
      };
    }
  }
  if (payload.error && feed.id === 'foia-api') {
    const fallback = await fetchLiveFallback(feed.id);
    if (fallback) {
      return { ...fallback, fallback: true };
    }
    const ckanFallback = await fetchFoiaCkanFallback();
    if (ckanFallback) {
      return ckanFallback;
    }
  }

  if (payload.error && feed.id === 'nasa-firms') {
    const fireFallback = await buildArcgisFireFallback();
    if (fireFallback) return fireFallback;
  }

  if (!payload.error && feed.id === 'polymarket-markets' && contentType.includes('json')) {
    try {
      const markets = JSON.parse(body);
      if (Array.isArray(markets) && markets.length) {
        const sortedByVolume = [...markets].sort((a, b) => Number(b.volume24hr || 0) - Number(a.volume24hr || 0));
        const byVolume = sortedByVolume.slice(0, 2);
        const sortedByNewest = [...markets].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
        const byNewest = sortedByNewest.filter((item) => !byVolume.includes(item)).slice(0, 2);
        const targetIds = new Set([...byVolume, ...byNewest].map((item) => item.id));

        for (const market of markets) {
          if (!targetIds.has(market.id)) continue;
          const tokenIds = parseJsonArray(market.clobTokenIds);
          if (!tokenIds.length) continue;
          const prices = [];
          for (const tokenId of tokenIds.slice(0, 3)) {
            try {
              const priceUrl = `https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`;
              const priceResponse = await fetchWithTimeout(priceUrl, {
                'User-Agent': appConfig.userAgent,
                'Accept': 'application/json'
              }, 8000);
              if (!priceResponse.ok) continue;
              const priceData = await priceResponse.json();
              const price = Number(priceData?.price);
              prices.push(Number.isFinite(price) ? price : null);
            } catch {
              prices.push(null);
            }
          }
          if (prices.length) {
            market.outcomePrices = prices;
          }
        }

        payload.body = JSON.stringify(markets);
        payload.contentType = 'application/json';
      }
    } catch {
      // keep original payload
    }
  }
  return payload;
}

async function buildEnergyMap() {
  if (!process.env.EIA) {
    return { error: 'missing_server_key', message: 'Server EIA key required for energy map.' };
  }

  try {
    const url = new URL('https://api.eia.gov/v2/electricity/retail-sales/data/');
    url.searchParams.set('api_key', process.env.EIA);
    url.searchParams.set('frequency', 'monthly');
    url.searchParams.set('data[0]', 'price');
    url.searchParams.set('facets[sectorid][]', 'RES');
    url.searchParams.set('sort[0][column]', 'period');
    url.searchParams.set('sort[0][direction]', 'desc');
    url.searchParams.set('offset', '0');
    url.searchParams.set('length', '200');

    const response = await fetchWithTimeout(url.toString(), {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    });
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
    return {
      period: rows[0]?.period || '',
      units: rows[0]?.['price-units'] || 'cents/kWh',
      values: latestByState,
      min,
      max
    };
  } catch (err) {
    return { error: 'fetch_failed', message: err.message || 'EIA energy map request failed.' };
  }
}

async function buildEnergyMarket() {
  const symbols = [
    { id: 'wti', symbol: 'cl.f', label: 'WTI Crude' },
    { id: 'gas', symbol: 'ng.f', label: 'Nat Gas' },
    { id: 'gold', symbol: 'xauusd', label: 'Gold' }
  ];
  const results = {};
  for (const entry of symbols) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(entry.symbol)}&f=sd2t2ohlcv&h&e=csv`;
    try {
      const response = await fetchWithFallbacks(url, { 'User-Agent': appConfig.userAgent }, ['jina'], 12000);
      if (!response.ok) continue;
      const text = await response.text();
      const parsed = parseStooqCsv(text);
      if (!parsed) continue;
      results[entry.id] = {
        label: entry.label,
        value: parsed.value,
        delta: parsed.deltaPct,
        url: parsed.url,
        asOf: [parsed.date, parsed.time].filter(Boolean).join(' ').trim(),
        symbol: parsed.symbol
      };
    } catch {
      // ignore
    }
  }
  return {
    fetchedAt: Date.now(),
    items: results
  };
}

async function main() {
  await loadSeedFeedFallbacks();
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(FEED_DIR, { recursive: true });

  const feedPayloads = [];
  const analysisInputs = [];
  for (const feed of feedsConfig.feeds) {
    if (!feed.url && !feed.requiresConfig) continue;
    try {
      const payload = await buildFeedPayload(feed);
      await writeJson(join(FEED_DIR, `${feed.id}.json`), payload);
      feedPayloads.push({ id: feed.id, ok: !payload.error });
      analysisInputs.push({ feed, payload });
    } catch (err) {
      const payload = {
        id: feed.id,
        fetchedAt: Date.now(),
        error: 'fetch_failed',
        message: err.message
      };
      await writeJson(join(FEED_DIR, `${feed.id}.json`), payload);
      feedPayloads.push({ id: feed.id, ok: false });
      analysisInputs.push({ feed, payload });
    }
  }

  const feedsIndex = {
    app: feedsConfig.app,
    feeds: feedsConfig.feeds
  };
  await writeJson(join(OUT_DIR, 'feeds.json'), feedsIndex);

  const energyMap = await buildEnergyMap();
  await writeJson(join(OUT_DIR, 'energy-map.json'), energyMap);

  const energyMarket = await buildEnergyMarket();
  await writeJson(join(OUT_DIR, 'energy-market.json'), energyMarket);

  const analysis = await buildAnalysis(analysisInputs);
  await writeJson(join(OUT_DIR, 'analysis.json'), analysis);

  await writeJson(join(OUT_DIR, 'unavailable.json'), {
    error: 'static_mode',
    message: 'This endpoint requires a server-side proxy in static deployments.'
  });

  await writeJson(join(OUT_DIR, 'build.json'), {
    generatedAt: new Date().toISOString(),
    feeds: feedPayloads
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
