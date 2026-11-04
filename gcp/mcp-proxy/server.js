import { fetchMoneyFlows } from './money-flows.js';
export { attachMoneyMatch, buildMoneyQueryProfile, buildUsaspendingTransactionKey, findBestMoneyNameMatch, resolveMoneyAliasExpansion, settleMoneyTasks, summarizeMoneyEntities } from './money-flows.js';
import http from 'http';
import { inspectBlsPayload, sanitizeBlsBody, isDefaultBlsRequest } from './bls.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mergeFeedParams, normalizeJurisdictionCode, sanitizeParamsObject, US_STATE_CODES } from './state-signals.js';
import { normalizeCsvSignals, normalizeJsonSignals, parseJsonFeedPayload } from './signal-normalization.js';
import { redactDiagnosticText, redactDiagnosticUrl, sanitizeDiagnosticPayload, sanitizeEiaPayload } from './public-payload-safety.js';
import { nasaFirmsCoordinates, normalizeNasaFirmsItems, parseFirmsTimestamp, parseNasaFirmsRows, selectNewestFirmsItems } from './firms-csv.js';
import { buildFirmsPrimaryFailureDiagnostic, buildGdacsPrimaryFailureDiagnostic } from './firms-diagnostics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 8080;
// Match SDK 1.32.1's byte default; leave ample room for shallow scalar/array/record inputs.
export const MCP_REQUEST_LIMITS = Object.freeze({ maxRequestBodySize: 4 * 1024 * 1024, maxToolInputElements: 10000 });
const FEEDS_PATH = join(__dirname, 'feeds.json');
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
const DEFAULT_FEED_PROXY_BASE = 'https://situation-room-feed-382918878290.us-central1.run.app';
const FEED_PROXY_BASE = String(process.env.SR_FEED_PROXY_BASE || DEFAULT_FEED_PROXY_BASE).replace(/\/+$/, '');
const OPENSKY_CLIENTID = String(process.env.OPENSKY_CLIENTID || '').trim();
const OPENSKY_CLIENTSECRET = String(process.env.OPENSKY_CLIENTSECRET || '').trim();
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const ACLED_PROXY = process.env.ACLED_PROXY || '';
const DEFAULT_LOOKBACK_DAYS = Number(process.env.DEFAULT_LOOKBACK_DAYS || 30);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const STATE_LEGISLATION_ALL_STATES_CONCURRENCY = 2;
const STATE_LEGISLATION_ALL_STATES_TIMEOUT_MS = 4500;
const STATE_LEGISLATION_ALL_STATES_PER_STATE = 3;
const STATE_LEGISLATION_ALL_STATES_MAX_ATTEMPTS = 8;
const STATE_CONNECTOR_BASE_URL = String(process.env.STATE_CONNECTOR_BASE_URL || '').trim().replace(/\/+$/, '');
const STATE_CONNECTOR_API_KEY = String(process.env.STATE_CONNECTOR_API_KEY || '').trim();
const STATE_CONNECTOR_KEY_HEADER = String(process.env.STATE_CONNECTOR_KEY_HEADER || 'X-API-Key').trim() || 'X-API-Key';
const STATE_CONNECTOR_DEFAULT_LIMIT = 20;
const STATE_CONNECTOR_MAX_LIMIT = 100;
const STATE_CONNECTOR_COVERED_STATES = ['CA', 'FL', 'MN', 'NC', 'NY', 'TX', 'VA'];
const OPENSTATES_CACHE_TTL_MS = Number(process.env.OPENSTATES_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const OPENSTATES_ERROR_CACHE_TTL_MS = Number(process.env.OPENSTATES_ERROR_CACHE_TTL_MS || 5 * 60 * 1000);
const OPENSTATES_AGGREGATE_CACHE_TTL_MS = Number(process.env.OPENSTATES_AGGREGATE_CACHE_TTL_MS || 10 * 60 * 1000);
const OPENSTATES_MIN_INTERVAL_MS = Number(process.env.OPENSTATES_MIN_INTERVAL_MS || 1000);
const OPENSTATES_CACHE_MAX_ENTRIES = Number(process.env.OPENSTATES_CACHE_MAX_ENTRIES || 256);
const OPENSTATES_MAX_CONCURRENT = Number(process.env.OPENSTATES_MAX_CONCURRENT || 2);
const OPENSTATES_MAX_QUEUE = Number(process.env.OPENSTATES_MAX_QUEUE || 64);
const OPENSTATES_QUEUE_TIMEOUT_MS = Number(process.env.OPENSTATES_QUEUE_TIMEOUT_MS || 12 * 60 * 1000);

const openStatesRawCache = new Map();
let openStatesPaceChain = Promise.resolve();
let openStatesNextRequestAt = 0;
let openStatesActiveRequests = 0;
const openStatesWaitQueue = [];
let openSkyToken = null;
let openSkyTokenExpiresAt = 0;

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

function extractUpstreamErrorMessage(status, body = '') {
  const fallback = `HTTP ${status}`;
  const text = String(body || '').trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.message || parsed?.error_description || parsed?.error || parsed?.detail;
    if (message) return `${fallback}: ${String(message).slice(0, 240)}`;
  } catch {
    // fall through to text snippet
  }
  return `${fallback}: ${text.replace(/\s+/g, ' ').slice(0, 240)}`;
}

function normalizeFetchErrorCode(error) {
  if (error?.name === 'AbortError' || error?.code === 20 || error?.code === 'ABORT_ERR') {
    return 'timeout';
  }
  return typeof error?.code === 'string' && error.code ? error.code : 'fetch_failed';
}

function getRequestOrigin(req) {
  const host = req.headers.host;
  if (!host) return '';
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  if (proto) return `${proto}://${host}`;
  return `https://${host}`;
}

function stripSecretsFromUrl(rawUrl) {
  return redactDiagnosticUrl(rawUrl);
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
  return normalizeNasaFirmsItems(data, source);
}

