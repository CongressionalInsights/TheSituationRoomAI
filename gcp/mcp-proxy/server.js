import http from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 8080;
const FEEDS_PATH = join(__dirname, 'feeds.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const FALLBACK_PROXIES = (process.env.FALLBACK_PROXIES || 'allorigins,jina')
  .split(',')
  .map((proxy) => proxy.trim())
  .filter(Boolean);

const ACLED_PROXY = process.env.ACLED_PROXY || '';
const DEFAULT_LOOKBACK_DAYS = Number(process.env.DEFAULT_LOOKBACK_DAYS || 30);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

const feedsConfig = JSON.parse(readFileSync(FEEDS_PATH, 'utf8'));
const feeds = Array.isArray(feedsConfig.feeds) ? feedsConfig.feeds : [];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ''
});

function setCors(res, origin) {
  if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
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

function getRequestOrigin(req) {
  const host = req.headers.host;
  if (!host) return '';
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  if (proto) return `${proto}://${host}`;
  return `https://${host}`;
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

function stripSecretsFromUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    ['api_key', 'key', 'token', 'apikey'].forEach((param) => {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, 'REDACTED');
      }
    });
    return parsed.toString();
  } catch {
    return rawUrl.replace(/(api_key=)[^&]+/gi, '$1REDACTED');
  }
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

function formatIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function computeTimespan(start, end) {
  if (!start || !end) return `${DEFAULT_LOOKBACK_DAYS}d`;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${DEFAULT_LOOKBACK_DAYS}d`;
  const ms = Math.abs(endDate - startDate);
  const days = Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  return `${days}d`;
}

function buildUrl(template, params = {}) {
  let url = template;
  Object.entries(params).forEach(([key, value]) => {
    url = url.replaceAll(`{{${key}}}`, encodeURIComponent(value ?? ''));
  });
  return url;
}

function buildFeedUrl(feed, options) {
  const query = options.query || '';
  const start = options.start || '';
  const end = options.end || '';
  const timespan = computeTimespan(start, end);
  let url = buildUrl(feed.url || '', {
    query,
    start: start ? formatIsoDate(start) : '',
    end: end ? formatIsoDate(end) : '',
    timespan,
    key: options.key || ''
  });

  if (feed.supportsQuery && query && !url.includes(encodeURIComponent(query))) {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('query')) parsed.searchParams.set('query', query);
    url = parsed.toString();
  }

  if (start && end && !url.includes(formatIsoDate(start))) {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('start')) parsed.searchParams.set('start', formatIsoDate(start));
    if (!parsed.searchParams.has('end')) parsed.searchParams.set('end', formatIsoDate(end));
    url = parsed.toString();
  }

  if (feed.acledMode && ACLED_PROXY) {
    const endpoint = feed.acledMode === 'aggregated' ? 'aggregated' : 'events';
    url = `${ACLED_PROXY}/${endpoint}`;
  }

  if (options.params && typeof options.params === 'object') {
    const parsed = new URL(url);
    Object.entries(options.params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      parsed.searchParams.set(key, String(value));
    });
    url = parsed.toString();
  }

  return url;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSummary(text = '') {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 500 ? `${cleaned.slice(0, 497)}...` : cleaned;
}

function parseRss(text, feed) {
  let parsed;
  try {
    parsed = xmlParser.parse(text);
  } catch {
    return [];
  }
  if (parsed?.rss?.channel?.item) {
    return ensureArray(parsed.rss.channel.item).map((item) => {
      const title = item.title || 'Untitled';
      const link = item.link || item.guid || '';
      const published = item.pubDate || item['dc:date'] || item.date;
      const summary = normalizeSummary(item.description || item.summary || '');
      return {
        title,
        url: link,
        summary,
        publishedAt: published ? Date.parse(published) : Date.now(),
        source: feed.name,
        category: feed.category
      };
    });
  }

  if (parsed?.feed?.entry) {
    return ensureArray(parsed.feed.entry).map((entry) => {
      const title = entry.title?.['#text'] || entry.title || 'Untitled';
      let link = '';
      const linkValue = entry.link;
      if (Array.isArray(linkValue)) {
        const first = linkValue.find((item) => item.href) || linkValue[0];
        link = first?.href || first?.['@_href'] || first?.['@href'] || '';
      } else if (typeof linkValue === 'object') {
        link = linkValue.href || linkValue['@_href'] || linkValue['@href'] || '';
      } else if (typeof linkValue === 'string') {
        link = linkValue;
      }
      const published = entry.updated || entry.published;
      const summary = normalizeSummary(entry.summary?.['#text'] || entry.summary || entry.content || '');
      return {
        title,
        url: link,
        summary,
        publishedAt: published ? Date.parse(published) : Date.now(),
        source: feed.name,
        category: feed.category
      };
    });
  }
  return [];
}

function parseGenericJsonFeed(data, feed) {
  const list = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data?.articles)
        ? data.articles
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data?.bills)
              ? data.bills
              : Array.isArray(data?.amendments)
                ? data.amendments
                : Array.isArray(data?.committeeReports)
                  ? data.committeeReports
                  : Array.isArray(data?.committeeReports ?? data?.reports)
                    ? (data.committeeReports ?? data.reports)
                    : Array.isArray(data?.hearings)
                      ? data.hearings
                      : Array.isArray(data?.nominations)
                        ? data.nominations
                        : Array.isArray(data?.treaties)
                          ? data.treaties
                          : Array.isArray(data?.congressionalRecord)
                            ? data.congressionalRecord
            : [];

  return list.slice(0, 50).map((entry) => {
    if (typeof entry === 'string') {
      return {
        title: entry,
        url: '',
        summary: '',
        publishedAt: Date.now(),
        source: feed.name,
        category: feed.category
      };
    }
    const title = entry.title || entry.name || entry.headline || entry.label || 'Untitled';
    const url = entry.url || entry.link || entry.permalink || entry.webUrl || '';
    const summary = normalizeSummary(entry.summary || entry.description || entry.body || entry.abstract || '');
    const published = entry.publishedAt || entry.pubDate || entry.date || entry.updatedAt || entry.updated;
    const geo = entry.geo || (entry.latitude && entry.longitude ? { lat: Number(entry.latitude), lon: Number(entry.longitude) } : null);
    return {
      title,
      url,
      summary,
      publishedAt: published ? Date.parse(published) : Date.now(),
      source: entry.source || feed.name,
      category: feed.category,
      geo
    };
  });
}

function normalizeSignals(text, feed) {
  if (!text) return [];
  if (feed.format === 'rss') return parseRss(text, feed);
  if (feed.format === 'json' || feed.format === 'arcgis') {
    try {
      const data = JSON.parse(text);
      return parseGenericJsonFeed(data, feed);
    } catch {
      return [];
    }
  }
  return [];
}

function translateQueryForFeed(feed, query) {
  if (!feed || !query) return query;
  if (feed.id === 'gdelt-doc') return query;
  if (feed.id.startsWith('google-news')) {
    return query.includes('when:') ? query : `${query} when:1d`;
  }
  return query;
}

function includesAny(text, list) {
  return list.some((term) => text.includes(term));
}

function classifyQuery(query = '') {
  const lowered = query.toLowerCase();
  const categories = new Set();
  const tags = new Set();

  if (includesAny(lowered, ['congress', 'senate', 'house', 'bill', 'amendment', 'nomination', 'hearing', 'treaty', 'federal register', 'executive order', 'regulation'])) {
    categories.add('gov');
    tags.add('congress');
  }
  if (includesAny(lowered, ['conflict', 'war', 'battle', 'protest', 'riot', 'violence', 'explosion', 'attack'])) {
    categories.add('security');
    tags.add('conflict');
  }
  if (includesAny(lowered, ['earthquake', 'quake', 'wildfire', 'fire', 'hurricane', 'tornado', 'flood', 'storm', 'volcano'])) {
    categories.add('disaster');
    categories.add('weather');
  }
  if (includesAny(lowered, ['cyber', 'vulnerability', 'vuln', 'cve', 'exploit', 'ransomware'])) {
    categories.add('cyber');
  }
  if (includesAny(lowered, ['air quality', 'pm2.5', 'pollution', 'smoke', 'health advisory'])) {
    categories.add('health');
  }
  if (includesAny(lowered, ['oil', 'gas', 'energy', 'eia', 'brent', 'wti', 'henry hub'])) {
    categories.add('energy');
  }
  if (includesAny(lowered, ['crypto', 'bitcoin', 'ethereum', 'token', 'blockchain'])) {
    categories.add('crypto');
  }
  if (includesAny(lowered, ['research', 'paper', 'preprint', 'arxiv'])) {
    categories.add('research');
  }
  if (includesAny(lowered, ['flight', 'aviation', 'air traffic', 'shipping', 'logistics'])) {
    categories.add('transport');
  }

  return { categories, tags };
}

function scoreFeed(feed, classification, query) {
  let score = 0;
  const hasQuery = Boolean(query && query.trim());
  if (feed.supportsQuery) score += 2;
  if ((feed.tags || []).includes('search')) score += 3;
  if (classification.categories.has(feed.category)) score += 4;
  if (classification.tags.has('congress') && (feed.tags || []).includes('congress')) score += 4;
  if (classification.tags.has('congress') && feed.id.startsWith('congress-')) score += 5;
  if (classification.tags.has('conflict') && (feed.tags || []).includes('conflict')) score += 4;
  if (hasQuery && feed.id === 'gdelt-doc') score += 4;
  if (hasQuery && feed.id === 'google-news-search') score += 4;
  return score;
}

function selectSmartFeeds({ query, categories, sources, maxSources }) {
  if (Array.isArray(sources) && sources.length) {
    return sources
      .map((id) => feeds.find((feed) => feed.id === id))
      .filter(Boolean);
  }

  const classification = classifyQuery(query || '');
  if (Array.isArray(categories) && categories.length) {
    categories.forEach((cat) => classification.categories.add(cat));
  }

  const candidates = feeds.filter((feed) => !feed.mapOnly);
  const scored = candidates
    .map((feed) => ({ feed, score: scoreFeed(feed, classification, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const defaultFallback = feeds.filter((feed) => ['gdelt-doc', 'google-news-search'].includes(feed.id));
  const selected = scored.length ? scored.map(({ feed }) => feed) : defaultFallback;
  const limit = Math.max(1, Number(maxSources) || 12);
  return selected.slice(0, limit);
}

function dedupeSignals(items) {
  const seen = new Set();
  const output = [];
  items.forEach((item) => {
    const key = item.url || `${item.title || ''}|${item.publishedAt || ''}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(item);
  });
  return output;
}

