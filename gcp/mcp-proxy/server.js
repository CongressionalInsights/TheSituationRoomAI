import http from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mergeFeedParams, normalizeJurisdictionCode, sanitizeParamsObject, US_STATE_CODES } from './state-signals.js';
import { normalizeCsvSignals, normalizeJsonSignals } from './signal-normalization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 8080;
const FEEDS_PATH = join(__dirname, 'feeds.json');
const MONEY_ENTITY_ALIASES_PATH = process.env.MONEY_ENTITY_ALIASES_PATH || join(__dirname, 'entity-aliases.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const FALLBACK_PROXIES = (process.env.FALLBACK_PROXIES || 'allorigins,jina')
  .split(',')
  .map((proxy) => proxy.trim())
  .filter(Boolean);
const DEFAULT_LIVE_BASE = 'https://congressionalinsights.github.io/TheSituationRoomAI';
const LIVE_BASE = process.env.SR_LIVE_BASE || DEFAULT_LIVE_BASE;
const OPENSKY_CLIENTID = String(process.env.OPENSKY_CLIENTID || '').trim();
const OPENSKY_CLIENTSECRET = String(process.env.OPENSKY_CLIENTSECRET || '').trim();
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const ACLED_PROXY = process.env.ACLED_PROXY || '';
const DEFAULT_LOOKBACK_DAYS = Number(process.env.DEFAULT_LOOKBACK_DAYS || 30);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const MONEY_FLOW_DEFAULT_DAYS = 180;
const MONEY_FLOW_MAX_LIMIT = 120;
const MONEY_FLOW_TIMEOUT_MS = 45000;
const MONEY_QUERY_VARIANT_LIMIT = 8;
const MONEY_MATCH_THRESHOLDS = {
  strict: 0.9,
  normal: 0.66,
  loose: 0.5
};
const SAM_RETRY_ATTEMPTS = 3;
const SAM_RETRY_BASE_DELAY_MS = 900;
const SAM_CACHE_TTL_MS = 10 * 60 * 1000;
const SAM_CACHE_ERROR_TTL_MS = 2 * 60 * 1000;
const STATE_LEGISLATION_ALL_STATES_CONCURRENCY = 2;
const STATE_LEGISLATION_ALL_STATES_TIMEOUT_MS = 4500;
const STATE_LEGISLATION_ALL_STATES_PER_STATE = 3;
const STATE_LEGISLATION_ALL_STATES_MAX_ATTEMPTS = 8;
const STATE_CONNECTOR_BASE_URL = String(process.env.STATE_CONNECTOR_BASE_URL || '').trim().replace(/\/+$/, '');
const STATE_CONNECTOR_API_KEY = String(process.env.STATE_CONNECTOR_API_KEY || '').trim();
const STATE_CONNECTOR_KEY_HEADER = String(process.env.STATE_CONNECTOR_KEY_HEADER || 'X-API-Key').trim() || 'X-API-Key';
const STATE_CONNECTOR_DEFAULT_LIMIT = 20;
const STATE_CONNECTOR_MAX_LIMIT = 100;
const STATE_CONNECTOR_COVERED_STATES = ['CA', 'FL', 'MN', 'NY', 'TX', 'VA'];

const samCache = new Map();
let openSkyToken = null;
let openSkyTokenExpiresAt = 0;

const ENTITY_SUFFIX_TOKENS = new Set([
  'CO',
  'COMPANY',
  'CORP',
  'CORPORATION',
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'LTD',
  'PLC',
  'THE'
]);

const feedsConfig = JSON.parse(readFileSync(FEEDS_PATH, 'utf8'));
const feeds = Array.isArray(feedsConfig.feeds) ? feedsConfig.feeds : [];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ''
});

// MCP transport is initialized after the McpServer is fully configured.
// Note: we build a fresh MCP server per request (Congress.gov APIs can be brittle and
// the MCP SDK expects a separate Protocol instance per connection).

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

function logRequest(req, res, start) {
  const status = res.statusCode || 0;
  const log = {
    severity: status >= 500 ? 'ERROR' : 'INFO',
    message: 'request',
    method: req.method,
    path: req.url,
    status,
    durationMs: Date.now() - start
  };
  console.log(JSON.stringify(log));
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

function parseRetryAfter(header) {
  if (!header) return null;
  const numeric = Number(header);
  if (Number.isFinite(numeric)) {
    return { retryAfterSeconds: Math.max(0, Math.round(numeric)), retryAt: null };
  }
  const parsed = new Date(header);
  if (Number.isNaN(parsed.getTime())) return null;
  const seconds = Math.max(0, Math.round((parsed.getTime() - Date.now()) / 1000));
  return { retryAfterSeconds: seconds, retryAt: parsed.toISOString() };
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
    const retryMeta = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null;
    if (response.status === 429 && attempt < SAM_RETRY_ATTEMPTS) {
      const delay = SAM_RETRY_BASE_DELAY_MS * attempt;
      await sleep(delay);
      continue;
    }
    const payload = {
      error: `HTTP ${response.status}`,
      retryAfterSeconds: retryMeta?.retryAfterSeconds || null,
      retryAt: retryMeta?.retryAt || null
    };
    samCache.set(cacheKey, { fetchedAt: Date.now(), ttlMs: SAM_CACHE_ERROR_TTL_MS, payload });
    return payload;
  }
  const payload = { error: 'rate_limited', retryAfterSeconds: null, retryAt: null };
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
    parsed.pathname = parsed.pathname.replace(/\/api\/area\/json\/[^/]+/i, '/api/area/json/REDACTED');
    return parsed.toString();
  } catch {
    return rawUrl
      .replace(/(api_key=)[^&]+/gi, '$1REDACTED')
      .replace(/(\/api\/area\/json\/)[^/]+/i, '$1REDACTED');
  }
}

function resolveServerKey(feed, env = process.env) {
  if (feed.keySource !== 'server') return null;
  let value = null;
  if (feed.keyGroup === 'api.data.gov') value = env.DATA_GOV;
  if (feed.keyGroup === 'eia') value = env.EIA;
  if (feed.keyGroup === 'openstates') value = env.OPENSTATES;
  if (feed.keyGroup === 'earthdata') value = env.EARTHDATA_NASA;
  if (feed.id === 'openaq-api') value = env.OPEN_AQ;
  if (feed.id === 'nasa-firms') value = env.NASA_FIRMS;
  return typeof value === 'string' ? value.trim() : (value || null);
}

function getServerKeyEnvNames(feed) {
  if (feed.keyGroup === 'api.data.gov') return ['DATA_GOV'];
  if (feed.keyGroup === 'eia') return ['EIA'];
  if (feed.keyGroup === 'openstates') return ['OPENSTATES'];
  if (feed.keyGroup === 'earthdata') return ['EARTHDATA_NASA'];
  if (feed.id === 'openaq-api') return ['OPEN_AQ'];
  if (feed.id === 'nasa-firms') return ['NASA_FIRMS'];
  return [];
}

