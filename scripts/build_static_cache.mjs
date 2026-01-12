import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';

const ROOT = process.cwd();
const FEEDS_PATH = join(ROOT, 'data', 'feeds.json');
const OUT_DIR = join(ROOT, 'public', 'data');
const FEED_DIR = join(OUT_DIR, 'feeds');
const TIMEOUT_MS = 12000;

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

async function fetchWithTimeout(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallbacks(url, headers, proxies = []) {
  let primaryResponse = null;
  try {
    primaryResponse = await fetchWithTimeout(url, headers);
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
      const response = await fetchWithTimeout(fallbackUrl, headers);
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

async function writeJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
}

async function buildFeedPayload(feed) {
  if (feed.requiresConfig && !feed.url) {
    return { id: feed.id, fetchedAt: Date.now(), error: 'requires_config', message: 'Feed URL not configured.' };
  }

  const key = feed.requiresKey ? resolveServerKey(feed) : null;
  if (feed.requiresKey && !key) {
    return {
      id: feed.id,
      fetchedAt: Date.now(),
      error: feed.keySource === 'server' ? 'missing_server_key' : 'requires_key',
      message: feed.keySource === 'server' ? 'Server API key required for this feed.' : 'API key required for this feed.'
    };
  }

  const query = feed.supportsQuery ? (feed.defaultQuery || '') : undefined;
  const baseUrl = feed.supportsQuery ? buildUrl(feed.url, { query, key }) : buildUrl(feed.url, { key });
  const applied = applyKey(baseUrl, feed, key);
  const headers = {
    'User-Agent': appConfig.userAgent,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...applied.headers
  };

  const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
  const response = await fetchWithFallbacks(applied.url, headers, proxyList);
  const contentType = response.headers.get('content-type') || 'text/plain';
  const body = await response.text();

  return {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: response.status
  };
}

async function buildEnergyMap() {
  if (!process.env.EIA) {
    return { error: 'missing_server_key', message: 'Server EIA key required for energy map.' };
  }

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
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(FEED_DIR, { recursive: true });

  const feedPayloads = [];
  for (const feed of feedsConfig.feeds) {
    if (!feed.url && !feed.requiresConfig) continue;
    try {
      const payload = await buildFeedPayload(feed);
      await writeJson(join(FEED_DIR, `${feed.id}.json`), payload);
      feedPayloads.push({ id: feed.id, ok: !payload.error });
    } catch (err) {
      const payload = {
        id: feed.id,
        fetchedAt: Date.now(),
        error: 'fetch_failed',
        message: err.message
      };
      await writeJson(join(FEED_DIR, `${feed.id}.json`), payload);
      feedPayloads.push({ id: feed.id, ok: false });
    }
  }

  const feedsIndex = {
    app: feedsConfig.app,
    feeds: feedsConfig.feeds
  };
  await writeJson(join(OUT_DIR, 'feeds.json'), feedsIndex);

  const energyMap = await buildEnergyMap();
  await writeJson(join(OUT_DIR, 'energy-map.json'), energyMap);

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