async function buildArcgisFireFallback() {
  const fireFeed = feedsConfig.feeds.find((feed) => feed.id === 'arcgis-hms-fire');
  if (!fireFeed?.url) return null;
  try {
    const response = await fetchWithTimeout(fireFeed.url, {
      headers: { 'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0', 'Accept': 'application/json' }
    }, 15000);
    if (!response.ok) return null;
    const data = await response.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    const items = selectNewestFirmsItems((function* () {
      for (const feature of features) {
        const props = feature?.properties || {};
        const coords = feature?.geometry?.coordinates || [];
        const geo = nasaFirmsCoordinates({ latitude: coords[1], longitude: coords[0] });
        if (!geo) continue;
        const publishedAt = parseFirmsTimestamp(props.acq_date || props.date);
        yield {
          title: props.name || props.NAME || props.fire_name || 'Fire detection',
          summary: props.frp || props.FRP ? `FRP ${props.frp || props.FRP}` : 'NOAA HMS fire detection',
          latitude: geo.lat,
          longitude: geo.lon,
          publishedAt,
          source: 'NOAA HMS',
          alertType: 'Fire'
        };
      }
    })());
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
    item?.jurisdictionCodes,
    item?.jurisdictionNames,
    item?.areaDesc,
    item?.description,
    item?.event,
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

export function matchesSignalQuery(item, normalizedQuery, feed) {
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
  if (feed?.id === 'nws-alerts') return matchesSignalQuery(item, normalizedQuery, feed);
  if (isStateSignal(item, feed)) {
    return buildStateSignalSearchHaystack(item, feed).includes(normalizedQuery);
  }
  // Preserve existing non-state behavior by avoiding additional local filtering.
  return true;
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

function getRuntimeOnlyParamNames(feed) {
  return new Set(feed?.congressCommitteeBills ? ['congress'] : []);
}

function getCongressDateWindow(congress) {
  const congressNumber = Number.parseInt(String(congress || ''), 10);
  if (!Number.isFinite(congressNumber) || congressNumber < 1) return null;
  const startYear = 1789 + ((congressNumber - 1) * 2);
  return {
    fromDateTime: `${startYear}-01-03T00:00:00Z`,
    toDateTime: `${startYear + 2}-01-03T00:00:00Z`
  };
}

function applyCongressCommitteeDateWindow(url, feed, params = {}) {
  if (!feed?.congressCommitteeBills) return url;
  const window = getCongressDateWindow(params.congress || feed.defaultParams?.congress);
  if (!window) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has('fromDateTime')) parsed.searchParams.set('fromDateTime', window.fromDateTime);
  if (!parsed.searchParams.has('toDateTime')) parsed.searchParams.set('toDateTime', window.toDateTime);
  return parsed.toString();
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
    const runtimeOnlyParamNames = getRuntimeOnlyParamNames(feed);
    Object.entries(mergedParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (templateParamNames.has(key)) return;
      if (runtimeOnlyParamNames.has(key)) return;
      parsed.searchParams.set(key, String(value));
    });
    url = parsed.toString();
  }

  url = applyCongressCommitteeDateWindow(url, feed, mergedParams);

  return url;
}

function isStateLegislationAllStatesRequest(feed, params = {}) {
  if (!feed || feed.id !== 'state-legislation') return false;
  if (feed.paramStrategy !== 'openstates-jurisdiction') return false;
  return !params.jurisdiction && !params.q;
}

function isOpenStatesFeed(feed) {
  return feed?.keyGroup === 'openstates' || feed?.id === 'state-legislation';
}

function isStateConnectorFeed(feed) {
  return feed?.id === 'state-rulemaking' || feed?.id === 'state-executive-orders';
}

export function getStateConnectorCoverage(state = '') {
  const requested = String(state || '').trim();
  if (!requested) return { coverageStatus: 'PARTIAL', requestedState: null };
  const code = normalizeJurisdictionCode(requested);
  if (!code) return { coverageStatus: 'INVALID_STATE', requestedState: requested };
  return {
    coverageStatus: STATE_CONNECTOR_COVERED_STATES.includes(code) ? 'SUPPORTED' : 'UNSUPPORTED',
    requestedState: code
  };
}

function coverageFields(result) {
  if (!result?.coverageStatus) return {};
  return {
    coverageStatus: result.coverageStatus,
    requestedState: result.requestedState || null,
    coveredStates: result.coveredStates || STATE_CONNECTOR_COVERED_STATES,
    verifiedZeroResults: Boolean(result.verifiedZeroResults)
  };
}

