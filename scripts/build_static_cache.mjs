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
  const response = await fetchWithFallbacks(applied.url, headers, proxyList, feed.timeoutMs || TIMEOUT_MS);
  const contentType = response.headers.get('content-type') || 'text/plain';
  const body = await response.text();
  const payload = {
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
