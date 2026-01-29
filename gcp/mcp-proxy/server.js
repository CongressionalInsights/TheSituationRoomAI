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
const MONEY_FLOW_DEFAULT_DAYS = 180;
const MONEY_FLOW_MAX_LIMIT = 120;
const MONEY_FLOW_TIMEOUT_MS = 45000;
const SAM_RETRY_ATTEMPTS = 3;
const SAM_RETRY_BASE_DELAY_MS = 900;
const SAM_CACHE_TTL_MS = 10 * 60 * 1000;
const SAM_CACHE_ERROR_TTL_MS = 2 * 60 * 1000;

const samCache = new Map();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSamEntities({ query, perSourceLimit, samGovKey }) {
  if (!samGovKey) {
    return { error: 'missing_key' };
  }
  const cacheKey = `sam:${perSourceLimit}:${String(query || '').toLowerCase().trim()}`;
  const cached = samCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    return cached.payload;
  }
  const url = new URL('https://api.sam.gov/entity-information/v4/entities');
  url.searchParams.set('api_key', samGovKey);
  url.searchParams.set('q', query);
  url.searchParams.set('page', '1');
  url.searchParams.set('size', String(perSourceLimit));

  for (let attempt = 1; attempt <= SAM_RETRY_ATTEMPTS; attempt += 1) {
    const { response, data } = await fetchJsonWithTimeout(url.toString(), {
      headers: { 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0', 'Accept': 'application/json' }
    }, MONEY_FLOW_TIMEOUT_MS);
    if (response.ok && data) {
      const payload = { items: data?.entityData || [] };
      samCache.set(cacheKey, { fetchedAt: Date.now(), ttlMs: SAM_CACHE_TTL_MS, payload });
      return payload;
    }
    if (response.status === 429 && attempt < SAM_RETRY_ATTEMPTS) {
      const delay = SAM_RETRY_BASE_DELAY_MS * attempt;
      await sleep(delay);
      continue;
    }
    const payload = { error: `HTTP ${response.status}` };
    samCache.set(cacheKey, { fetchedAt: Date.now(), ttlMs: SAM_CACHE_ERROR_TTL_MS, payload });
    return payload;
  }
  const payload = { error: 'rate_limited' };
  samCache.set(cacheKey, { fetchedAt: Date.now(), ttlMs: SAM_CACHE_ERROR_TTL_MS, payload });
  return payload;
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

function parseDateParam(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function resolveMoneyFlowRange(start, end, fallbackDays = MONEY_FLOW_DEFAULT_DAYS) {
  const endDate = parseDateParam(end) || new Date();
  const startDate = parseDateParam(start) || new Date(endDate);
  if (!parseDateParam(start)) {
    startDate.setDate(endDate.getDate() - fallbackDays);
  }
  const startIso = formatIsoDate(startDate);
  const endIso = formatIsoDate(endDate);
  const years = [];
  for (let year = startDate.getFullYear(); year <= endDate.getFullYear(); year += 1) {
    years.push(year);
  }
  return { startDate, endDate, startIso, endIso, years };
}

function normalizeEntityName(value) {
  if (!value) return '';
  return String(value)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesQuery(query, ...fields) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => String(field || '').toLowerCase().includes(needle));
}

function scoreMoneyItem(item) {
  let score = 0;
  const amount = Number.isFinite(item.amount) ? item.amount : 0;
  if (amount > 0) {
    score += Math.min(50, Math.log10(amount + 1) * 15);
  }
  const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
  if (publishedAt && !Number.isNaN(publishedAt.getTime())) {
    const ageDays = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 30) score += 20;
    else if (ageDays <= 90) score += 12;
    else if (ageDays <= 180) score += 6;
  }
  const sourceBoost = {
    LDA: 18,
    USAspending: 20,
    OpenFEC: 20,
    'SAM.gov': 10
  };
  score += sourceBoost[item.source] || 8;
  if (item.type && /registration|filing/i.test(item.type)) score += 4;
  if (item.type && /contribution|donation/i.test(item.type)) score += 6;
  return Math.round(Math.min(100, score));
}

function buildUsaspendingUrl(awardId) {
  if (!awardId) return 'https://www.usaspending.gov';
  return `https://www.usaspending.gov/award/${encodeURIComponent(awardId)}`;
}