function createItemId(item) {
  const base = `${item.url || ''}|${item.title || ''}|${item.publishedAt || ''}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 12);
}

async function fetchRaw(feed, options) {
  if (!feed?.url) {
    return { error: 'missing_url', message: 'Feed url missing.' };
  }

  const key = options.key || resolveServerKey(feed);
  const url = buildFeedUrl(feed, { ...options, key });
  const { url: keyedUrl, headers } = applyKey(url, feed, key, options.keyParam, options.keyHeader);
  const primaryProxy = feed.proxy || options.proxy || null;
  const attemptList = [null, primaryProxy, ...FALLBACK_PROXIES];
  const seen = new Set();
  const attempts = attemptList.filter((proxy) => {
    const key = proxy || 'direct';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastError = null;
  let response = null;
  let body = null;
  let usedProxy = null;
  let fetchedUrl = null;

  for (const proxy of attempts) {
    const proxiedUrl = proxy ? applyProxy(keyedUrl, proxy) : keyedUrl;
    fetchedUrl = proxiedUrl;
    try {
      response = await fetchWithTimeout(proxiedUrl, {
        headers: {
          ...headers,
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0'
        }
      }, feed.timeoutMs || FETCH_TIMEOUT_MS);
      body = await response.text();
      if (response.ok) {
        usedProxy = proxy || null;
        break;
      }
      lastError = {
        error: 'fetch_failed',
        httpStatus: response.status,
        message: `HTTP ${response.status}`,
        body
      };
    } catch (error) {
      lastError = { error: 'fetch_failed', message: error.message };
    }
  }

  if (!response || !response.ok) {
    return {
      ...lastError,
      fetchedUrl: stripSecretsFromUrl(fetchedUrl),
      proxyUsed: usedProxy,
      fallbackUsed: Boolean(usedProxy && usedProxy !== primaryProxy)
    };
  }

  return {
    body,
    httpStatus: response.status,
    contentType: response.headers.get('content-type') || null,
    fetchedUrl: stripSecretsFromUrl(fetchedUrl),
    proxyUsed: usedProxy,
    fallbackUsed: Boolean(usedProxy && usedProxy !== primaryProxy)
  };
}

const server = new McpServer({
  name: 'Situation Room MCP',
  version: '0.1.0'
});

server.registerTool(
  'catalog.sources',
  {
    title: 'Catalog Sources',
    description: 'List available sources, formats, and capabilities.',
    inputSchema: z.object({
      category: z.string().optional()
    })
  },
  async ({ category }) => {
    const filtered = category
      ? feeds.filter((feed) => feed.category === category)
      : feeds;
    const payload = filtered.map((feed) => ({
      id: feed.id,
      name: feed.name,
      category: feed.category,
      format: feed.format,
      supportsQuery: Boolean(feed.supportsQuery),
      requiresKey: Boolean(feed.requiresKey),
      docsUrl: feed.docsUrl || null,
      urlTemplate: feed.url || null,
      tags: feed.tags || []
    }));
    return {
      content: [{ type: 'text', text: `Sources: ${payload.length}` }],
      structuredContent: { sources: payload }
    };
  }
);

server.registerTool(
  'raw.fetch',
  {
    title: 'Fetch Raw Feed',
    description: 'Fetch raw data from a source. Use params/start/end to request historical ranges where supported.',
    inputSchema: z.object({
      sourceId: z.string(),
      query: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      format: z.enum(['json', 'csv', 'text']).optional()
    })
  },
  async ({ sourceId, query, start, end, params, format }) => {
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = await fetchRaw(feed, { query, start, end, params });
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Fetch failed: ${result.message || result.error}` }],
        structuredContent: { error: result.error, message: result.message, httpStatus: result.httpStatus || null }
      };
    }

    const responseFormat = format || 'text';
    let parsed = null;
    if (responseFormat === 'json') {
      try {
        parsed = JSON.parse(result.body);
      } catch {
        parsed = null;
      }
    }

    return {
      content: [{ type: 'text', text: `Fetched ${sourceId} (${result.httpStatus})` }],
      structuredContent: {
        sourceId,
        contentType: result.contentType,
        url: stripSecretsFromUrl(feed.url),
        fetchedUrl: result.fetchedUrl || null,
        proxyUsed: result.proxyUsed || null,
        fallbackUsed: Boolean(result.fallbackUsed),
        body: responseFormat === 'text' || responseFormat === 'csv' ? result.body : undefined,
        data: parsed
      }
    };
  }
);

