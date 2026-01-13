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
  let primaryResponse = null;
  try {
    primaryResponse = await fetchWithTimeout(url, headers, timeoutMs);
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
      const response = await fetchWithTimeout(fallbackUrl, headers, timeoutMs);
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
    return { id: feed.id, fetchedAt: Date.now(), error: 'requires_config', message: 'Feed URL not configured.' };
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
  const baseUrl = feed.supportsQuery ? buildUrl(feed.url, { query, key }) : buildUrl(feed.url, { key });
  const applied = applyKey(baseUrl, feed, key);
  const headers = {
    'User-Agent': appConfig.userAgent,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...applied.headers
  };

  const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
  const response = await fetchWithFallbacks(applied.url, headers, proxyList, feed.timeoutMs || TIMEOUT_MS);
  const contentType = response.headers.get('content-type') || 'text/plain';
  const body = await response.text();
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