function verifiedStateConnectorZero(parsed, results, stateCode, signalType) {
  const meta = parsed?.meta;
  return Boolean(
    stateCode
    && results.length === 0
    && meta?.verifiedZeroResults === true
    && meta?.state === stateCode
    && meta?.signalType === signalType
    && meta?.coverageStatus === 'SUPPORTED'
    && meta?.count === 0
    && meta?.partial === false
    && meta?.adapterCount === 1
    && Array.isArray(meta?.errors) && meta.errors.length === 0
    && Array.isArray(meta?.coveredStates) && meta.coveredStates.includes(stateCode)
    && Number.isFinite(Date.parse(meta?.generatedAt))
  );
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
    let lastStatus = null;
    for (const nextProxy of attemptProxies) {
      const target = nextProxy ? applyProxy(requestUrl, nextProxy) : requestUrl;
      try {
        const response = nextProxy
          ? await fetchWithTimeout(target, { headers }, perStateTimeoutMs)
          : await fetchOpenStatesWithControls(target, { headers }, perStateTimeoutMs);
        if (response.ok) {
          return { response, proxyUsed: nextProxy || null };
        }
        lastResponse = response;
        lastStatus = response.status;
      } catch (error) {
        lastStatus = normalizeFetchErrorCode(error);
        // try next proxy
      }
    }
    return { response: lastResponse, proxyUsed: null, status: lastResponse?.status || lastStatus || 'fetch_failed' };
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
        const { response, status } = await fetchState(requestUrl.toString());
        if (!response || !response.ok) {
          failedStates.push({ code, status: response?.status || status || 'fetch_failed' });
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
    const firstStatus = failedStates.find((entry) => entry?.status)?.status || 'fetch_failed';
    const upstreamStatus = Number.isFinite(Number(firstStatus)) ? Number(firstStatus) : null;
    return {
      error: 'fetch_failed',
      ...(upstreamStatus ? { upstreamStatus, httpStatus: upstreamStatus } : {}),
      ...(typeof firstStatus === 'string' && firstStatus !== 'fetch_failed' ? { code: firstStatus } : {}),
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
    fallbackUsed: false,
    aggregatePartial: aggregateMeta.partial
  };
}

async function fetchStateConnectorRaw(feed, options = {}) {
  const mergedParams = feed.supportsParams
    ? mergeFeedParams(feed, options.params)
    : sanitizeParamsObject(options.params);
  const signalType = normalizeStateConnectorSignalType(
    mergedParams.signalType,
    Array.isArray(feed?.capabilities) && feed.capabilities.length ? feed.capabilities[0] : ''
  );
  const { coverageStatus, requestedState: stateCode } = getStateConnectorCoverage(
    options.params?.state
    || options.params?.jurisdictionCode
    || options.params?.jurisdiction
    || mergedParams.state
    || mergedParams.jurisdictionCode
    || mergedParams.jurisdiction
  );
  if (coverageStatus === 'INVALID_STATE' || coverageStatus === 'UNSUPPORTED') {
    return {
      error: coverageStatus === 'INVALID_STATE' ? 'invalid_state' : 'unsupported_state',
      httpStatus: 400,
      message: coverageStatus === 'INVALID_STATE'
        ? `Invalid state: ${stateCode}.`
        : `${feed.id} does not cover ${stateCode}. Covered states: ${STATE_CONNECTOR_COVERED_STATES.join(', ')}. Check the state's official primary sources directly.`,
      coverageStatus,
      requestedState: stateCode,
      coveredStates: STATE_CONNECTOR_COVERED_STATES
    };
  }
  if (!STATE_CONNECTOR_BASE_URL || !STATE_CONNECTOR_API_KEY) {
    return { error: 'config_required', message: 'State connector provider is not configured.', coverageStatus, requestedState: stateCode || null };
  }
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
      let providerError = null;
      try { providerError = JSON.parse(text)?.error; } catch { /* Not JSON. */ }
      return {
        error: providerError === 'state_not_covered' ? 'unsupported_state' : 'fetch_failed',
        httpStatus: response.status,
        message: providerError === 'state_not_covered' ? `${stateCode} is not covered by the state connector provider.` : `HTTP ${response.status}`,
        coverageStatus: providerError === 'state_not_covered' ? 'UNSUPPORTED' : coverageStatus,
        requestedState: stateCode,
        coveredStates: STATE_CONNECTOR_COVERED_STATES,
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

    if (!Array.isArray(parsed?.results)) {
      return { error: 'invalid_response', httpStatus: 502, message: 'State connector response has no results array.', coverageStatus };
    }
    const results = parsed.results;
    const verifiedZeroResults = verifiedStateConnectorZero(parsed, results, stateCode, signalType);
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
          count: normalizedResults.length,
          coverageStatus,
          verifiedZeroResults
        }
      }),
      httpStatus: 200,
      contentType: 'application/json',
      coverageStatus,
      requestedState: stateCode || null,
      verifiedZeroResults,
      fetchedUrl: stripSecretsFromUrl(requestUrl.toString()),
      proxyUsed: null,
      fallbackUsed: false
    };
  } catch (error) {
    return {
      error: 'fetch_failed',
      message: error?.message || 'State connector fetch failed.',
      coverageStatus,
      fetchedUrl: stripSecretsFromUrl(requestUrl.toString()),
      proxyUsed: null,
      fallbackUsed: false
    };
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS, consumeResponse = null) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // Opt-in consumers keep cancellation active until the response body is read.
    return consumeResponse ? await consumeResponse(response) : response;
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