server.registerTool(
  'raw.history',
  {
    title: 'Fetch Raw History',
    description: 'Fetch raw history for a source with start/end range when available.',
    inputSchema: z.object({
      sourceId: z.string(),
      start: z.string(),
      end: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      format: z.enum(['json', 'csv', 'text']).optional()
    })
  },
  async ({ sourceId, start, end, params, format }) => {
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = await fetchRaw(feed, { start, end, params });
    if (result.error) {
      return {
        content: [{ type: 'text', text: `History fetch failed: ${result.message || result.error}` }],
        structuredContent: { error: result.error, message: result.message, httpStatus: result.httpStatus || null }
      };
    }

    const responseFormat = format || 'text';
    let parsed = null;
    if (responseFormat === 'json') {
      try {
        parsed = JSON.parse(result.body);
      } catch {
        parsed = null;
      }
    }

    return {
      content: [{ type: 'text', text: `Fetched history for ${sourceId}` }],
      structuredContent: {
        sourceId,
        range: { start, end },
        contentType: result.contentType,
        url: stripSecretsFromUrl(feed.url),
        fetchedUrl: result.fetchedUrl || null,
        proxyUsed: result.proxyUsed || null,
        fallbackUsed: Boolean(result.fallbackUsed),
        body: responseFormat === 'text' || responseFormat === 'csv' ? result.body : undefined,
        data: parsed
      }
    };
  }
);

server.registerTool(
  'signals.list',
  {
    title: 'List Normalized Signals',
    description: 'Return normalized signal items for a source (best-effort parsing).',
    inputSchema: z.object({
      sourceId: z.string(),
      query: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      limit: z.number().optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    })
  },
  async ({ sourceId, query, start, end, limit, params }) => {
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = await fetchRaw(feed, { query, start, end, params });
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Signals fetch failed: ${result.message || result.error}` }],
        structuredContent: { error: result.error, message: result.message, httpStatus: result.httpStatus || null }
      };
    }

    const items = normalizeSignals(result.body, feed).map((item) => ({
      ...item,
      id: createItemId(item),
      sourceId,
      source: item.source || feed.name
    }));
    const sliced = Number.isFinite(limit) ? items.slice(0, Math.max(1, limit)) : items;

    const warning = result.fallbackUsed
      ? `Fetched via proxy (${result.proxyUsed || 'unknown'}).`
      : null;
    return {
      content: [{ type: 'text', text: `Signals: ${sliced.length}` }],
      structuredContent: {
        sourceId,
        items: sliced,
        fetchedUrl: result.fetchedUrl || null,
        proxyUsed: result.proxyUsed || null,
        fallbackUsed: Boolean(result.fallbackUsed),
        warning
      }
    };
  }
);

server.registerTool(
  'signals.get',
  {
    title: 'Get Normalized Signal',
    description: 'Return a single normalized signal item by id.',
    inputSchema: z.object({
      sourceId: z.string(),
      id: z.string(),
      query: z.string().optional()
    })
  },
  async ({ sourceId, id, query }) => {
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = await fetchRaw(feed, { query });
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Signal fetch failed: ${result.message || result.error}` }],
        structuredContent: { error: result.error, message: result.message, httpStatus: result.httpStatus || null }
      };
    }

    const items = normalizeSignals(result.body, feed).map((item) => ({
      ...item,
      id: createItemId(item),
      sourceId,
      source: item.source || feed.name
    }));
    const match = items.find((item) => item.id === id) || null;

    const warning = result.fallbackUsed
      ? `Fetched via proxy (${result.proxyUsed || 'unknown'}).`
      : null;
    return {
      content: [{ type: 'text', text: match ? `Signal ${id}` : `Signal ${id} not found` }],
      structuredContent: {
        sourceId,
        item: match,
        fetchedUrl: result.fetchedUrl || null,
        proxyUsed: result.proxyUsed || null,
        fallbackUsed: Boolean(result.fallbackUsed),
        warning
      }
    };
  }
);