export function getFeedConfiguration(feed, env = process.env) {
  if (isStateConnectorFeed(feed)) {
    const baseUrl = String(env.STATE_CONNECTOR_BASE_URL ?? '').trim();
    const apiKey = String(env.STATE_CONNECTOR_API_KEY ?? '').trim();
    return {
      configured: Boolean(baseUrl && apiKey),
      requiredEnv: ['STATE_CONNECTOR_BASE_URL', 'STATE_CONNECTOR_API_KEY'],
      optionalEnv: ['STATE_CONNECTOR_KEY_HEADER'],
      coveredStates: STATE_CONNECTOR_COVERED_STATES,
      message: baseUrl && apiKey ? null : 'State connector provider is not configured.'
    };
  }
  if (feed?.acledMode) {
    const proxyUrl = String(env.ACLED_PROXY ?? '').trim();
    return {
      configured: Boolean(proxyUrl),
      requiredEnv: ['ACLED_PROXY'],
      optionalEnv: [],
      message: proxyUrl ? null : 'ACLED proxy is not configured.'
    };
  }
  if (feed?.requiresConfig && !feed?.url) {
    return {
      configured: false,
      requiredEnv: [],
      optionalEnv: [],
      message: 'Feed requires an external connector configuration.'
    };
  }
  if (feed?.requiresKey && feed?.keySource === 'server') {
    const requiredEnv = getServerKeyEnvNames(feed);
    const configuredKey = resolveServerKey(feed, env);
    return {
      configured: Boolean(configuredKey),
      requiredEnv,
      optionalEnv: [],
      message: configuredKey ? null : 'Server key is not configured.'
    };
  }
  return {
    configured: true,
    requiredEnv: [],
    optionalEnv: [],
    message: null
  };
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

function buildNasaFirmsItems(data, source = 'NASA FIRMS') {
  const rows = Array.isArray(data)
    ? data
    : (Array.isArray(data?.items) ? data.items : []);
  return rows.slice(0, 200).map((entry) => {
    const geoLat = Number(entry?.geo?.lat);
    const geoLon = Number(entry?.geo?.lon);
    const lat = Number(entry.latitude ?? entry.lat ?? entry.Latitude ?? entry.lat_deg ?? entry.latitude_deg);
    const lon = Number(entry.longitude ?? entry.lon ?? entry.Longitude ?? entry.lon_deg ?? entry.longitude_deg);
    const resolvedLat = Number.isFinite(geoLat) ? geoLat : lat;
    const resolvedLon = Number.isFinite(geoLon) ? geoLon : lon;
    if (!Number.isFinite(resolvedLat) || !Number.isFinite(resolvedLon)) return null;
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
      if (time.length === 4 && /^\d+$/.test(time)) {
        const parsed = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
        if (!Number.isNaN(parsed)) publishedAt = parsed;
      } else {
        const parsed = Date.parse(date);
        if (!Number.isNaN(parsed)) publishedAt = parsed;
      }
    }
    return {
      title: entry.title || 'Fire detection',
      summary: parts.length ? parts.join(' | ') : 'Active fire detection',
      latitude: resolvedLat,
      longitude: resolvedLon,
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
    const response = await fetchWithTimeout(fireFeed.url, {
      headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'application/json' }
    }, 15000);
    if (!response.ok) return null;
    const data = await response.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    const items = features.slice(0, 200).map((feature) => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [];
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const publishedAt = props.acq_date || props.date ? Date.parse(props.acq_date || props.date) : Date.now();
      return {
        title: props.name || props.NAME || props.fire_name || 'Fire detection',
        summary: props.frp || props.FRP ? `FRP ${props.frp || props.FRP}` : 'NOAA HMS fire detection',
        latitude: lat,
        longitude: lon,
        publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
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
      fetchedUrl: fireFeed.url
    };
  } catch {
    return null;
  }
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

function isJsonHtmlError(contentType = '', body = '') {
  return normalizeContentType(contentType).includes('html') || looksLikeHtmlDocument(body);
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

function hasHistoryTemplate(feed) {
  return /\{\{start\}\}|\{\{end\}\}/.test(String(feed?.url || ''));
}

function applyFederalRegisterHistoryParams(url, startIso, endIso) {
  const parsed = new URL(url);
  parsed.searchParams.set('conditions[publication_date][gte]', startIso);
  parsed.searchParams.set('conditions[publication_date][lte]', endIso);
  parsed.searchParams.delete('start');
  parsed.searchParams.delete('end');
  return parsed.toString();
}

function getHistoryParamMapper(feed) {
  if (feed?.id === 'federal-register' || feed?.id === 'federal-register-transport' || feed?.id === 'federal-register-ed') {
    return applyFederalRegisterHistoryParams;
  }
  return null;
}

export function supportsHistoryRange(feed) {
  return Boolean(getHistoryParamMapper(feed) || hasHistoryTemplate(feed));
}

function applyHistoryRange(url, feed, { start, end, strictHistory = false } = {}) {
  if (!start || !end) return url;
  const startIso = formatIsoDate(start);
  const endIso = formatIsoDate(end);
  const mapper = getHistoryParamMapper(feed);
  if (mapper) return mapper(url, startIso, endIso);
  if (hasHistoryTemplate(feed)) return url;
  if (strictHistory) return url;
  if (!url.includes(startIso)) {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('start')) parsed.searchParams.set('start', startIso);
    if (!parsed.searchParams.has('end')) parsed.searchParams.set('end', endIso);
    return parsed.toString();
  }
  return url;
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

function tokenizeEntityName(value) {
  return normalizeEntityName(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token && !ENTITY_SUFFIX_TOKENS.has(token));
}

function uniqueStrings(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value) return false;
      const key = normalizeEntityName(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function uniqueItemsBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item, index) => {
    const key = String(keyFn(item) || index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMoneyMatchMode(value) {
  const mode = String(value || 'normal').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MONEY_MATCH_THRESHOLDS, mode) ? mode : 'normal';
}

function normalizeMoneyMinScore(value, mode = 'normal') {
  const fallback = MONEY_MATCH_THRESHOLDS[normalizeMoneyMatchMode(mode)] || MONEY_MATCH_THRESHOLDS.normal;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0.01, Math.min(1, ratio));
}

function hasMoneyMinScoreOverride(value) {
  if (value === undefined || value === null || value === '') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function getMoneyAliasEntries(rawConfig) {
  if (Array.isArray(rawConfig)) return rawConfig;
  if (Array.isArray(rawConfig?.moneyFlows)) return rawConfig.moneyFlows;
  if (Array.isArray(rawConfig?.entities)) return rawConfig.entities;
  if (Array.isArray(rawConfig?.aliases)) return rawConfig.aliases;
  return [];
}

function normalizeMoneyAliasEntry(entry) {
  const umbrella = String(entry?.umbrella || entry?.name || '').trim();
  const expandedTo = uniqueStrings(entry?.expandedTo || entry?.entities || entry?.legalEntities || []);
  if (!umbrella || !expandedTo.length) return null;
  const aliases = uniqueStrings([umbrella, ...(entry?.aliases || [])]);
  return {
    umbrella,
    normalizedAliases: aliases.map((alias) => normalizeEntityName(alias)).filter(Boolean),
    expandedTo
  };
}

function loadMoneyEntityAliases(aliasPath = MONEY_ENTITY_ALIASES_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(aliasPath, 'utf8'));
    return getMoneyAliasEntries(parsed).map(normalizeMoneyAliasEntry).filter(Boolean);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'money_entity_aliases_unavailable',
      path: aliasPath,
      message: error?.message || 'Unable to load entity aliases.'
    }));
    return [];
  }
}

const moneyEntityAliases = loadMoneyEntityAliases();

export function resolveMoneyAliasExpansion(query, explicitEntities = []) {
  const providedEntities = uniqueStrings(explicitEntities);
  if (providedEntities.length) {
    return {
      umbrella: String(query || '').trim() || null,
      expandedTo: providedEntities,
      explicit: true
    };
  }
  const normalized = normalizeEntityName(query);
  if (!normalized) return null;
  const match = moneyEntityAliases.find((entry) => entry.normalizedAliases.includes(normalized));
  if (!match) return null;
  return {
    umbrella: match.umbrella,
    expandedTo: match.expandedTo
  };
}

export function buildUsaspendingTransactionKey(item = {}) {
  return [
    item['Award ID'],
    item['Recipient Name'],
    item['Action Date'],
    item['Transaction Amount'],
    item['Transaction Description']
  ]
    .map((value) => String(value || '').trim())
    .join(':');
}

export async function settleMoneyTasks(tasks) {
  const settled = await Promise.allSettled(tasks);
  return settled.map((entry) => (
    entry.status === 'fulfilled'
      ? entry.value
      : { items: [], error: entry.reason?.message || 'fetch_failed' }
  ));
}

export function buildMoneyQueryProfile(query, options = {}) {
  const normalized = normalizeEntityName(query);
  const matchMode = normalizeMoneyMatchMode(options.matchMode);
  const matchThreshold = normalizeMoneyMinScore(options.minScore, matchMode);
  const minScoreOverride = hasMoneyMinScoreOverride(options.minScore);
  const aliasExpansion = resolveMoneyAliasExpansion(query, options.entities);
  const searchTerms = uniqueStrings([
    ...(aliasExpansion?.expandedTo?.length ? [] : [query]),
    ...(aliasExpansion?.expandedTo || [])
  ]);
  const variants = searchTerms
    .map((term) => ({
      term,
      normalized: normalizeEntityName(term),
      tokens: tokenizeEntityName(term)
    }))
    .filter((variant) => variant.tokens.length);
  return {
    original: query,
    normalized,
    searchTerms: searchTerms.length ? searchTerms : [query],
    variants,
    matchMode,
    matchThreshold,
    minScoreOverride,
    aliasExpansion
  };
}