async function fetchLiveFallback(feedId, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!feedId) return null;
  const url = `${LIVE_BASE}/data/feeds/${feedId}.json?ts=${Date.now()}`;
  try {
    const consumeResponse = feedId === 'gdacs-alerts'
      ? async (response) => response.ok ? response.json() : null
      : null;
    const result = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0',
        'Accept': 'application/json, text/plain, */*'
      }
    }, timeoutMs, consumeResponse);
    const payload = consumeResponse ? result : result.ok ? await result.json() : null;
    if (!payload || payload.error || !payload.body) return null;
    if (feedId === 'bls-cpi' && (payload.id !== feedId || payload.httpStatus !== 200
      || inspectBlsPayload(payload.body, 'CUUR0000SA0').error)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function fetchFeedProxyFallback(feed, options = {}, {
  base = FEED_PROXY_BASE,
  fetchImpl = fetch,
  timeoutMs = FETCH_TIMEOUT_MS
} = {}) {
  if (!feed?.id || !base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { query, params } = options;
    const response = await fetchImpl(`${base}/api/feed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0'
      },
      body: JSON.stringify({
        id: feed.id,
        force: true,
        ...(query ? { query } : {}),
        ...(params && Object.keys(params).length ? { params } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload?.body || payload.error) return null;
    if (feed.id === 'gdacs-alerts' && (payload.stale || payload.fallback
      || Number(payload.httpStatus) < 200 || Number(payload.httpStatus) >= 300)) return null;
    const contentType = payload.contentType || '';
    if (feed.format === 'rss' && !isLikelyRssPayload(contentType, payload.body)) return null;
    if (feed.format === 'json' && isJsonHtmlError(contentType, payload.body)) return null;
    return {
      body: payload.body,
      httpStatus: payload.httpStatus || response.status,
      contentType,
      fetchedUrl: `${base}/api/feed`,
      proxyUsed: 'feed-proxy',
      fallbackUsed: true,
      responseHeaders: null
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

function parseJsonBody(body, feed) {
  try {
    return parseJsonFeedPayload(body, feed);
  } catch {
    return null;
  }
}

export function buildRawStructuredContent({ sourceId, feed, result, responseFormat, range = null }) {
  const contentIsJson = isJsonContentType(result.contentType);
  const parsed = (responseFormat === 'json' || contentIsJson) ? parseJsonBody(result.body, feed) : null;
  return {
    sourceId,
    ...(feed.id === 'bls-cpi' ? { acquiredAt: result.acquiredAt || null, cacheHit: Boolean(result.cacheHit),
      upstreamHttpStatus: result.upstreamHttpStatus || null, upstreamError: result.upstreamError || null } : {}),
    ...coverageFields(result),
    ...(range ? { range } : {}),
    contentType: result.contentType,
    url: stripSecretsFromUrl(feed.url),
    fetchedUrl: stripSecretsFromUrl(result.fetchedUrl) || null,
    proxyUsed: result.proxyUsed || null,
    fallbackUsed: Boolean(result.fallbackUsed),
    warning: fallbackWarning(result),
    responseHeaders: result.responseHeaders || null,
    body: responseFormat === 'text' || responseFormat === 'csv' ? result.body : undefined,
    data: parsed
  };
}

function fallbackWarning(result) {
  if (!result.fallbackUsed) return null;
  if (result.proxyUsed === 'arcgis-hms-fire') return 'NASA FIRMS unavailable; returning NOAA HMS fire detections.';
  if (result.proxyUsed === 'live-cache') return 'Upstream unavailable; returning a published cache snapshot. Check record dates and source attribution.';
  return `Fetched via fallback (${result.proxyUsed || 'unknown'}).`;
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
  if (feed?.id === 'nws-alerts') return true;
  return (Array.isArray(categories) && categories.length > 0)
    || (Array.isArray(sources) && sources.length > 0);
}

function normalizeComparableParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function paramsEqual(left = {}, right = {}) {
  const leftEntries = Object.entries(normalizeComparableParams(left));
  const rightEntries = Object.entries(normalizeComparableParams(right));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const [rightKey, rightValue] = rightEntries[index] || [];
    return key === rightKey && value === rightValue;
  });
}

function getFallbackComparableParams(feed, params = {}) {
  if (feed?.supportsParams) {
    return normalizeComparableParams(mergeFeedParams(feed, params));
  }
  return normalizeComparableParams(sanitizeParamsObject(params));
}

function getFallbackComparableQuery(feed, options = {}) {
  if (feed?.supportsQuery) {
    return String(options.query || feed.defaultQuery || '').trim();
  }
  return String(options.query || '').trim();
}

function getFallbackComparableUrl(feed, options = {}) {
  try {
    return buildFeedUrl(feed, { ...options, key: '' });
  } catch {
    return '';
  }
}

function isFallbackDefaultQuery(feed, requestQuery) {
  const defaultQuery = String(feed?.defaultQuery || '').trim();
  if (requestQuery === defaultQuery) return true;
  if (feed?.id === 'google-news-search' && requestQuery === `${defaultQuery} when:1d`) {
    return true;
  }
  return false;
}

export function shouldUseLiveFallback(feedOrOptions = {}, maybeOptions = null) {
  const legacyCall = maybeOptions === null;
  const feed = legacyCall ? null : feedOrOptions;
  const options = legacyCall ? feedOrOptions : (maybeOptions || {});
  if (options?.history || options?.start || options?.end) return false;
  if (!feed) return true;
  if (feed.id === 'openaq-api') return false;
  if (feed.id === 'bls-cpi') return isDefaultBlsRequest(feed, options);

  const requestQuery = getFallbackComparableQuery(feed, options);
  if (feed.supportsQuery) {
    if (!isFallbackDefaultQuery(feed, requestQuery)) return false;
  } else if (requestQuery) {
    const defaultUrl = getFallbackComparableUrl(feed, {});
    const requestUrl = getFallbackComparableUrl(feed, options);
    if (requestUrl !== defaultUrl) return false;
  }

  const defaultParams = getFallbackComparableParams(feed, {});
  const requestParams = getFallbackComparableParams(feed, options.params);
  return paramsEqual(defaultParams, requestParams);
}

export function dedupeSignals(items) {
  const seen = new Set();
  const output = [];
  items.forEach((item) => {
    const key = item.observationKey || item.url || `${item.title || ''}|${item.publishedAt || ''}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(item);
  });
  return output;
}

export function createItemId(item) {
  if (item.observationKey) {
    return createHash('sha1').update(item.observationKey).digest('hex').slice(0, 12);
  }
  const stableSourceId = item.apiUrl || item.docId || item.documentNumber || item.packageId || item.sourceId || '';
  const base = stableSourceId
    ? `${stableSourceId}|${item.url || ''}`
    : `${item.url || ''}|${item.title || ''}|${item.publishedAt || ''}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 12);
}

function buildOpenStatesRawCacheKey(feed, url) {
  try {
    const parsed = new URL(url);
    ['api_key', 'key', 'token', 'apikey'].forEach((param) => parsed.searchParams.delete(param));
    const sortedParams = [...parsed.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
      ));
    parsed.search = '';
    sortedParams.forEach(([key, value]) => parsed.searchParams.append(key, value));
    return `${feed?.id || 'openstates'}:${parsed.toString()}`;
  } catch {
    return `${feed?.id || 'openstates'}:${stripSecretsFromUrl(url)}`;
  }
}

function cloneFetchResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    responseHeaders: result.responseHeaders ? { ...result.responseHeaders } : null
  };
}

export function getOpenStatesCachedRaw(cacheKey) {
  const cached = openStatesRawCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    openStatesRawCache.delete(cacheKey);
    return null;
  }
  openStatesRawCache.delete(cacheKey);
  openStatesRawCache.set(cacheKey, cached);
  return cloneFetchResult(cached.result);
}

export function setOpenStatesCachedRaw(cacheKey, result, ttlMs = OPENSTATES_CACHE_TTL_MS) {
  if (!cacheKey || !result || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
  if (!Number.isFinite(OPENSTATES_CACHE_MAX_ENTRIES) || OPENSTATES_CACHE_MAX_ENTRIES <= 0) return;
  const now = Date.now();
  for (const [key, entry] of openStatesRawCache.entries()) {
    if (!entry || now >= entry.expiresAt) {
      openStatesRawCache.delete(key);
    }
  }
  while (openStatesRawCache.size >= OPENSTATES_CACHE_MAX_ENTRIES) {
    const oldestKey = openStatesRawCache.keys().next().value;
    if (!oldestKey) break;
    openStatesRawCache.delete(oldestKey);
  }
  openStatesRawCache.set(cacheKey, {
    expiresAt: now + ttlMs,
    result: cloneFetchResult(result)
  });
}

export function resetOpenStatesRawCacheForTest() {
  openStatesRawCache.clear();
}

export function getOpenStatesSuccessCacheTtl(feed) {
  if (!Number.isFinite(OPENSTATES_CACHE_TTL_MS) || OPENSTATES_CACHE_TTL_MS <= 0) {
    return OPENSTATES_CACHE_TTL_MS;
  }
  const feedTtlMs = Number(feed?.ttlMinutes) * 60 * 1000;
  if (!Number.isFinite(feedTtlMs) || feedTtlMs <= 0) return OPENSTATES_CACHE_TTL_MS;
  return Math.min(OPENSTATES_CACHE_TTL_MS, feedTtlMs);
}

function getOpenStatesErrorCacheTtl(response) {
  const retryMeta = response?.status === 429 ? parseRetryAfter(response.headers?.get('retry-after')) : null;
  if (retryMeta?.retryAfterSeconds) {
    return Math.max(OPENSTATES_ERROR_CACHE_TTL_MS, retryMeta.retryAfterSeconds * 1000);
  }
  return OPENSTATES_ERROR_CACHE_TTL_MS;
}

async function paceOpenStatesRequest() {
  if (!Number.isFinite(OPENSTATES_MIN_INTERVAL_MS) || OPENSTATES_MIN_INTERVAL_MS <= 0) return;
  const run = openStatesPaceChain.then(async () => {
    const waitMs = Math.max(0, openStatesNextRequestAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    openStatesNextRequestAt = Date.now() + OPENSTATES_MIN_INTERVAL_MS;
  });
  openStatesPaceChain = run.catch(() => {});
  await run;
}

async function acquireOpenStatesSlot() {
  if (!Number.isFinite(OPENSTATES_MAX_CONCURRENT) || OPENSTATES_MAX_CONCURRENT <= 0) {
    return () => {};
  }
  if (openStatesActiveRequests < OPENSTATES_MAX_CONCURRENT) {
    openStatesActiveRequests += 1;
    return () => releaseOpenStatesSlot();
  }
  if (
    Number.isFinite(OPENSTATES_MAX_QUEUE)
    && OPENSTATES_MAX_QUEUE >= 0
    && openStatesWaitQueue.length >= OPENSTATES_MAX_QUEUE
  ) {
    const error = new Error('OpenStates request queue is full; retry later.');
    error.code = 'openstates_queue_full';
    throw error;
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const waiter = () => {
      if (timer) clearTimeout(timer);
      openStatesActiveRequests += 1;
      resolve(() => releaseOpenStatesSlot());
    };
    if (Number.isFinite(OPENSTATES_QUEUE_TIMEOUT_MS) && OPENSTATES_QUEUE_TIMEOUT_MS >= 0) {
      timer = setTimeout(() => {
        const index = openStatesWaitQueue.indexOf(waiter);
        if (index >= 0) openStatesWaitQueue.splice(index, 1);
        const error = new Error('OpenStates request queue wait timed out; retry later.');
        error.code = 'openstates_queue_timeout';
        reject(error);
      }, OPENSTATES_QUEUE_TIMEOUT_MS);
    }
    openStatesWaitQueue.push(waiter);
  });
}

function releaseOpenStatesSlot() {
  openStatesActiveRequests = Math.max(0, openStatesActiveRequests - 1);
  const next = openStatesWaitQueue.shift();
  if (next) next();
}

async function fetchOpenStatesWithControls(url, requestOptions, timeoutMs) {
  const release = await acquireOpenStatesSlot();
  try {
    await paceOpenStatesRequest();
    return await fetchWithTimeout(url, requestOptions, timeoutMs);
  } finally {
    release();
  }
}

function retiredSource(sourceId) {
  return sourceId === 'stooq-quote' ? {
    sourceId, error: 'source_retired', status: 'retired', available: false, httpStatus: 410,
    message: 'TSR retired the Stooq integration; no replacement is active.', fallbackUsed: false
  } : null;
}

function retiredToolResult(sourceId) {
  const result = retiredSource(sourceId);
  return result ? {
    isError: true,
    content: [{ type: 'text', text: result.message }],
    structuredContent: result
  } : null;
}

let blsRawCache = null;
let blsRawPending = null;
export function resetBlsRawCacheForTest() { blsRawCache = null; blsRawPending = null; }

export async function fetchRaw(feed, options = {}) {
  return sanitizeDiagnosticPayload(await fetchRawWithCache(feed, options));
}

async function fetchRawWithCache(feed, options) {
  if (!isDefaultBlsRequest(feed, options)) return fetchRawUncached(feed, options);
  // Collapse raw/list/Feed burst acquisitions without hiding long-lived quota failures.
  const ttlMs = Math.min((feed.ttlMinutes || 1) * 60000, 60000);
  if (blsRawCache && Date.now() - blsRawCache.acquiredAt < ttlMs) {
    return { ...structuredClone(blsRawCache), cacheHit: true };
  }
  if (!blsRawPending) {
    blsRawPending = fetchRawUncached(feed, options).then(result => {
      const value = { ...result, acquiredAt: Date.now(), cacheHit: false };
      if (!value.error && !value.fallbackUsed && !inspectBlsPayload(value.body, 'CUUR0000SA0').error) blsRawCache = value;
      return value;
    }).finally(() => { blsRawPending = null; });
  }
  return structuredClone(await blsRawPending);
}

async function fetchRawUncached(feed, options) {
  const retired = retiredSource(feed?.id);
  if (retired) return retired;
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
  if (feed.id === 'openaq-api') {
    let sourceUrl;
    try { sourceUrl = new URL(feed.url); } catch {}
    if (!sourceUrl || sourceUrl.origin !== 'https://api.openaq.org'
      || sourceUrl.pathname !== '/v3/locations'
      || sourceUrl.username || sourceUrl.password || sourceUrl.hash) {
      return { error: 'invalid_source_url', message: 'OpenAQ requires its canonical HTTPS locations endpoint.' };
    }
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
  const openStatesRequest = isOpenStatesFeed(feed);
  const openStatesCacheKey = openStatesRequest ? buildOpenStatesRawCacheKey(feed, keyedUrl) : null;
  const effectiveParams = feed.supportsParams
    ? mergeFeedParams(feed, options.params)
    : sanitizeParamsObject(options.params);
  if (openStatesCacheKey) {
    const cached = getOpenStatesCachedRaw(openStatesCacheKey);
    if (cached) {
      console.log(JSON.stringify({
        event: 'mcp_raw_fetch',
        feedId: feed.id,
        ok: !cached.error,
        httpStatus: cached.httpStatus || cached.upstreamStatus || null,
        elapsedMs: Date.now() - startedAt,
        proxyUsed: cached.proxyUsed || null,
        cache: 'openstates'
      }));
      return cached;
    }
  }
  const requestHeaders = {
    ...headers,
    'Accept': feed.format === 'rss'
      ? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain, */*'
      : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': feedsConfig.app?.userAgent || 'SituationRoomMCP/1.0'
  };
  if (isStateLegislationAllStatesRequest(feed, effectiveParams)) {
    const aggregatePayload = await fetchAllStatesLegislationRaw(feed, keyedUrl, requestHeaders, primaryProxy, totalTimeoutMs);
    if (openStatesCacheKey && !aggregatePayload.error) {
      const aggregateTtlMs = aggregatePayload.aggregatePartial
        ? OPENSTATES_AGGREGATE_CACHE_TTL_MS
        : getOpenStatesSuccessCacheTtl(feed);
      setOpenStatesCachedRaw(openStatesCacheKey, aggregatePayload, aggregateTtlMs);
    } else if (
      openStatesCacheKey
      && aggregatePayload.error
      && [429, 500, 502, 503, 504].includes(Number(aggregatePayload.httpStatus || aggregatePayload.upstreamStatus))
    ) {
      setOpenStatesCachedRaw(openStatesCacheKey, aggregatePayload, OPENSTATES_ERROR_CACHE_TTL_MS);
    }
    return aggregatePayload;
  }
  // Keep OpenAQ's authenticated request on its provider origin.
  const directOnlyRequest = openStatesRequest || feed.id === 'openaq-api' || feed.id === 'bls-cpi';
  const attemptList = directOnlyRequest ? [null] : [null, ...configuredProxies, optionProxy, ...FALLBACK_PROXIES];
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
  let firmsPrimaryFailure = null;
  let gdacsPrimaryFailure = null;
  let usedProxy = null;
  let fetchedUrl = null;
  let responseHeaders = null;
  let succeeded = false;
  const isEonetFeed = feed?.id === 'eonet-events';
  const gdacsDeadline = feed.id === 'gdacs-alerts' ? startedAt + totalTimeoutMs : null;
  // Keep a quarter of GDACS's caller budget for the snapshot, plus response margin.
  const gdacsSnapshotReserveMs = gdacsDeadline === null ? 0 : Math.floor(totalTimeoutMs * 0.25);
  const gdacsReturnReserveMs = gdacsDeadline === null ? 0 : Math.min(1000, totalTimeoutMs * 0.05);
  const gdacsRecoveryDeadline = gdacsDeadline === null ? null : gdacsDeadline - gdacsSnapshotReserveMs - gdacsReturnReserveMs;
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
    const remainingGdacsMs = gdacsRecoveryDeadline === null ? Infinity : gdacsRecoveryDeadline - Date.now();
    if (remainingGdacsMs <= 0) {
      lastError = { error: 'fetch_failed', message: 'GDACS upstream recovery budget exhausted.', code: 'timeout' };
      break;
    }
    const proxy = attempts[index];
    const proxiedUrl = proxy ? applyProxy(keyedUrl, proxy) : keyedUrl;
    fetchedUrl = proxiedUrl;
    const perAttemptTimeoutMs = Math.min(remainingGdacsMs, isRssFeed
      ? (index === 0 ? rssDirectTimeoutMs : rssFallbackTimeoutMs)
      : isEonetFeed
        ? (index === 0 ? eonetDirectTimeoutMs : eonetFallbackTimeoutMs)
      : totalTimeoutMs);
    let firmsPayloadDiagnostic = null;
    try {
      if (gdacsDeadline !== null || feed.id === 'openaq-api' || feed.id === 'bls-cpi') {
        [response, body] = await fetchWithTimeout(proxiedUrl, {
          headers: requestHeaders,
          ...(feed.id === 'openaq-api' || feed.id === 'bls-cpi' ? { redirect: 'error' } : {})
        }, perAttemptTimeoutMs,
          async (upstream) => [upstream, await upstream.text()]);
      } else {
        response = openStatesRequest && !proxy
          ? await fetchOpenStatesWithControls(proxiedUrl, { headers: requestHeaders }, perAttemptTimeoutMs)
          : await fetchWithTimeout(proxiedUrl, { headers: requestHeaders }, perAttemptTimeoutMs);
        body = await response.text();
      }
      responseHeaders = extractSafeResponseHeaders(response.headers);
      if (feed.id === 'bls-cpi') {
        const inspection = inspectBlsPayload(body, isDefaultBlsRequest(feed, options) ? 'CUUR0000SA0' : null);
        body = sanitizeBlsBody(body);
        if (response.ok && inspection.error) {
          lastError = { error: inspection.error, message: inspection.message, httpStatus: response.status };
          break;
        }
      }
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
        if (feed.id === 'nws-alerts' && !Array.isArray(parseJsonBody(body, feed)?.features)) {
          lastError = { error: 'invalid_response', message: 'NWS response is missing its alert features array.', httpStatus: response.status };
          continue;
        }
        if (feed.id === 'nasa-firms') {
          firmsPayloadDiagnostic = {};
          try {
            const items = buildNasaFirmsItems(parseNasaFirmsRows(body, response.headers.get('content-type'), firmsPayloadDiagnostic));
            firmsPayloadDiagnostic.normalizedItemCount = items.length;
            if (!items.length) {
              lastError = {
                error: 'empty_payload',
                httpStatus: response.status,
                message: 'NASA FIRMS returned no usable geolocated detections.',
              };
              continue;
            }
            body = JSON.stringify({ items });
          } catch {
            lastError = {
              error: 'invalid_response',
              httpStatus: response.status,
              message: 'NASA FIRMS returned an invalid detection payload.',
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
        upstreamStatus: response.status,
        message: feed.id === 'nasa-firms' || feed.id === 'bls-cpi' ? 'HTTP ' + response.status : extractUpstreamErrorMessage(response.status, body),
        body: feed.id === 'nasa-firms' ? undefined : body
      };
      // Client-side upstream errors are not recoverable via proxy fallback.
      if (!isRssFeed && response.status >= 400 && response.status < 500 && response.status !== 429 && feed.id !== 'gdelt-doc') {
        break;
      }
    } catch (error) {
      lastError = { error: 'fetch_failed', message: feed.id === 'bls-cpi' ? 'BLS request failed.' : error.message, code: normalizeFetchErrorCode(error) };
      if (feed.id === 'nasa-firms' && index === 0) {
        firmsPrimaryFailure = buildFirmsPrimaryFailureDiagnostic(error);
      }
      if (feed.id === 'gdacs-alerts' && index === 0) {
        gdacsPrimaryFailure = buildGdacsPrimaryFailureDiagnostic(error);
      }
    } finally {
      if (feed.id === 'nasa-firms' && index === 0 && !succeeded && !firmsPrimaryFailure) {
        firmsPrimaryFailure = buildFirmsPrimaryFailureDiagnostic({ ...lastError, payloadDiagnostic: firmsPayloadDiagnostic });
      }
      if (feed.id === 'gdacs-alerts' && index === 0 && !succeeded && !gdacsPrimaryFailure) {
        gdacsPrimaryFailure = buildGdacsPrimaryFailureDiagnostic(lastError);
      }
    }
  }

  if (!succeeded) {
    if (feed.id === 'gdacs-alerts') {
      console.warn(JSON.stringify(gdacsPrimaryFailure || buildGdacsPrimaryFailureDiagnostic(lastError)));
    }
    if (feed.id === 'nasa-firms') {
      console.warn(JSON.stringify(firmsPrimaryFailure || buildFirmsPrimaryFailureDiagnostic(lastError)));
      const fireFallback = await buildArcgisFireFallback();
      if (fireFallback) {
        return {
          body: fireFallback.body,
          contentType: fireFallback.contentType,
          httpStatus: fireFallback.httpStatus,
          fetchedUrl: fireFallback.fetchedUrl || null,
          proxyUsed: 'arcgis-hms-fire',
          fallbackUsed: true,
          responseHeaders: null
        };
      }
    }
    const feedProxyTimeoutMs = gdacsRecoveryDeadline === null ? totalTimeoutMs : Math.max(0, gdacsRecoveryDeadline - Date.now());
    const feedProxyFallback = (feed.id === 'google-news-search' || feed.id === 'gdacs-alerts') && feedProxyTimeoutMs > 0
      ? await fetchFeedProxyFallback(feed, options, { timeoutMs: feedProxyTimeoutMs })
      : null;
    if (feedProxyFallback) {
      return feedProxyFallback;
    }
    const snapshotTimeoutMs = gdacsDeadline === null ? FETCH_TIMEOUT_MS
      : Math.max(0, Math.min(gdacsSnapshotReserveMs, gdacsDeadline - Date.now() - gdacsReturnReserveMs));
    const fallback = shouldUseLiveFallback(feed, options) && snapshotTimeoutMs > 0
      ? await fetchLiveFallback(feed.id, snapshotTimeoutMs)
      : null;
    if (fallback) {
      const shouldPromotePublishedSnapshot = feed.id === 'federal-register'
        || feed.id === 'federal-register-transport'
        || feed.id === 'federal-register-ed'
        || feed.id === 'fda-medwatch'
        || feed.id === 'gdelt-doc'
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
        body: feed.id === 'bls-cpi' ? sanitizeBlsBody(fallback.body, 'CUUR0000SA0') : fallback.body,
        ...(feed.id === 'bls-cpi' ? { upstreamHttpStatus: lastError?.httpStatus || null, upstreamError: lastError?.error || null } : {}),
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
    const failureResult = {
      ...lastError,
      fetchedUrl: stripSecretsFromUrl(fetchedUrl),
      proxyUsed: usedProxy,
      fallbackUsed: Boolean(usedProxy && usedProxy !== primaryProxy && !configuredProxies.includes(usedProxy)),
      responseHeaders
    };
    if (
      openStatesCacheKey
      && failureResult.error
      && [429, 500, 502, 503, 504].includes(Number(failureResult.httpStatus || failureResult.upstreamStatus))
    ) {
      setOpenStatesCachedRaw(openStatesCacheKey, failureResult, getOpenStatesErrorCacheTtl(response));
    }
    return failureResult;
  }

  console.log(JSON.stringify({
    event: 'mcp_raw_fetch',
    feedId: feed.id,
    ok: true,
    httpStatus: response.status,
    elapsedMs: Date.now() - startedAt,
    proxyUsed: usedProxy || null
  }));
  const successResult = {
    body,
    httpStatus: response.status,
    contentType: feed.id === 'nasa-firms' ? 'application/json' : (response.headers.get('content-type') || null),
    fetchedUrl: stripSecretsFromUrl(fetchedUrl),
    proxyUsed: usedProxy,
    fallbackUsed: Boolean(usedProxy && usedProxy !== primaryProxy && !configuredProxies.includes(usedProxy)),
    responseHeaders
  };
  if (openStatesCacheKey && !usedProxy) {
    setOpenStatesCachedRaw(openStatesCacheKey, successResult, getOpenStatesSuccessCacheTtl(feed));
  }
  return successResult;
}

export function buildMcpServer() {
  const server = new McpServer({
    name: 'Situation Room MCP',
    version: '0.1.0'
  }, { maxToolInputElements: MCP_REQUEST_LIMITS.maxToolInputElements });

server.registerTool(
  'catalog.sources',
  {
    title: 'Catalog Sources',
    description: 'List available sources, formats, and capabilities.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: z.object({
      category: z.string().optional(),
      state: z.string().optional()
    })
  },
  async ({ category, state }) => {
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
        coverageStatus: isStateConnectorFeed(feed) ? getStateConnectorCoverage(state).coverageStatus : null,
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    const retired = retiredToolResult(sourceId);
    if (retired) return retired;
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = await fetchRaw(feed, { query, start, end, params });
    const safeResult = sanitizeEiaPayload(feed, result);
    if (safeResult.error) {
      return {
        content: [{ type: 'text', text: `Fetch failed: ${safeResult.message || safeResult.error}` }],
        structuredContent: {
          error: safeResult.error,
          ...coverageFields(safeResult),
          code: safeResult.code || null,
          message: safeResult.message,
          httpStatus: safeResult.httpStatus || null,
          upstreamStatus: safeResult.upstreamStatus || safeResult.httpStatus || null,
          fetchedUrl: safeResult.fetchedUrl || null,
          fallbackUsed: Boolean(safeResult.fallbackUsed),
          proxyUsed: safeResult.proxyUsed || null
        }
      };
    }

    const responseFormat = format || 'text';

    return {
      content: [{ type: 'text', text: `Fetched ${sourceId} (${result.httpStatus})` }],
      structuredContent: buildRawStructuredContent({ sourceId, feed, result: safeResult, responseFormat })
    };
  }
);

server.registerTool(
  'raw.history',
  {
    title: 'Fetch Raw History',
    description: 'Fetch raw history for a source with start/end range when available.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: z.object({
      sourceId: z.string(),
      start: z.string(),
      end: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      format: z.enum(['json', 'csv', 'text']).optional()
    })
  },
  async ({ sourceId, start, end, params, format }) => {
    const retired = retiredToolResult(sourceId);
    if (retired) return retired;
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = sanitizeEiaPayload(feed, await fetchRaw(feed, { start, end, params, history: true }));
    if (result.error) {
      return {
        content: [{ type: 'text', text: `History fetch failed: ${result.message || result.error}` }],
        structuredContent: {
          error: result.error,
          ...coverageFields(result),
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
    description: 'Ranked discovery sample from LDA, USAspending transactions, FEC receipts and SAM registrations. Includes source coverage; subtotals apply only to returned rows. SAM is identity evidence, not awards. No resumable component cursors.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
      content: [{ type: 'text', text: `Money flows: ${payload.items?.length || 0} sampled items; returned-row subtotals only. Check sources for partial or unavailable coverage.` }],
      structuredContent: payload
    };
  }
);

server.registerTool(
  'signals.list',
  {
    title: 'List Normalized Signals',
    description: 'Return normalized signal items for a source (best-effort parsing).',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    const retired = retiredToolResult(sourceId);
    if (retired) return retired;
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const normalizedQuery = String(query || '').trim().toLowerCase();
    const result = await fetchRaw(feed, { query, start, end, params, limit });
    const safeResult = sanitizeEiaPayload(feed, result);
    if (safeResult.error) {
      return {
        content: [{ type: 'text', text: `Signals fetch failed: ${safeResult.message || safeResult.error}` }],
        structuredContent: { error: safeResult.error, ...coverageFields(safeResult), message: safeResult.message, httpStatus: safeResult.httpStatus || null }
      };
    }

    const items = normalizeSignals(safeResult.body, feed).map((item) => ({
      ...item,
      id: createItemId(item),
      sourceId,
      source: item.source || feed.name
    }));
    const filtered = normalizedQuery
      ? items.filter((item) => matchesStateAwareSignalQuery(item, normalizedQuery, feed))
      : items;
    const sliced = Number.isFinite(limit) ? filtered.slice(0, Math.max(1, limit)) : filtered;

    const warning = fallbackWarning(safeResult);
    return {
      content: [{ type: 'text', text: `Signals: ${sliced.length}` }],
      structuredContent: {
        sourceId,
        ...coverageFields(safeResult),
        items: sliced,
        fetchedUrl: safeResult.fetchedUrl || null,
        proxyUsed: safeResult.proxyUsed || null,
        fallbackUsed: Boolean(safeResult.fallbackUsed),
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: z.object({
      sourceId: z.string(),
      id: z.string(),
      query: z.string().optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    })
  },
  async ({ sourceId, id, query, params }) => {
    const retired = retiredToolResult(sourceId);
    if (retired) return retired;
    const feed = feeds.find((entry) => entry.id === sourceId);
    if (!feed) {
      return {
        content: [{ type: 'text', text: `Unknown source: ${sourceId}` }],
        structuredContent: { error: 'unknown_source' }
      };
    }

    const result = sanitizeEiaPayload(feed, await fetchRaw(feed, { query, params }));
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Signal fetch failed: ${result.message || result.error}` }],
        structuredContent: { error: result.error, ...coverageFields(result), message: result.message, httpStatus: result.httpStatus || null }
      };
    }

    const items = normalizeSignals(result.body, feed).map((item) => ({
      ...item,
      id: createItemId(item),
      sourceId,
      source: item.source || feed.name
    }));
    const match = items.find((item) => item.id === id) || null;

    const warning = fallbackWarning(result);
    return {
      content: [{ type: 'text', text: match ? `Signal ${id}` : `Signal ${id} not found` }],
      structuredContent: {
        sourceId,
        ...coverageFields(result),
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    const retired = (sources || []).map(retiredToolResult).find(Boolean);
    if (retired) return retired;
    const selectedFeeds = selectSmartFeeds({ query, categories, sources, maxSources });
    const perLimit = Math.max(1, Number(perSourceLimit) || 25);
    const normalizedQuery = String(query || '').trim().toLowerCase();

    const signals = [];
    const sourcesChecked = [];
    const warnings = [];

    for (const feed of selectedFeeds) {
      const translatedQuery = feed.supportsQuery ? translateQueryForFeed(feed, query || feed.defaultQuery || '') : undefined;
      // eslint-disable-next-line no-await-in-loop
      const result = sanitizeEiaPayload(feed, await fetchRaw(feed, { query: translatedQuery, start, end, params }));
      if (result.error) {
        const configuration = getFeedConfiguration(feed);
        sourcesChecked.push({
          sourceId: feed.id,
          sourceName: feed.name,
          ok: false,
          error: result.error,
          ...coverageFields(result),
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
        warnings.push(`${feed.name}: ${fallbackWarning(result)}`);
      }

      sourcesChecked.push({
        sourceId: feed.id,
        sourceName: feed.name,
        ok: true,
        ...coverageFields(result),
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

export const httpServer = http.createServer(async (req, res) => {
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
    setCors(res, origin);
    const accept = String(req.headers.accept || '').toLowerCase();
    if (!accept || (!accept.includes('application/json') || !accept.includes('text/event-stream'))) {
      req.headers.accept = 'application/json, text/event-stream';
      // The SDK's Node adapter constructs Web Headers from rawHeaders, not headers.
      for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
        if (req.rawHeaders[i].toLowerCase() === 'accept') req.rawHeaders.splice(i, 2);
      }
      req.rawHeaders.push('Accept', req.headers.accept);
    }
    const mcpServer = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      maxRequestBodySize: MCP_REQUEST_LIMITS.maxRequestBodySize
    });
    try {
      await mcpServer.connect(transport);
      // The SDK owns byte-bounded reading/decoding/parsing. A parsedBody argument bypasses it.
      await transport.handleRequest(req, res);
      return;
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        return sendJson(res, 500, { error: 'mcp_transport_failed', message: redactDiagnosticText(error.message) }, origin);
      }
      if (!res.writableEnded) res.destroy();
    } finally {
      try {
        await transport.close();
      } finally {
        await mcpServer.close();
      }
    }
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

if (isMainModule) {
  httpServer.listen(PORT, () => {
    console.log(`MCP proxy listening on ${PORT}`);
  });
}