server.registerTool(
  'search.smart',
  {
    title: 'Smart Search Signals',
    description: 'Search across relevant sources using the Situation Room smart search logic. Returns normalized signals only.',
    inputSchema: z.object({
      query: z.string().optional(),
      categories: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      maxSources: z.number().optional(),
      perSourceLimit: z.number().optional(),
      totalLimit: z.number().optional()
    })
  },
  async ({ query, categories, sources, start, end, maxSources, perSourceLimit, totalLimit }) => {
    const selectedFeeds = selectSmartFeeds({ query, categories, sources, maxSources });
    const perLimit = Math.max(1, Number(perSourceLimit) || 25);

    const signals = [];
    const sourcesChecked = [];
    const warnings = [];

    for (const feed of selectedFeeds) {
      const translatedQuery = feed.supportsQuery ? translateQueryForFeed(feed, query || feed.defaultQuery || '') : undefined;
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchRaw(feed, { query: translatedQuery, start, end });
      if (result.error) {
        sourcesChecked.push({
          sourceId: feed.id,
          sourceName: feed.name,
          ok: false,
          error: result.error,
          message: result.message || null,
          httpStatus: result.httpStatus || null,
          fetchedUrl: result.fetchedUrl || null,
          proxyUsed: result.proxyUsed || null,
          fallbackUsed: Boolean(result.fallbackUsed)
        });
        continue;
      }

      const items = normalizeSignals(result.body, feed).map((item) => ({
        ...item,
        id: createItemId(item),
        sourceId: feed.id,
        sourceName: feed.name,
        tags: feed.tags || []
      }));

      if (result.fallbackUsed) {
        warnings.push(`Fetched ${feed.name} via proxy (${result.proxyUsed || 'unknown'}).`);
      }

      sourcesChecked.push({
        sourceId: feed.id,
        sourceName: feed.name,
        ok: true,
        count: items.length,
        fetchedUrl: result.fetchedUrl || null,
        proxyUsed: result.proxyUsed || null,
        fallbackUsed: Boolean(result.fallbackUsed)
      });

      signals.push(...items.slice(0, perLimit));
    }

    const deduped = dedupeSignals(signals);
    const total = Number.isFinite(totalLimit) ? Math.max(1, Number(totalLimit)) : null;
    const finalSignals = total ? deduped.slice(0, total) : deduped;

    return {
      content: [{ type: 'text', text: `Signals: ${finalSignals.length}` }],
      structuredContent: {
        query: query || null,
        range: start && end ? { start, end } : null,
        signals: finalSignals,
        sourcesChecked,
        warnings: warnings.length ? warnings : null
      }
    };
  }
);

const httpServer = http.createServer(async (req, res) => {
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

  if (url.pathname === '/.well-known/mcp.json') {
    const originUrl = getRequestOrigin(req) || url.origin;
    return sendJson(res, 200, {
      name: 'Situation Room MCP',
      description: 'Public read-only MCP interface for Situation Room data sources.',
      endpoint: `${originUrl}/mcp`,
      tools: ['catalog.sources', 'raw.fetch', 'raw.history', 'signals.list', 'signals.get', 'search.smart']
    }, origin);
  }

  if (url.pathname === '/mcp') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        message: 'MCP endpoint accepts POST JSON-RPC requests only.',
        example: {
          method: 'tools/list',
          request: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
          }
        }
      }, origin);
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, origin);
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return sendJson(res, 400, { error: 'invalid_json', message: error.message }, origin);
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

httpServer.listen(PORT, () => {
  console.log(`MCP proxy listening on ${PORT}`);
});
