import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '../../..');
export const FEEDS_PATH = path.join(ROOT_DIR, 'data', 'feeds.json');
export const MONITORING_PATH = path.join(ROOT_DIR, 'data', 'feed-monitoring.json');

export const CORE_FEED_IDS = new Set([
  'google-news-us',
  'bbc-world',
  'guardian-world',
  'pbs-headlines',
  'usgs-quakes-hour',
  'nws-alerts',
  'eonet-events',
  'cdc-travel-notices',
  'coinpaprika-global',
  'coinpaprika-tickers',
  'treasury-debt',
  'bls-cpi',
  'energy-eia',
  'energy-eia-brent',
  'energy-eia-ng',
  'eia-today',
  'congress-api',
  'congress-reports',
  'state-legislation',
  'govinfo-api',
  'foia-api',
  'openaq-api',
  'nasa-firms',
  'cisa-kev'
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadFeedRegistry() {
  return readJson(FEEDS_PATH);
}

export function loadMonitoringOverrides() {
  if (!fs.existsSync(MONITORING_PATH)) return {};
  return readJson(MONITORING_PATH);
}

export function buildDefaultSampleParams(feed) {
  const sampleParams = {};
  if (feed?.supportsQuery) {
    sampleParams.query = feed.defaultQuery || 'monitoring';
  }
  if (feed?.supportsParams && feed?.defaultParams && typeof feed.defaultParams === 'object') {
    Object.assign(sampleParams, feed.defaultParams);
  }
  return sampleParams;
}

export function buildDefaultInvariants(feed) {
  const invariants = ['feed-fetch', 'signal-normalization', 'freshness'];
  if (feed?.format === 'rss') {
    invariants.push('rss-structure');
  }
  if (feed?.format === 'json' || feed?.format === 'arcgis') {
    invariants.push('json-structure');
  }
  if (feed?.supportsParams) {
    invariants.push('param-acceptance');
  }
  return [...new Set(invariants)];
}

export function deriveFreshnessWindowMinutes(feed, appConfig = {}) {
  const ttlMinutes = Number(feed?.ttlMinutes || appConfig?.defaultRefreshMinutes || 60);
  return Math.max(ttlMinutes * 3, 60);
}

export function resolveMonitoringEntry(feed, override = {}, appConfig = {}) {
  const tier = override.tier || (CORE_FEED_IDS.has(feed.id) ? 'core' : 'standard');
  return {
    id: feed.id,
    name: feed.name,
    category: feed.category,
    format: feed.format,
    tier,
    auditEnabled: override.auditEnabled !== false,
    requiresKey: Boolean(feed.requiresKey),
    requiresConfig: Boolean(feed.requiresConfig),
    supportsParams: Boolean(feed.supportsParams),
    supportsQuery: Boolean(feed.supportsQuery),
    ttlMinutes: Number(feed.ttlMinutes || appConfig.defaultRefreshMinutes || 60),
    timeoutMs: Number(override.timeoutMs || feed.timeoutMs || appConfig.timeoutMs || 30000),
    docsUrl: Object.prototype.hasOwnProperty.call(override, 'docsUrl')
      ? override.docsUrl
      : (feed.docsUrl || null),
    changelogUrl: Object.prototype.hasOwnProperty.call(override, 'changelogUrl')
      ? override.changelogUrl
      : null,
    statusUrl: Object.prototype.hasOwnProperty.call(override, 'statusUrl')
      ? override.statusUrl
      : null,
    supportUrl: Object.prototype.hasOwnProperty.call(override, 'supportUrl')
      ? override.supportUrl
      : null,
    freshnessWindowMinutes: Number(override.freshnessWindowMinutes || deriveFreshnessWindowMinutes(feed, appConfig)),
    sampleParams: {
      ...buildDefaultSampleParams(feed),
      ...(override.sampleParams || {})
    },
    invariants: Array.isArray(override.invariants) && override.invariants.length
      ? [...new Set(override.invariants)]
      : buildDefaultInvariants(feed),
    knownUpstreamQuirks: Array.isArray(override.knownUpstreamQuirks)
      ? override.knownUpstreamQuirks
      : []
  };
}

export function loadMonitoringCatalog() {
  const registry = loadFeedRegistry();
  const overrides = loadMonitoringOverrides();
  const entries = (registry.feeds || []).map((feed) => resolveMonitoringEntry(feed, overrides[feed.id] || {}, registry.app || {}));
  return {
    app: registry.app || {},
    feeds: registry.feeds || [],
    entries,
    entriesById: Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  };
}