function scoreTokenMatch(queryTokens, candidateTokens, mode = 'normal') {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  const overlap = queryTokens.filter((token) => candidateSet.has(token)).length;
  const recall = overlap / queryTokens.length;
  if (mode === 'loose') {
    const requiredOverlap = queryTokens.length > 1 ? 2 : 1;
    if (overlap < requiredOverlap) return 0;
  } else if (recall < 1) {
    return 0;
  }
  const precision = overlap / candidateTokens.length;
  if (precision <= 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function findBestMoneyNameMatch(profile, ...fields) {
  if (!profile?.variants?.length) return null;
  let best = null;
  fields.flat(Infinity).forEach((field) => {
    const name = String(field || '').trim();
    if (!name) return;
    const normalizedName = normalizeEntityName(name);
    const candidateTokens = tokenizeEntityName(name);
    profile.variants.forEach((variant) => {
      let score = scoreTokenMatch(variant.tokens, candidateTokens, profile.matchMode);
      if (normalizedName === variant.normalized) score = 1;
      if (score > (best?.score || 0)) {
        best = {
          name,
          normalizedName,
          score: Number(score.toFixed(3)),
          query: variant.term
        };
      }
    });
  });
  return best && best.score >= (profile.matchThreshold || MONEY_MATCH_THRESHOLDS.normal) ? best : null;
}

function findMoneyKeywordMatch(profile, ...fields) {
  if (!profile?.variants?.length) return null;
  let best = null;
  fields.flat(Infinity).forEach((field) => {
    const text = normalizeSearchField(field);
    if (!text) return;
    const candidateTokens = tokenizeEntityName(text);
    profile.variants.forEach((variant) => {
      if (!variant.tokens.length) return;
      const candidateSet = new Set(candidateTokens);
      const overlap = variant.tokens.filter((token) => candidateSet.has(token)).length;
      if (overlap !== variant.tokens.length) return;
      const score = Number(Math.min(0.65, overlap / Math.max(candidateTokens.length, variant.tokens.length)).toFixed(3));
      if (score > (best?.score || 0)) {
        best = {
          name: text,
          normalizedName: normalizeEntityName(text),
          score,
          query: variant.term
        };
      }
    });
  });
  if (!best) return null;
  if ((profile.minScoreOverride || profile.matchMode !== 'normal')
    && best.score < (profile.matchThreshold || MONEY_MATCH_THRESHOLDS.normal)) {
    return null;
  }
  return best;
}

export function attachMoneyMatch(profile, item) {
  const { moneyMatchFields, keywordMatchFields, ...publicItem } = item;
  const match = findBestMoneyNameMatch(
    profile,
    publicItem.entity,
    publicItem.recipient,
    publicItem.client,
    publicItem.registrant,
    publicItem.donor,
    publicItem.committee,
    publicItem.registryEntity,
    moneyMatchFields
  );
  const keywordMatch = match ? null : findMoneyKeywordMatch(profile, keywordMatchFields);
  const resolvedMatch = match || keywordMatch;
  if (!resolvedMatch) return null;
  return {
    ...publicItem,
    matchedName: resolvedMatch.name,
    matchScore: Math.round(resolvedMatch.score * 100),
    matchType: match ? 'entity' : 'keyword'
  };
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

function normalizeSearchField(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSearchField(entry))
      .filter(Boolean)
      .join(' ');
  }
  return String(value).trim();
}

function isStateSignal(item, feed) {
  const itemLevel = String(item?.jurisdictionLevel || '').toLowerCase();
  if (itemLevel === 'state') return true;
  return String(feed?.jurisdictionLevel || '').toLowerCase() === 'state';
}

function buildStateSignalSearchHaystack(item, feed) {
  const jurisdictionCode = normalizeJurisdictionCode(item?.jurisdictionCode) || item?.jurisdictionCode;
  return [
    item?.title,
    item?.summary,
    item?.jurisdictionName,
    jurisdictionCode,
    item?.agency,
    item?.signalType,
    item?.status,
    item?.docId,
    item?.tags,
    feed?.tags
  ]
    .map((field) => normalizeSearchField(field))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function buildSignalSearchHaystack(item, feed) {
  return [
    item?.title,
    item?.summary,
    item?.source,
    item?.sourceName,
    item?.category,
    item?.url,
    item?.jurisdictionName,
    item?.jurisdictionCode,
    item?.agency,
    item?.signalType,
    item?.status,
    item?.docId,
    item?.tags,
    feed?.name,
    feed?.category,
    feed?.tags
  ]
    .map((field) => normalizeSearchField(field))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesSignalQuery(item, normalizedQuery, feed) {
  if (!normalizedQuery) return true;
  if (isStateSignal(item, feed)) {
    return matchesStateAwareSignalQuery(item, normalizedQuery, feed);
  }
  const haystack = buildSignalSearchHaystack(item, feed);
  if (haystack.includes(normalizedQuery)) return true;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return tokens.length ? tokens.every((token) => haystack.includes(token)) : true;
}

function matchesStateAwareSignalQuery(item, normalizedQuery, feed) {
  if (!normalizedQuery) return true;
  if (isStateSignal(item, feed)) {
    return buildStateSignalSearchHaystack(item, feed).includes(normalizedQuery);
  }
  // Preserve existing non-state behavior by avoiding additional local filtering.
  return true;
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

export function summarizeMoneyEntities(items) {
  const totals = new Map();
  items.forEach((item) => {
    const rawName = item.matchType === 'entity'
      ? (item.matchedName || item.entity || item.recipient || item.committee || item.contributor)
      : (item.entity || item.recipient || item.committee || item.contributor);
    const name = normalizeEntityName(rawName || '');
    if (!name) return;
    const current = totals.get(name) || {
      name,
      amount: 0,
      count: 0,
      sample: rawName
    };
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

function getUrlTemplateParamNames(template = '') {
  return new Set(
    [...String(template || '').matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)]
      .map((match) => match[1])
  );
}

export function buildFeedUrl(feed, options) {
  const query = feed.supportsQuery
    ? (options.query || feed.defaultQuery || '')
    : (options.query || '');
  const start = options.start || '';
  const end = options.end || '';
  const timespan = computeTimespan(start, end);
  const templateParams = feed.supportsParams
    ? {
      ...sanitizeParamsObject(feed.defaultParams),
      ...sanitizeParamsObject(options.params)
    }
    : sanitizeParamsObject(options.params);
  let url = buildUrl(feed.url || '', {
    ...templateParams,
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

  url = applyHistoryRange(url, feed, { start, end, strictHistory: Boolean(options.history) });

  if (feed.acledMode && ACLED_PROXY) {
    const endpoint = feed.acledMode === 'aggregated' ? 'aggregated' : 'events';
    url = `${ACLED_PROXY}/${endpoint}`;
  }

  const mergedParams = feed.supportsParams
    ? mergeFeedParams(feed, options.params)
    : sanitizeParamsObject(options.params);
  if (mergedParams && Object.keys(mergedParams).length) {
    const parsed = new URL(url);
    const templateParamNames = getUrlTemplateParamNames(feed.url);
    Object.entries(mergedParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (templateParamNames.has(key)) return;
      parsed.searchParams.set(key, String(value));
    });
    url = parsed.toString();
  }

  return url;
}

function isStateLegislationAllStatesRequest(feed, params = {}) {
  if (!feed || feed.id !== 'state-legislation') return false;
  if (feed.paramStrategy !== 'openstates-jurisdiction') return false;
  return !params.jurisdiction && !params.q;
}

function isStateConnectorFeed(feed) {
  return feed?.id === 'state-rulemaking' || feed?.id === 'state-executive-orders';
}

function normalizeStateConnectorSignalType(value, fallback = '') {
  const raw = String(value || fallback || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'executive_order' || raw === 'executive-order' || raw === 'executive order' || raw.includes('executive')) {
    return 'executive_order';
  }
  if (raw === 'rulemaking' || raw === 'rule' || raw === 'rules' || raw.includes('rule')) {
    return 'rulemaking';
  }
  return raw.replace(/\s+/g, '_');
}

function normalizeStateConnectorResult(entry, signalType, fallbackStateCode = '') {
  if (!entry || typeof entry !== 'object') return null;
  const title = String(entry.title || entry.name || entry.id || '').trim();
  if (!title) return null;
  const stateCode = normalizeJurisdictionCode(
    entry.state
    || entry.stateCode
    || entry.jurisdictionCode
    || entry.jurisdiction?.id
    || fallbackStateCode
  );
  const normalizedSignalType = normalizeStateConnectorSignalType(entry.signalType || entry.type, signalType);
  return {
    id: String(entry.id || entry.docId || entry.identifier || ''),
    title,
    summary: String(entry.summary || entry.description || entry.status || ''),
    url: String(entry.url || entry.link || ''),
    updated_at: String(
      entry.updatedAt
      || entry.updated_at
      || entry.updated
      || entry.publishedAt
      || entry.published_at
      || entry.date
      || entry.effectiveDate
      || entry.effective_date
      || ''
    ),
    jurisdictionCode: stateCode,
    jurisdictionName: String(entry.stateName || entry.jurisdictionName || entry.jurisdiction?.name || stateCode || ''),
    jurisdictionLevel: 'state',
    signalType: normalizedSignalType,
    agency: String(entry.agency || entry.department || ''),
    status: String(entry.status || ''),
    effective_date: String(entry.effectiveDate || entry.effective_date || ''),
    source: String(entry.source || entry.provider || 'State Connector')
  };
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

export function getStateBillSortTimestamp(entry) {
  const candidates = [
    entry?.updated_at,
    entry?.latest_action_date,
    entry?.latest_action_at,
    entry?.effective_date,
    entry?.effectiveDate,
    entry?.created_at,
    entry?.first_action_date
  ];
  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function fetchAllStatesLegislationRaw(feed, keyedUrl, headers, proxy, timeoutMs = FETCH_TIMEOUT_MS) {
  const template = new URL(keyedUrl);
  const requestedPerPage = Math.max(1, Math.min(100, toPositiveInt(template.searchParams.get('per_page'), 20)));
  const targetItems = Math.min(requestedPerPage, US_STATE_CODES.length * STATE_LEGISLATION_ALL_STATES_PER_STATE);
  template.searchParams.delete('jurisdiction');
  template.searchParams.delete('q');
  template.searchParams.delete('page');
  template.searchParams.set('per_page', String(STATE_LEGISLATION_ALL_STATES_PER_STATE));

  const rotationOffset = Math.floor(Date.now() / (15 * 60 * 1000)) % US_STATE_CODES.length;
  const queue = [
    ...US_STATE_CODES.slice(rotationOffset),
    ...US_STATE_CODES.slice(0, rotationOffset)
  ];
  const collected = [];
  const failedStates = [];
  const perStateTimeoutMs = Math.max(2500, Math.min(timeoutMs, STATE_LEGISLATION_ALL_STATES_TIMEOUT_MS));
  const workerCount = Math.min(STATE_LEGISLATION_ALL_STATES_CONCURRENCY, queue.length);
  let attemptedStates = 0;
  let stop = false;
  const attemptProxies = [null, proxy].filter((value, index, array) => value || index === 0)
    .filter((value, index, array) => array.indexOf(value) === index);

  const fetchState = async (requestUrl) => {
    let lastResponse = null;
    for (const nextProxy of attemptProxies) {
      const target = nextProxy ? applyProxy(requestUrl, nextProxy) : requestUrl;
      try {
        const response = await fetchWithTimeout(target, { headers }, perStateTimeoutMs);
        if (response.ok) {
          return { response, proxyUsed: nextProxy || null };
        }
        lastResponse = response;
      } catch {
        // try next proxy
      }
    }
    return { response: lastResponse, proxyUsed: null };
  };

  const worker = async () => {
    while (!stop && queue.length) {
      if (attemptedStates >= STATE_LEGISLATION_ALL_STATES_MAX_ATTEMPTS) {
        stop = true;
        break;
      }
      const code = queue.shift();
      if (!code) break;
      attemptedStates += 1;
      const jurisdiction = `ocd-jurisdiction/country:us/state:${code.toLowerCase()}/government`;
      const requestUrl = new URL(template.toString());
      requestUrl.searchParams.set('jurisdiction', jurisdiction);
      try {
        const { response } = await fetchState(requestUrl.toString());
        if (!response || !response.ok) {
          failedStates.push({ code, status: response?.status || 'fetch_failed' });
          continue;
        }
        const text = await response.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          failedStates.push({ code, status: 'invalid_json' });
          continue;
        }
        const rows = Array.isArray(parsed?.results) ? parsed.results : [];
        rows.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;
          const normalized = { ...entry };
          if (!normalized.jurisdictionCode) normalized.jurisdictionCode = code;
          collected.push(normalized);
          if (collected.length >= targetItems) {
            stop = true;
          }
        });
      } catch {
        failedStates.push({ code, status: 'fetch_failed' });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const deduped = [];
  const seen = new Set();
  collected
    .sort((a, b) => getStateBillSortTimestamp(b) - getStateBillSortTimestamp(a))
    .forEach((entry) => {
      const key = entry.id
        || entry.identifier
        || entry.openstates_url
        || `${entry.jurisdictionCode || ''}:${entry.title || ''}:${entry.updated_at || ''}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      deduped.push(entry);
    });

  const limited = deduped.slice(0, requestedPerPage);
  const aggregateMeta = {
    mode: 'state-legislation-all-states',
    requestedStates: US_STATE_CODES.length,
    attemptedStates,
    succeededStates: Math.max(0, attemptedStates - failedStates.length),
    failedStates: failedStates.map((entry) => entry.code),
    partial: failedStates.length > 0 || attemptedStates < US_STATE_CODES.length
  };

  if (!limited.length) {
    return {
      error: 'fetch_failed',
      message: 'Unable to fetch state legislation for all states.',
      fetchedUrl: stripSecretsFromUrl(template.toString()),
      proxyUsed: null,
      fallbackUsed: false
    };
  }

  return {
    body: JSON.stringify({
      results: limited,
      pagination: {
        page: 1,
        per_page: requestedPerPage,
        max_page: Math.max(1, Math.ceil(deduped.length / requestedPerPage)),
        total_items: deduped.length
      },
      aggregate: aggregateMeta
    }),
    httpStatus: 200,
    contentType: 'application/json',
    fetchedUrl: stripSecretsFromUrl(template.toString()),
    proxyUsed: null,
    fallbackUsed: false
  };
}

async function fetchStateConnectorRaw(feed, options = {}) {
  if (!STATE_CONNECTOR_BASE_URL || !STATE_CONNECTOR_API_KEY) {
    return { error: 'config_required', message: 'State connector provider is not configured.' };
  }
  const mergedParams = feed.supportsParams
    ? mergeFeedParams(feed, options.params)
    : sanitizeParamsObject(options.params);
  const signalType = normalizeStateConnectorSignalType(
    mergedParams.signalType,
    Array.isArray(feed?.capabilities) && feed.capabilities.length ? feed.capabilities[0] : ''
  );
  const stateCode = normalizeJurisdictionCode(
    mergedParams.state
    || mergedParams.jurisdictionCode
    || mergedParams.jurisdiction
  );
  const requestedLimit = toPositiveInt(
    mergedParams.limit || mergedParams.per_page || STATE_CONNECTOR_DEFAULT_LIMIT,
    STATE_CONNECTOR_DEFAULT_LIMIT
  );
  const limit = Math.max(1, Math.min(STATE_CONNECTOR_MAX_LIMIT, requestedLimit));
  const requestUrl = new URL(`${STATE_CONNECTOR_BASE_URL}/signals`);
  requestUrl.searchParams.set('signalType', signalType || 'rulemaking');
  requestUrl.searchParams.set('limit', String(limit));
  requestUrl.searchParams.set('sort', 'updated_desc');
  if (stateCode) {
    requestUrl.searchParams.set('state', stateCode);
  }
  const requestHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0',
    [STATE_CONNECTOR_KEY_HEADER]: STATE_CONNECTOR_API_KEY
  };
  const timeoutMs = feed.timeoutMs || FETCH_TIMEOUT_MS;
  try {
    const response = await fetchWithTimeout(requestUrl.toString(), { headers: requestHeaders }, timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      return {
        error: 'fetch_failed',
        httpStatus: response.status,
        message: `HTTP ${response.status}`,
        body: text,
        fetchedUrl: stripSecretsFromUrl(requestUrl.toString()),
        proxyUsed: null,
        fallbackUsed: false
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text || '{}');
    } catch {
      return {
        error: 'invalid_response',
        httpStatus: 502,
        message: 'State connector returned invalid JSON.',
        fetchedUrl: stripSecretsFromUrl(requestUrl.toString()),
        proxyUsed: null,
        fallbackUsed: false
      };
    }

    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    const normalizedResults = results
      .map((entry) => normalizeStateConnectorResult(entry, signalType, stateCode))
      .filter(Boolean)
      .slice(0, limit);
    return {
      body: JSON.stringify({
        results: normalizedResults,
        meta: {
          ...(parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {}),
          provider: 'state-connector',
          signalType: signalType || null,
          state: stateCode || null,
          count: normalizedResults.length
        }
      }),
      httpStatus: 200,
      contentType: 'application/json',
      fetchedUrl: stripSecretsFromUrl(requestUrl.toString()),
      proxyUsed: null,
      fallbackUsed: false
    };
  } catch (error) {
    return {
      error: 'fetch_failed',
      message: error?.message || 'State connector fetch failed.',
      fetchedUrl: stripSecretsFromUrl(requestUrl.toString()),
      proxyUsed: null,
      fallbackUsed: false
    };
  }
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

async function fetchLiveFallback(feedId) {
  if (!feedId) return null;
  const url = `${LIVE_BASE}/data/feeds/${feedId}.json?ts=${Date.now()}`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0',
        'Accept': 'application/json, text/plain, */*'
      }
    }, FETCH_TIMEOUT_MS);
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || payload.error || !payload.body) return null;
    return payload;
  } catch {
    return null;
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

function normalizeSignals(text, feed) {
  if (!text) return [];
  if (feed.format === 'rss') return parseRss(text, feed);
  if (feed.format === 'csv') return normalizeCsvSignals(text, feed);
  if (feed.format === 'json' || feed.format === 'arcgis') return normalizeJsonSignals(text, feed);
  return [];
}

function isCongressCommitteeBillsFeed(feed) {
  return Boolean(feed?.congressCommitteeBills);
}

function getCongressCommitteeBillRows(data) {
  const committeeBills = data?.['committee-bills'] || data?.committeeBills || {};
  if (Array.isArray(committeeBills?.bills)) return committeeBills.bills;
  if (Array.isArray(data?.bills)) return data.bills;
  return [];
}

const CONGRESS_BILL_WEB_TYPE_SLUGS = {
  HR: 'house-bill',
  S: 'senate-bill',
  HRES: 'house-resolution',
  SRES: 'senate-resolution',
  HJRES: 'house-joint-resolution',
  SJRES: 'senate-joint-resolution',
  HCONRES: 'house-concurrent-resolution',
  SCONRES: 'senate-concurrent-resolution'
};
const CONGRESS_COMMITTEE_DETAIL_DEFAULT_LIMIT = 5;
const CONGRESS_COMMITTEE_DETAIL_MAX_LIMIT = 8;

function normalizeCongressBillType(value = '') {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function buildCongressBillWebUrl({ congress, type, number } = {}) {
  const congressNumber = String(congress || '').trim();
  const billNumber = String(number || '').trim();
  const slug = CONGRESS_BILL_WEB_TYPE_SLUGS[normalizeCongressBillType(type)];
  if (!congressNumber || !billNumber || !slug) return '';
  return `https://www.congress.gov/bill/${encodeURIComponent(congressNumber)}th-congress/${slug}/${encodeURIComponent(billNumber)}`;
}

function buildCongressBillDetailApiUrl({ congress, type, number } = {}) {
  const congressNumber = String(congress || '').trim();
  const billNumber = String(number || '').trim();
  const billType = normalizeCongressBillType(type).toLowerCase();
  if (!congressNumber || !billType || !billNumber) return '';
  return `https://api.congress.gov/v3/bill/${encodeURIComponent(congressNumber)}/${encodeURIComponent(billType)}/${encodeURIComponent(billNumber)}?format=json`;
}

async function fetchCongressBillDetail(apiUrl, feed, key, baseHeaders, timeoutMs) {
  if (!apiUrl) return null;
  const { url, headers } = applyKey(apiUrl, feed, key);
  const detailTimeoutMs = Math.max(1500, Math.min(Number(timeoutMs) || FETCH_TIMEOUT_MS, 8000));
  try {
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: {
        ...baseHeaders,
        ...headers,
        Accept: 'application/json, text/plain, */*'
      }
    }, detailTimeoutMs);
    if (!response.ok || !data?.bill) return null;
    return data.bill;
  } catch {
    return null;
  }
}

function resolveCongressCommitteeDetailLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return CONGRESS_COMMITTEE_DETAIL_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CONGRESS_COMMITTEE_DETAIL_MAX_LIMIT, Math.floor(parsed)));
}

async function enrichCongressCommitteeBillsBody(body, feed, key, requestHeaders, timeoutMs, detailLimit = CONGRESS_COMMITTEE_DETAIL_DEFAULT_LIMIT, params = {}) {
  const parsed = parseJsonBody(body);
  if (!parsed) return body;
  const requestedCongress = String(params?.congress || feed?.defaultParams?.congress || '').trim();
  const upstreamRows = getCongressCommitteeBillRows(parsed);
  if (!upstreamRows.length) return body;
  const rows = upstreamRows.filter((row) => !requestedCongress || String(row?.congress || '').trim() === requestedCongress);
  if (!rows.length) {
    return JSON.stringify({
      bills: [],
      pagination: parsed.pagination || null,
      request: parsed.request || null,
      committeeBills: {
        ...(parsed['committee-bills'] || parsed.committeeBills || {}),
        bills: []
      }
    });
  }
  const safeDetailLimit = resolveCongressCommitteeDetailLimit(detailLimit);
  const enriched = await Promise.all(rows.slice(0, 20).map(async (row, index) => {
    const congress = row.congress;
    const type = row.type || row.billType;
    const number = row.number || row.billNumber;
    const apiUrl = row.url || buildCongressBillDetailApiUrl({ congress, type, number });
    const detail = index < safeDetailLimit
      ? await fetchCongressBillDetail(apiUrl, feed, key, requestHeaders, timeoutMs)
      : null;
    const resolvedCongress = detail?.congress || congress;
    const resolvedType = detail?.type || type;
    const resolvedNumber = detail?.number || number;
    const webUrl = buildCongressBillWebUrl({ congress: resolvedCongress, type: resolvedType, number: resolvedNumber });
    return {
      ...row,
      ...(detail || {}),
      apiUrl: apiUrl || detail?.url || '',
      url: webUrl || detail?.url || row.url || '',
      congress: resolvedCongress,
      type: resolvedType,
      number: resolvedNumber,
      latestAction: detail?.latestAction || {
        actionDate: row.actionDate || '',
        text: row.relationshipType || ''
      },
      updateDate: detail?.updateDate || row.updateDate || ''
    };
  }));
  const originalCommitteeBills = parsed['committee-bills'] || parsed.committeeBills || {};
  return JSON.stringify({
    bills: enriched,
    pagination: parsed.pagination || null,
    request: parsed.request || null,
    committeeBills: {
      ...originalCommitteeBills,
      bills: enriched,
      count: enriched.length
    }
  });
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

function extractSafeResponseHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const allowed = [
    'cache-control',
    'content-type',
    'etag',
    'last-modified',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset'
  ];
  const selected = {};
  allowed.forEach((key) => {
    const value = headers.get(key);
    if (value) selected[key] = value;
  });
  return Object.keys(selected).length ? selected : null;
}

function isJsonContentType(contentType = '') {
  const normalized = normalizeContentType(contentType);
  return normalized.includes('application/json') || normalized.includes('+json');
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function buildRawStructuredContent({ sourceId, feed, result, responseFormat, range = null }) {
  const contentIsJson = isJsonContentType(result.contentType);
  const parsed = (responseFormat === 'json' || contentIsJson) ? parseJsonBody(result.body) : null;
  return {
    sourceId,
    ...(range ? { range } : {}),
    contentType: result.contentType,
    url: stripSecretsFromUrl(feed.url),
    fetchedUrl: result.fetchedUrl || null,
    proxyUsed: result.proxyUsed || null,
    fallbackUsed: Boolean(result.fallbackUsed),
    responseHeaders: result.responseHeaders || null,
    body: responseFormat === 'text' || responseFormat === 'csv' ? result.body : undefined,
    data: parsed
  };
}

function translateQueryForFeed(feed, query) {
  if (!feed || !query) return query;
  if (feed.id === 'gdelt-doc') return query;
  if (feed.id.startsWith('google-news')) {
    return query.includes('when:') ? query : `${query} when:1d`;
  }
  return query;
}

function hasUsableJsonSignals(body, feed) {
  if (feed?.format !== 'json' || !body) return false;
  try {
    return normalizeJsonSignals(body, feed).length > 0;
  } catch {
    return false;
  }
}

function includesAny(text, list) {
  return list.some((term) => text.includes(term));
}

function classifyQuery(query = '') {
  const lowered = query.toLowerCase();
  const categories = new Set();
  const tags = new Set();

  if (includesAny(lowered, ['congress', 'senate', 'house', 'bill', 'amendment', 'nomination', 'hearing', 'treaty', 'federal register', 'executive order', 'regulation', 'state legislature', 'state bill', 'state register', 'governor'])) {
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

export function selectSmartFeeds({ query, categories, sources, maxSources }) {
  if (Array.isArray(sources) && sources.length) {
    return sources
      .map((id) => feeds.find((feed) => feed.id === id))
      .filter(Boolean);
  }

  const classification = classifyQuery(query || '');
  if (Array.isArray(categories) && categories.length) {
    categories.forEach((cat) => classification.categories.add(cat));
  }

  const requestedCategories = Array.isArray(categories)
    ? new Set(categories.map((cat) => String(cat || '').trim()).filter(Boolean))
    : new Set();
  const candidates = feeds.filter((feed) => {
    if (feed.mapOnly) return false;
    if (!requestedCategories.size) return true;
    return requestedCategories.has(feed.category);
  });
  const scored = candidates
    .map((feed) => ({ feed, score: scoreFeed(feed, classification, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const defaultFallback = feeds.filter((feed) => ['gdelt-doc', 'google-news-search'].includes(feed.id));
  const selected = scored.length ? scored.map(({ feed }) => feed) : defaultFallback;
  const limit = Math.max(1, Number(maxSources) || 12);
  return selected.slice(0, limit);
}

export function shouldFilterSmartFeedLocally({ feed, query, categories, sources }) {
  if (!String(query || '').trim() || feed?.supportsQuery) return false;
  return (Array.isArray(categories) && categories.length > 0)
    || (Array.isArray(sources) && sources.length > 0);
}

export function shouldUseLiveFallback(options = {}) {
  return !options?.history;
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
  const stableSourceId = item.apiUrl || item.docId || item.documentNumber || item.packageId || item.sourceId || '';
  const base = stableSourceId
    ? `${stableSourceId}|${item.url || ''}`
    : `${item.url || ''}|${item.title || ''}|${item.publishedAt || ''}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 12);
}

async function fetchRaw(feed, options) {
  if (options?.history && !supportsHistoryRange(feed)) {
    return {
      error: 'history_not_supported',
      sourceId: feed?.id || null,
      message: `History ranges are not supported for ${feed?.id || 'this source'}.`
    };
  }
  if (isStateConnectorFeed(feed)) {
    return fetchStateConnectorRaw(feed, options);
  }
  if (feed?.requiresConfig && !feed?.url && !(feed?.acledMode && ACLED_PROXY)) {
    return { error: 'config_required', message: 'Feed requires configuration and has no url.' };
  }
  if (!feed?.url) {
    return { error: 'missing_url', message: 'Feed url missing.' };
  }

  const startedAt = Date.now();
  const key = options.key || resolveServerKey(feed);
  if (feed.requiresKey && !key) {
    return {
      error: feed.keySource === 'server' ? 'missing_server_key' : 'requires_key',
      message: feed.keySource === 'server' ? 'Server API key required for this feed.' : 'API key required for this feed.'
    };
  }
  const url = buildFeedUrl(feed, { ...options, key });
  const { url: keyedUrl, headers } = applyKey(url, feed, key, options.keyParam, options.keyHeader);
  if (feed.id === 'transport-opensky' && /opensky-network\.org/.test(keyedUrl)) {
    const token = await getOpenSkyToken();
    if (!token) {
      const fallback = await fetchLiveFallback(feed.id);
      if (fallback) {
        return {
          body: fallback.body,
          httpStatus: fallback.httpStatus || 200,
          contentType: fallback.contentType || 'application/json',
          fetchedUrl: `${LIVE_BASE}/data/feeds/${encodeURIComponent(feed.id)}.json`,
          proxyUsed: 'live-cache',
          fallbackUsed: true,
          responseHeaders: null
        };
      }
      return {
        error: 'missing_server_key',
        message: 'OpenSky OAuth token unavailable.'
      };
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const totalTimeoutMs = feed.timeoutMs || FETCH_TIMEOUT_MS;
  const configuredProxies = Array.isArray(feed.proxy)
    ? feed.proxy
    : (feed.proxy ? [feed.proxy] : []);
  const optionProxy = options.proxy || null;
  const primaryProxy = configuredProxies[0] || optionProxy || null;
  const requestHeaders = {
    ...headers,
    'Accept': feed.format === 'rss'
      ? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain, */*'
      : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0'
  };
  if (isStateLegislationAllStatesRequest(feed, options.params)) {
    return fetchAllStatesLegislationRaw(feed, keyedUrl, requestHeaders, primaryProxy, totalTimeoutMs);
  }
  const attemptList = [null, ...configuredProxies, optionProxy, ...FALLBACK_PROXIES];
  const isRssFeed = feed.format === 'rss';
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
  let responseHeaders = null;
  let succeeded = false;
  const isEonetFeed = feed?.id === 'eonet-events';
  const rssEffectiveTimeout = Math.max(8000, totalTimeoutMs);
  const rssDirectTimeoutMs = Math.max(15000, Math.floor(rssEffectiveTimeout * 0.75));
  const rssFallbackTimeoutMs = attempts.length > 1
    ? Math.max(4000, Math.floor((rssEffectiveTimeout * 0.25) / (attempts.length - 1)))
    : rssDirectTimeoutMs;
  const eonetEffectiveTimeout = Math.max(10000, Math.min(totalTimeoutMs, 18000));
  const eonetDirectTimeoutMs = Math.max(6000, Math.floor(eonetEffectiveTimeout * 0.6));
  const eonetFallbackTimeoutMs = attempts.length > 1
    ? Math.max(2500, Math.floor((eonetEffectiveTimeout * 0.4) / (attempts.length - 1)))
    : eonetDirectTimeoutMs;

  for (let index = 0; index < attempts.length; index += 1) {
    const proxy = attempts[index];
    const proxiedUrl = proxy ? applyProxy(keyedUrl, proxy) : keyedUrl;
    fetchedUrl = proxiedUrl;
    const perAttemptTimeoutMs = isRssFeed
      ? (index === 0 ? rssDirectTimeoutMs : rssFallbackTimeoutMs)
      : isEonetFeed
        ? (index === 0 ? eonetDirectTimeoutMs : eonetFallbackTimeoutMs)
      : totalTimeoutMs;
    try {
      response = await fetchWithTimeout(proxiedUrl, { headers: requestHeaders }, perAttemptTimeoutMs);
      body = await response.text();
      responseHeaders = extractSafeResponseHeaders(response.headers);
      if (response.ok) {
        if (feed.format === 'json' && isJsonHtmlError(response.headers.get('content-type') || '', body)) {
          lastError = {
            error: 'invalid_response',
            httpStatus: response.status,
            message: 'Upstream returned HTML instead of JSON.',
            body
          };
          continue;
        }
        if (feed.id === 'gdelt-doc' && !hasUsableJsonSignals(body, feed)) {
          lastError = {
            error: 'invalid_response',
            httpStatus: response.status,
            message: 'GDELT returned a non-normalizable payload.',
            body
          };
          continue;
        }
        if (feed.id === 'nasa-firms' && normalizeContentType(response.headers.get('content-type')).includes('json')) {
          try {
            const items = buildNasaFirmsItems(JSON.parse(body));
            if (!items.length) {
              lastError = {
                error: 'fetch_failed',
                httpStatus: response.status,
                message: 'NASA FIRMS returned no usable geolocated detections.',
                body
              };
              continue;
            }
            body = JSON.stringify({ items });
          } catch {
            lastError = {
              error: 'invalid_response',
              httpStatus: response.status,
              message: 'NASA FIRMS returned invalid JSON.',
              body
            };
            continue;
          }
        }
        if (isRssFeed && !isLikelyRssPayload(response.headers.get('content-type') || '', body)) {
          lastError = {
            error: 'invalid_rss',
            httpStatus: response.status,
            message: 'Upstream response was not valid RSS/Atom XML.',
            body
          };
          continue;
        }
        if (isCongressCommitteeBillsFeed(feed)) {
          body = await enrichCongressCommitteeBillsBody(body, feed, key, requestHeaders, totalTimeoutMs, options.limit, options.params);
        }
        usedProxy = proxy || null;
        succeeded = true;
        break;
      }
      lastError = {
        error: 'fetch_failed',
        httpStatus: response.status,
        message: `HTTP ${response.status}`,
        body
      };
      // Client-side upstream errors are not recoverable via proxy fallback.
      if (!isRssFeed && response.status >= 400 && response.status < 500 && response.status !== 429 && feed.id !== 'gdelt-doc') {
        break;
      }
    } catch (error) {
      lastError = { error: 'fetch_failed', message: error.message };
    }
  }

  if (!succeeded) {
    if (feed.id === 'nasa-firms') {
      const fireFallback = await buildArcgisFireFallback();
      if (fireFallback) {
        return {
          error: null,
          status: 200,
          data: {
            body: fireFallback.body,
            contentType: fireFallback.contentType,
            httpStatus: fireFallback.httpStatus,
            fetchedUrl: fireFallback.fetchedUrl || null
          }
        };
      }
    }
    const fallback = shouldUseLiveFallback(options) ? await fetchLiveFallback(feed.id) : null;
    if (fallback) {
      const shouldPromotePublishedSnapshot = feed.id === 'federal-register'
        || feed.id === 'federal-register-transport'
        || feed.id === 'federal-register-ed'
        || feed.id === 'fda-medwatch'
        || feed.id === 'gdelt-doc'
        || feed.id === 'nasa-firms'
        || feed.id === 'transport-opensky';
      console.log(JSON.stringify({
        event: 'mcp_raw_fetch',
        feedId: feed.id,
        ok: true,
        httpStatus: fallback.httpStatus || 200,
        elapsedMs: Date.now() - startedAt,
        proxyUsed: shouldPromotePublishedSnapshot ? null : 'live-cache'
      }));
      return {
        body: fallback.body,
        httpStatus: fallback.httpStatus || 200,
        contentType: fallback.contentType || 'application/json',
        fetchedUrl: `${LIVE_BASE}/data/feeds/${encodeURIComponent(feed.id)}.json`,
        proxyUsed: shouldPromotePublishedSnapshot ? null : 'live-cache',
        fallbackUsed: shouldPromotePublishedSnapshot ? false : true,
        responseHeaders: null
      };
    }
    console.log(JSON.stringify({
      event: 'mcp_raw_fetch',
      feedId: feed.id,
      ok: false,
      httpStatus: response?.status || null,
      elapsedMs: Date.now() - startedAt,
      proxyUsed: usedProxy || null
    }));
    return {
      ...lastError,
      fetchedUrl: stripSecretsFromUrl(fetchedUrl),
      proxyUsed: usedProxy,
      fallbackUsed: Boolean(usedProxy && usedProxy !== primaryProxy && !configuredProxies.includes(usedProxy)),
      responseHeaders
    };
  }

  console.log(JSON.stringify({
    event: 'mcp_raw_fetch',
    feedId: feed.id,
    ok: true,
    httpStatus: response.status,
    elapsedMs: Date.now() - startedAt,
    proxyUsed: usedProxy || null
  }));
  return {
    body,
    httpStatus: response.status,
    contentType: response.headers.get('content-type') || null,
    fetchedUrl: stripSecretsFromUrl(fetchedUrl),
    proxyUsed: usedProxy,
    fallbackUsed: Boolean(usedProxy && usedProxy !== primaryProxy && !configuredProxies.includes(usedProxy)),
    responseHeaders
  };
}

async function fetchMoneyFlows({ query, start, end, limit, matchMode, minScore, entities }) {
  if (!query) {
    return { error: 'missing_query', message: 'Query parameter q is required.' };
  }
  const safeLimit = Math.min(MONEY_FLOW_MAX_LIMIT, Math.max(20, Number(limit) || 60));
  const perSourceLimit = Math.max(10, Math.floor(safeLimit / 4));
  const range = resolveMoneyFlowRange(start, end);
  const queryProfile = buildMoneyQueryProfile(query, { matchMode, minScore, entities });
  const queryVariants = queryProfile.searchTerms.slice(0, MONEY_QUERY_VARIANT_LIMIT);
  const dataGovKey = process.env.DATA_GOV || '';
  const fecKey = dataGovKey || 'DEMO_KEY';
  const samGovKey = process.env.SAMGOV_API_KEY || dataGovKey;

  const results = {
    query,
    range: { start: range.startIso, end: range.endIso },
    generatedAt: new Date().toISOString(),
    matchMode: queryProfile.matchMode,
    minScore: Math.round(queryProfile.matchThreshold * 100),
    aliasExpansion: queryProfile.aliasExpansion || null,
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
    const items = (data.results || []).filter((item) => (
      findBestMoneyNameMatch(queryProfile, item.client?.name, item.registrant?.name)
      || findMoneyKeywordMatch(queryProfile, item.lobbying_activities?.map((act) => act.description))
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
    const items = (data.results || []).filter((item) => findBestMoneyNameMatch(queryProfile,
      item.registrant?.name,
      item.lobbyist?.last_name,
      item.contribution_items?.map((entry) => [entry.contributor_name, entry.payee_name].filter(Boolean))
    ));
    return { items };
  });

  const usaTasks = queryVariants.map(async (searchTerm) => {
    const url = 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/';
    const awardCodes = ['A', 'B', 'C', 'D', 'IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'];
    const payload = {
      filters: {
        keywords: [searchTerm],
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
  });

  const fecTasks = queryVariants.map(async (searchTerm) => {
    const url = new URL('https://api.open.fec.gov/v1/schedules/schedule_a/');
    url.searchParams.set('api_key', fecKey);
    url.searchParams.set('per_page', String(perSourceLimit));
    url.searchParams.set('sort', '-contribution_receipt_amount');
    url.searchParams.set('contributor_name', searchTerm);
    url.searchParams.set('min_date', range.startIso);
    url.searchParams.set('max_date', range.endIso);
    const { response, data } = await fetchJsonWithTimeout(url.toString(), {
      headers: { 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0', 'Accept': 'application/json' }
    }, MONEY_FLOW_TIMEOUT_MS);
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    return { items: data.results || [] };
  });

  const samTasks = queryVariants.map((searchTerm) => fetchSamEntities({
    query: searchTerm,
    perSourceLimit,
    samGovKey
  }));

  const [ldaResults, ldaContribResults, usaResults, fecResults, samResults] = await Promise.all([
    settleMoneyTasks(ldaTasks),
    settleMoneyTasks(ldaContribTasks),
    settleMoneyTasks(usaTasks),
    settleMoneyTasks(fecTasks),
    settleMoneyTasks(samTasks)
  ]);

  const ldaErrors = ldaResults.find((entry) => entry.error)?.error || null;
  const ldaContribErrors = ldaContribResults.find((entry) => entry.error)?.error || null;

  results.sources.lda = {
    count: ldaResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: ldaErrors || null
  };
  results.sources.ldaContributions = {
    count: ldaContribResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: ldaContribErrors || null
  };
  results.sources.usaspending = {
    count: usaResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: usaResults.find((entry) => entry.error)?.error || null
  };
  results.sources.fec = {
    count: fecResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: fecResults.find((entry) => entry.error)?.error || null
  };
  results.sources.sam = {
    count: samResults.reduce((acc, entry) => acc + (entry.items?.length || 0), 0),
    error: samResults.find((entry) => entry.error)?.error || null,
    retryAfterSeconds: samResults.find((entry) => entry.retryAfterSeconds)?.retryAfterSeconds || null,
    retryAt: samResults.find((entry) => entry.retryAt)?.retryAt || null
  };

  const items = [];
  const usaItems = uniqueItemsBy(
    usaResults.flatMap((entry) => entry.items || []),
    buildUsaspendingTransactionKey
  );
  const fecItems = uniqueItemsBy(
    fecResults.flatMap((entry) => entry.items || []),
    (item) => item.sub_id || item.contribution_receipt_id
  );
  const samItems = uniqueItemsBy(
    samResults.flatMap((entry) => entry.items || []),
    (item) => item.entityRegistration?.ueiSAM || item.entityRegistration?.uei || item.entityRegistration?.cageCode || item.entityRegistration?.legalBusinessName
  );

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
      keywordMatchFields: item.lobbying_activities?.map((act) => act.description),
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
      moneyMatchFields: [
        item.registrant?.name,
        item.lobbyist?.last_name,
        item.contribution_items?.map((entry) => [entry.contributor_name, entry.payee_name].filter(Boolean))
      ],
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

  usaItems.forEach((item) => {
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
      keywordMatchFields: [item['Transaction Description']],
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

  fecItems.forEach((item) => {
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

  samItems.forEach((item) => {
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
    .map((item) => attachMoneyMatch(queryProfile, item))
    .filter(Boolean)
    .map((item) => ({
      ...item,
      score: scoreMoneyItem(item)
    }))
    .sort((a, b) => (b.matchScore - a.matchScore) || (b.score - a.score))
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

function buildMcpServer() {
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
    const payload = filtered.map((feed) => {
      const configuration = getFeedConfiguration(feed);
      return {
        id: feed.id,
        name: feed.name,
        category: feed.category,
        format: feed.format,
        supportsQuery: Boolean(feed.supportsQuery),
        supportsParams: Boolean(feed.supportsParams),
        paramStrategy: feed.paramStrategy || null,
        requiresKey: Boolean(feed.requiresKey),
        requiresConfig: Boolean(feed.requiresConfig),
        configured: configuration.configured,
        configuration,
        coveredStates: configuration.coveredStates || null,
        docsUrl: feed.docsUrl || null,
        urlTemplate: feed.url || null,
        tags: feed.tags || [],
        jurisdictionLevel: feed.jurisdictionLevel || null,
        defaultParams: feed.defaultParams || null,
        capabilities: feed.capabilities || []
      };
    });
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

    return {
      content: [{ type: 'text', text: `Fetched ${sourceId} (${result.httpStatus})` }],
      structuredContent: buildRawStructuredContent({ sourceId, feed, result, responseFormat })
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

    const result = await fetchRaw(feed, { start, end, params, history: true });
    if (result.error) {
      return {
        content: [{ type: 'text', text: `History fetch failed: ${result.message || result.error}` }],
        structuredContent: {
          error: result.error,
          sourceId,
          message: result.message,
          httpStatus: result.httpStatus || null
        }
      };
    }

    const responseFormat = format || 'text';

    return {
      content: [{ type: 'text', text: `Fetched history for ${sourceId}` }],
      structuredContent: buildRawStructuredContent({
        sourceId,
        feed,
        result,
        responseFormat,
        range: { start, end }
      })
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
      limit: z.number().optional(),
      matchMode: z.enum(['strict', 'normal', 'loose']).optional(),
      minScore: z.number().optional(),
      entities: z.array(z.string()).optional()
    })
  },
  async ({ query, start, end, limit, matchMode, minScore, entities }) => {
    const payload = await fetchMoneyFlows({ query, start, end, limit, matchMode, minScore, entities });
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

    const normalizedQuery = String(query || '').trim().toLowerCase();
    const result = await fetchRaw(feed, { query, start, end, params, limit });
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
    const filtered = normalizedQuery
      ? items.filter((item) => matchesStateAwareSignalQuery(item, normalizedQuery, feed))
      : items;
    const sliced = Number.isFinite(limit) ? filtered.slice(0, Math.max(1, limit)) : filtered;

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
      query: z.string().optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    })
  },
  async ({ sourceId, id, query, params }) => {
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = await fetchRaw(feed, { query, params });
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
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      maxSources: z.number().optional(),
      perSourceLimit: z.number().optional(),
      totalLimit: z.number().optional()
    })
  },
  async ({ query, categories, sources, start, end, params, maxSources, perSourceLimit, totalLimit }) => {
    const selectedFeeds = selectSmartFeeds({ query, categories, sources, maxSources });
    const perLimit = Math.max(1, Number(perSourceLimit) || 25);
    const normalizedQuery = String(query || '').trim().toLowerCase();

    const signals = [];
    const sourcesChecked = [];
    const warnings = [];

    for (const feed of selectedFeeds) {
      const translatedQuery = feed.supportsQuery ? translateQueryForFeed(feed, query || feed.defaultQuery || '') : undefined;
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchRaw(feed, { query: translatedQuery, start, end, params });
      if (result.error) {
        const configuration = getFeedConfiguration(feed);
        sourcesChecked.push({
          sourceId: feed.id,
          sourceName: feed.name,
          ok: false,
          error: result.error,
          message: result.message || null,
          configured: configuration.configured,
          configuration,
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
      const filtered = normalizedQuery && shouldFilterSmartFeedLocally({ feed, query, categories, sources })
        ? items.filter((item) => matchesSignalQuery(item, normalizedQuery, feed))
        : items;

      if (result.fallbackUsed) {
        warnings.push(`Fetched ${feed.name} via proxy (${result.proxyUsed || 'unknown'}).`);
      }

      sourcesChecked.push({
        sourceId: feed.id,
        sourceName: feed.name,
        ok: true,
        configured: getFeedConfiguration(feed).configured,
        count: filtered.length,
        fetchedUrl: result.fetchedUrl || null,
        proxyUsed: result.proxyUsed || null,
        fallbackUsed: Boolean(result.fallbackUsed)
      });

      signals.push(...filtered.slice(0, perLimit));
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
        sourcesQueried: sourcesChecked,
        sourcesChecked,
        warnings: warnings.length ? warnings : null
      }
    };
  }
);

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const start = Date.now();
  res.on('finish', () => logRequest(req, res, start));
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
      tools: ['catalog.sources', 'raw.fetch', 'raw.history', 'money.flows', 'signals.list', 'signals.get', 'search.smart'],
      toolInputs: {
        'money.flows': {
          optional: ['start', 'end', 'limit', 'matchMode', 'minScore', 'entities'],
          matchModes: ['strict', 'normal', 'loose']
        },
        'catalog.sources': {
          outputFields: ['configured', 'coveredStates', 'configuration.requiredEnv', 'configuration.optionalEnv']
        }
      },
      sourceHighlights: {
        congressCommitteeBills: ['congress-ew-bills', 'congress-help-bills'],
        education: ['federal-register-ed']
      },
      acceptedEnv: [
        'DATA_GOV',
        'OPENSTATES',
        'EIA',
        'NASA_FIRMS',
        'OPEN_AQ',
        'EARTHDATA_NASA',
        'OPENSKY_CLIENTID',
        'OPENSKY_CLIENTSECRET',
        'SAMGOV_API_KEY',
        'STATE_CONNECTOR_BASE_URL',
        'STATE_CONNECTOR_API_KEY',
        'STATE_CONNECTOR_KEY_HEADER',
        'MONEY_ENTITY_ALIASES_PATH',
        'ACLED_PROXY',
        'ALLOWED_ORIGINS',
        'SR_LIVE_BASE'
      ]
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
    setCors(res, origin);
    const accept = String(req.headers.accept || '').toLowerCase();
    if (!accept || (!accept.includes('application/json') || !accept.includes('text/event-stream'))) {
      req.headers.accept = 'application/json, text/event-stream';
    }
    try {
      const mcpServer = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      if (typeof transport.close === 'function') {
        await transport.close();
      }
      if (typeof mcpServer.close === 'function') {
        await mcpServer.close();
      }
      return;
    } catch (error) {
      return sendJson(res, 500, { error: 'mcp_transport_failed', message: error.message }, origin);
    }
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

if (isMainModule) {
  httpServer.listen(PORT, () => {
    console.log(`MCP proxy listening on ${PORT}`);
  });
}