function buildFecUrl(item, query) {
  const base = 'https://www.fec.gov/data/receipts/individual-contributions/';
  const params = new URLSearchParams();
  if (item?.sub_id) params.set('sub_id', String(item.sub_id));
  if (item?.committee?.committee_id || item?.committee_id) {
    params.set('committee_id', item.committee?.committee_id || item.committee_id);
  }
  if (item?.contributor_name) params.set('contributor_name', item.contributor_name);
  if (item?.contribution_receipt_date) {
    params.set('two_year_transaction_period', String(new Date(item.contribution_receipt_date).getFullYear()));
  }
  if (!params.toString() && query) params.set('contributor_name', query);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function buildLdaFilingUrl(filingId) {
  if (!filingId) return 'https://lda.senate.gov';
  return `https://lda.senate.gov/filings/public/filing/${encodeURIComponent(filingId)}`;
}

function buildSamUrl(uei, entityName) {
  if (uei) return `https://sam.gov/entity/${encodeURIComponent(uei)}`;
  const params = new URLSearchParams();
  params.set('index', 'entity');
  params.set('page', '1');
  params.set('sort', '-relevance');
  if (entityName) params.set('keyword', entityName);
  return `https://sam.gov/search/?${params.toString()}`;
}

function summarizeMoneyEntities(items) {
  const totals = new Map();
  items.forEach((item) => {
    const name = normalizeEntityName(item.entity || item.recipient || item.committee || item.contributor || '');
    if (!name) return;
    const current = totals.get(name) || { name, amount: 0, count: 0, sample: item.entity || item.recipient || item.committee || item.contributor };
    current.count += 1;
    if (Number.isFinite(item.amount)) current.amount += item.amount;
    totals.set(name, current);
  });
  return [...totals.values()]
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 8);
}

function summarizeBy(items, keyFn, amountFn = (item) => item.amount) {
  const totals = new Map();
  items.forEach((item) => {
    const raw = keyFn(item);
    const name = normalizeEntityName(raw || '');
    if (!name) return;
    const current = totals.get(name) || { name, amount: 0, count: 0, sample: raw };
    current.count += 1;
    const amount = amountFn(item);
    if (Number.isFinite(amount)) current.amount += amount;
    totals.set(name, current);
  });
  return [...totals.values()].sort((a, b) => (b.amount || 0) - (a.amount || 0));
}

function summarizeMoneyBuckets(items) {
  const buckets = {
    contributions: { count: 0, totalAmount: 0 },
    spending: { count: 0, totalAmount: 0 },
    lobbying: { count: 0, totalAmount: 0 },
    registry: { count: 0, totalAmount: 0 }
  };
  items.forEach((item) => {
    const bucket = item.bucket;
    if (!bucket || !buckets[bucket]) return;
    buckets[bucket].count += 1;
    if (Number.isFinite(item.amount)) buckets[bucket].totalAmount += item.amount;
  });
  return buckets;
}

function summarizeMoneyTop(items) {
  const byBucket = (bucket) => items.filter((item) => item.bucket === bucket);
  const contributions = byBucket('contributions');
  const spending = byBucket('spending');
  const lobbying = byBucket('lobbying');
  const registry = byBucket('registry');

  const topDonors = summarizeBy(contributions, (item) => item.donor);
  const topRecipients = summarizeBy(contributions, (item) => item.recipient);
  const topSpendingRecipients = summarizeBy(spending, (item) => item.recipient);
  const topLobbyClients = summarizeBy(lobbying, (item) => item.client);
  const topLobbyRegistrants = summarizeBy(lobbying, (item) => item.registrant);
  const topRegistry = summarizeBy(registry, (item) => item.registryEntity || item.entity);

  return {
    contributions: {
      donor: topDonors[0]?.name || null,
      donorAmount: topDonors[0]?.amount || 0,
      recipient: topRecipients[0]?.name || null,
      recipientAmount: topRecipients[0]?.amount || 0
    },
    spending: {
      recipient: topSpendingRecipients[0]?.name || null,
      recipientAmount: topSpendingRecipients[0]?.amount || 0
    },
    lobbying: {
      client: topLobbyClients[0]?.name || null,
      clientAmount: topLobbyClients[0]?.amount || 0,
      registrant: topLobbyRegistrants[0]?.name || null,
      registrantAmount: topLobbyRegistrants[0]?.amount || 0
    },
    registry: {
      entity: topRegistry[0]?.name || null,
      entityAmount: topRegistry[0]?.amount || 0
    }
  };
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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, data, text };
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

async function fetchMoneyFlows({ query, start, end, limit }) {
  if (!query) {
    return { error: 'missing_query', message: 'Query parameter q is required.' };
  }
  const safeLimit = Math.min(MONEY_FLOW_MAX_LIMIT, Math.max(20, Number(limit) || 60));
  const perSourceLimit = Math.max(10, Math.floor(safeLimit / 4));
  const range = resolveMoneyFlowRange(start, end);
  const dataGovKey = process.env.DATA_GOV || '';
  const fecKey = dataGovKey || 'DEMO_KEY';
  const samGovKey = process.env.SAMGOV_API_KEY || dataGovKey;

  const results = {
    query,
    range: { start: range.startIso, end: range.endIso },
    generatedAt: new Date().toISOString(),
    sources: {},
    items: [],
    entities: [],
    summary: null
  };

  const ldaTasks = range.years.map(async (year) => {
    const url = `https://lda.senate.gov/api/v1/filings/?filing_year=${encodeURIComponent(year)}`;
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0', 'Accept': 'application/json' }
    }, MONEY_FLOW_TIMEOUT_MS);
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    const items = (data.results || []).filter((item) => matchesQuery(query,
      item.client?.name,
      item.registrant?.name,
      item.lobbying_activities?.map((act) => act.description).join(' ')
    ));
    return { items };
  });

  const ldaContribTasks = range.years.map(async (year) => {
    const url = `https://lda.senate.gov/api/v1/contributions/?filing_year=${encodeURIComponent(year)}`;
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0', 'Accept': 'application/json' }
    }, MONEY_FLOW_TIMEOUT_MS);
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    const items = (data.results || []).filter((item) => matchesQuery(query,
      item.registrant?.name,
      item.lobbyist?.last_name,
      item.contribution_items?.map((entry) => `${entry.contributor_name} ${entry.payee_name}`).join(' ')
    ));
    return { items };
  });

  const usaTask = (async () => {
    const url = 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/';
    const awardCodes = ['A', 'B', 'C', 'D', 'IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'];
    const payload = {
      filters: {
        keywords: [query],
        time_period: [{ start_date: range.startIso, end_date: range.endIso }],
        award_type_codes: awardCodes
      },
      fields: ['Recipient Name', 'Award ID', 'Action Date', 'Transaction Amount', 'Awarding Agency', 'Transaction Description'],
      limit: perSourceLimit,
      page: 1,
      sort: 'Action Date',
      order: 'desc'
    };
    const { response, data } = await fetchJsonWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0' },
      body: JSON.stringify(payload)
    }, MONEY_FLOW_TIMEOUT_MS);
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    return { items: data.results || [] };
  })();

  const fecTask = (async () => {
    const url = new URL('https://api.open.fec.gov/v1/schedules/schedule_a/');
    url.searchParams.set('api_key', fecKey);
    url.searchParams.set('per_page', String(perSourceLimit));
    url.searchParams.set('sort', '-contribution_receipt_amount');
    url.searchParams.set('contributor_name', query);
    url.searchParams.set('min_date', range.startIso);
    url.searchParams.set('max_date', range.endIso);
    const { response, data } = await fetchJsonWithTimeout(url.toString(), {
      headers: { 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0', 'Accept': 'application/json' }
    }, MONEY_FLOW_TIMEOUT_MS);
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    return { items: data.results || [] };
  })();

  const samTask = fetchSamEntities({
    query,
    perSourceLimit,
    samGovKey
  });

  const [ldaSettled, ldaContribSettled, usaSettled, fecSettled, samSettled] = await Promise.allSettled([
    Promise.all(ldaTasks),
    Promise.all(ldaContribTasks),
    usaTask,
    fecTask,
    samTask
  ]);

  const ldaResults = ldaSettled.status === 'fulfilled' ? ldaSettled.value : [];
  const ldaContribResults = ldaContribSettled.status === 'fulfilled' ? ldaContribSettled.value : [];
  const usaResult = usaSettled.status === 'fulfilled'
    ? usaSettled.value
    : { items: [], error: usaSettled.reason?.message || 'fetch_failed' };
  const fecResult = fecSettled.status === 'fulfilled'
    ? fecSettled.value
    : { items: [], error: fecSettled.reason?.message || 'fetch_failed' };
  const samResult = samSettled.status === 'fulfilled'
    ? samSettled.value
    : { items: [], error: samSettled.reason?.message || 'fetch_failed' };

  const ldaErrors = ldaSettled.status === 'rejected'
    ? (ldaSettled.reason?.message || 'fetch_failed')
    : (ldaResults.find((entry) => entry.error)?.error || null);
  const ldaContribErrors = ldaContribSettled.status === 'rejected'
    ? (ldaContribSettled.reason?.message || 'fetch_failed')
    : (ldaContribResults.find((entry) => entry.error)?.error || null);

  results.sources.lda = {
    count: ldaResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: ldaErrors || null
  };
  results.sources.ldaContributions = {
    count: ldaContribResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: ldaContribErrors || null
  };
  results.sources.usaspending = {
    count: usaResult.items?.length || 0,
    error: usaResult.error || null
  };
  results.sources.fec = {
    count: fecResult.items?.length || 0,
    error: fecResult.error || null
  };
  results.sources.sam = {
    count: samResult.items?.length || 0,
    error: samResult.error || null
  };

  const items = [];

  ldaResults.flatMap((entry) => entry.items || []).forEach((item) => {
    const amount = toNumber(item.income) || 0;
    const filingId = item.filing_uuid || item.id;
    const registrant = item.registrant?.name || 'Unknown';
    const client = item.client?.name || 'Lobbying Filing';
    const canonicalUrl = buildLdaFilingUrl(filingId);
    items.push({
      source: 'LDA',
      sourceId: filingId,
      type: 'Lobbying Filing',
      title: client,
      summary: `Registrant: ${registrant} · Filed ${item.filing_year || ''}`,
      amount,
      bucket: 'lobbying',
      donor: null,
      entity: client,
      recipient: registrant,
      client,
      registrant,
      committee: null,
      registryEntity: null,
      publishedAt: item.filing_deadline || item.dt_posted || item.filing_date || new Date().toISOString(),
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Client', value: client },
        { label: 'Registrant', value: registrant },
        { label: 'Filing year', value: item.filing_year || '—' },
        { label: 'Income', value: amount ? `$${amount.toLocaleString('en-US')}` : '—' }
      ],
      detailLinkLabel: 'Open LDA filing'
    });
  });

  ldaContribResults.flatMap((entry) => entry.items || []).forEach((item) => {
    const contribution = item.contribution_items?.[0];
    const amount = toNumber(contribution?.amount) || 0;
    const filingId = item.filing_uuid || item.filing_id || item.id;
    const contributor = contribution?.contributor_name || 'Unknown';
    const payee = contribution?.payee_name || item.registrant?.name || 'Lobbying Contribution';
    const canonicalUrl = buildLdaFilingUrl(filingId);
    items.push({
      source: 'LDA',
      sourceId: item.contribution_id || filingId,
      type: 'Lobbying Contribution',
      title: payee,
      summary: `Contributor: ${contributor} · Filed ${item.filing_year || ''}`,
      amount,
      bucket: 'contributions',
      donor: contributor,
      entity: contributor,
      recipient: payee,
      client: null,
      registrant: item.registrant?.name || null,
      committee: null,
      registryEntity: null,
      publishedAt: contribution?.date || item.filing_deadline || item.filing_date || new Date().toISOString(),
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Contributor', value: contributor },
        { label: 'Payee', value: payee },
        { label: 'Filing year', value: item.filing_year || '—' },
        { label: 'Amount', value: amount ? `$${amount.toLocaleString('en-US')}` : '—' }
      ],
      detailLinkLabel: 'Open LDA filing'
    });
  });

  (usaResult.items || []).forEach((item) => {
    const amount = toNumber(item['Transaction Amount']);
    const awardId = item['Award ID'];
    const recipient = item['Recipient Name'] || awardId || 'Federal Award';
    const agency = item['Awarding Agency'] || 'Agency';
    const canonicalUrl = buildUsaspendingUrl(awardId);
    items.push({
      source: 'USAspending',
      sourceId: awardId,
      type: 'Federal Award',
      title: recipient,
      summary: `${agency} · ${item['Transaction Description'] || 'Award'}`,
      amount,
      bucket: 'spending',
      donor: agency,
      entity: recipient,
      recipient,
      client: null,
      registrant: null,
      committee: null,
      registryEntity: null,
      publishedAt: item['Action Date'] || new Date().toISOString(),
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Award ID', value: awardId || '—' },
        { label: 'Recipient', value: recipient || '—' },
        { label: 'Agency', value: agency || '—' },
        { label: 'Action date', value: item['Action Date'] || '—' },
        { label: 'Amount', value: amount ? `$${amount.toLocaleString('en-US')}` : '—' }
      ],
      detailLinkLabel: 'Open USAspending record'
    });
  });

  (fecResult.items || []).forEach((item) => {
    const amount = toNumber(item.contribution_receipt_amount);
    const committee = item.committee?.name || item.committee_name || 'Campaign Committee';
    const contributor = item.contributor_name || 'Contributor';
    const canonicalUrl = buildFecUrl(item, query);
    items.push({
      source: 'OpenFEC',
      sourceId: item.sub_id || item.contribution_receipt_id,
      type: 'Campaign Contribution',
      title: committee,
      summary: `${contributor} · ${item.contributor_employer || item.contributor_occupation || 'Employer unknown'}`,
      amount,
      bucket: 'contributions',
      donor: contributor,
      entity: contributor,
      committee,
      recipient: committee,
      client: null,
      registrant: null,
      registryEntity: null,
      publishedAt: item.contribution_receipt_date || new Date().toISOString(),
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Contributor', value: contributor },
        { label: 'Committee', value: committee },
        { label: 'Amount', value: amount ? `$${amount.toLocaleString('en-US')}` : '—' },
        { label: 'Date', value: item.contribution_receipt_date || '—' },
        { label: 'Employer', value: item.contributor_employer || '—' }
      ],
      detailLinkLabel: 'Open FEC record'
    });
  });

  (samResult.items || []).forEach((item) => {
    const amount = toNumber(item.totalActiveContracts);
    const entityName = item.entityRegistration?.legalBusinessName || item.entityRegistration?.dbaName || item.entityRegistration?.entityEFTIndicator;
    const uei = item.entityRegistration?.ueiSAM || item.entityRegistration?.uei || item.entityRegistration?.ueiSAM || '';
    const canonicalUrl = buildSamUrl(uei, entityName);
    items.push({
      source: 'SAM.gov',
      sourceId: uei || item.entityRegistration?.cageCode,
      type: 'SAM Entity',
      title: entityName || 'SAM Entity',
      summary: `${item.entityRegistration?.entityStatus || 'Entity'} · ${item.entityRegistration?.stateOrProvinceCode || ''}`,
      amount,
      bucket: 'registry',
      donor: null,
      entity: entityName,
      recipient: null,
      client: null,
      registrant: null,
      committee: null,
      registryEntity: entityName,
      publishedAt: item.entityRegistration?.lastUpdateDate || new Date().toISOString(),
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'UEI', value: uei || '—' },
        { label: 'Status', value: item.entityRegistration?.entityStatus || '—' },
        { label: 'State', value: item.entityRegistration?.stateOrProvinceCode || '—' },
        { label: 'Last update', value: item.entityRegistration?.lastUpdateDate || '—' },
        { label: 'CAGE', value: item.entityRegistration?.cageCode || '—' }
      ],
      detailLinkLabel: 'Open SAM record'
    });
  });

  results.items = items
    .map((item) => ({
      ...item,
      score: scoreMoneyItem(item)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);

  results.entities = summarizeMoneyEntities(results.items);
  const buckets = summarizeMoneyBuckets(results.items);
  const top = summarizeMoneyTop(results.items);
  results.summary = {
    totalItems: results.items.length,
    buckets,
    top
  };

  return results;
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
  'money.flows',
  {
    title: 'Money Flows',
    description: 'Aggregate LDA, USAspending, OpenFEC, and SAM.gov signals with scoring.',
    inputSchema: z.object({
      query: z.string(),
      start: z.string().optional(),
      end: z.string().optional(),
      limit: z.number().optional()
    })
  },
  async ({ query, start, end, limit }) => {
    const payload = await fetchMoneyFlows({ query, start, end, limit });
    if (payload?.error) {
      return {
        content: [{ type: 'text', text: `Money flows fetch failed: ${payload.message || payload.error}` }],
        structuredContent: { error: payload.error, message: payload.message || null }
      };
    }
    return {
      content: [{ type: 'text', text: `Money flows: ${payload.items?.length || 0} items` }],
      structuredContent: payload
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
      tools: ['catalog.sources', 'raw.fetch', 'raw.history', 'money.flows', 'signals.list', 'signals.get', 'search.smart']
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
