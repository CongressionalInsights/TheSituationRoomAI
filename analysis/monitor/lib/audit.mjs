import {
  callCongressDetail,
  callFeedProxy,
  callMcpTool,
  fetchStaticFeed,
  sanitizeObservedUrl
} from './client.mjs';
import { createAlert, applyKnownUpstreamQuirks, dedupeAlerts } from './reporting.mjs';

const PRIMARY_ARRAY_PATHS = [
  ['items'],
  ['results'],
  ['data'],
  ['features'],
  ['events'],
  ['alerts'],
  ['vulnerabilities'],
  ['locations'],
  ['records'],
  ['response', 'data'],
  ['response', 'results'],
  ['response', 'items'],
  ['Results', 'Issues'],
  ['Results', 'series', 0, 'data'],
  ['series', 0, 'data'],
  ['series'],
  ['bills'],
  ['reports'],
  ['committeeReports'],
  ['committeeMeetings'],
  ['nominations'],
  ['treaties'],
  ['amendments'],
  ['houseVotes']
];

const SKIPPABLE_ERRORS = new Set(['requires_config']);

function getPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current == null) return null;
    current = current[key];
  }
  return current;
}

function coerceTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const parsedMonth = Date.parse(`${raw}-01T00:00:00Z`);
    return Number.isFinite(parsedMonth) ? parsedMonth : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractTimestamp(item) {
  if (!item || typeof item !== 'object') return null;
  const candidates = [
    item.publishedAt,
    item.updatedAt,
    item.updated,
    item.pubDate,
    item.date,
    item.datetime,
    item.timestamp,
    item.createdAt,
    item.dateAdded,
    item.effectiveDate,
    item.latest_action_date,
    item.record_date,
    item.period,
    item.acq_date,
    item.lastModified
  ];
  for (const candidate of candidates) {
    const parsed = coerceTimestamp(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function extractIdentifier(item) {
  if (!item || typeof item !== 'object') return null;
  return item.id
    || item.identifier
    || item.url
    || item.link
    || item.citation
    || item.cveID
    || item.docId
    || item.title
    || item.name
    || item.locationId
    || null;
}

function parseRssSummary(xml = '') {
  const itemCount = (xml.match(/<item\b/gi) || []).length || (xml.match(/<entry\b/gi) || []).length;
  const identifiers = [];
  const titles = [...xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].slice(0, 5);
  for (const match of titles) {
    identifiers.push(match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
  }
  const dateMatches = [
    ...xml.matchAll(/<(?:pubDate|updated|published|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|updated|published|dc:date)>/gi)
  ];
  const newestTimestamp = dateMatches
    .map((match) => coerceTimestamp(match[1]))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
  return {
    itemCount,
    newestTimestamp,
    identifiers
  };
}

function parseBody(feed, payload) {
  if (!payload) {
    return { body: null, parseError: 'empty_payload' };
  }
  if (payload.body && typeof payload.body === 'object') {
    return { body: payload.body, parseError: null };
  }
  if (payload.data && typeof payload.data === 'object') {
    return { body: payload.data, parseError: null };
  }
  const bodyText = typeof payload.body === 'string' ? payload.body : '';
  if (feed.format === 'rss') {
    return { body: bodyText, parseError: null };
  }
  if (!bodyText) {
    return { body: null, parseError: null };
  }
  try {
    return { body: JSON.parse(bodyText), parseError: null };
  } catch (error) {
    return { body: null, parseError: error.message };
  }
}

function findPrimaryItems(body) {
  if (Array.isArray(body)) return body;
  for (const path of PRIMARY_ARRAY_PATHS) {
    const value = getPath(body, path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function summarizeProxyPayload(feed, payload, transport = {}) {
  const { body, parseError } = parseBody(feed, payload);
  if (feed.format === 'rss') {
    const rss = parseRssSummary(typeof body === 'string' ? body : '');
    return {
      httpStatus: payload?.httpStatus ?? transport.status ?? null,
      error: payload?.error || transport.error || null,
      errorMessage: payload?.message || transport.error || null,
      stale: Boolean(payload?.stale),
      fetchedAt: payload?.fetchedAt || null,
      fallback: payload?.fallback || null,
      contentType: payload?.contentType || null,
      parseError,
      rawItemCount: rss.itemCount,
      newestTimestamp: rss.newestTimestamp,
      identifiers: rss.identifiers,
      sampleItems: []
    };
  }

  const items = body ? findPrimaryItems(body) : [];
  const newestTimestamp = items
    .map((item) => extractTimestamp(item))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
  const identifiers = items
    .map((item) => extractIdentifier(item))
    .filter(Boolean)
    .slice(0, 5);

  return {
    httpStatus: payload?.httpStatus ?? transport.status ?? null,
    error: payload?.error || transport.error || null,
    errorMessage: payload?.message || transport.error || null,
    stale: Boolean(payload?.stale),
    fetchedAt: payload?.fetchedAt || null,
    fallback: payload?.fallback || null,
    contentType: payload?.contentType || null,
    parseError,
    rawItemCount: items.length,
    newestTimestamp,
    identifiers,
    sampleItems: items.slice(0, 10),
    parsedBody: body
  };
}

function summarizeMcpRaw(feed, result) {
  const payload = result?.data || {};
  const rawWrapper = {
    body: payload.body ?? payload.data ?? null,
    data: payload.data ?? null,
    contentType: payload.contentType || null,
    httpStatus: payload.httpStatus || result?.status || null,
    error: payload.error || result?.error || null,
    message: payload.message || result?.message || null
  };
  const summary = summarizeProxyPayload(feed, rawWrapper, result || {});
  summary.fetchedUrl = payload.fetchedUrl || null;
  if (summary.fetchedUrl) {
    summary.fetchedUrl = sanitizeObservedUrl(summary.fetchedUrl);
  }
  summary.proxyUsed = payload.proxyUsed || null;
  summary.fallbackUsed = Boolean(payload.fallbackUsed);
  summary.responseHeaders = payload.responseHeaders || null;
  return summary;
}

function summarizeSignals(result) {
  const payload = result?.data || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    error: payload.error || result?.error || null,
    errorMessage: payload.message || result?.message || null,
    count: items.length,
    items,
    newestTimestamp: items
      .map((item) => extractTimestamp(item))
      .filter(Boolean)
      .sort((a, b) => b - a)[0] || null,
    identifiers: items
      .map((item) => extractIdentifier(item))
      .filter(Boolean)
      .slice(0, 5),
    fetchedUrl: payload.fetchedUrl || null,
    ...(payload.fetchedUrl ? { fetchedUrl: sanitizeObservedUrl(payload.fetchedUrl) } : {}),
    proxyUsed: payload.proxyUsed || null,
    fallbackUsed: Boolean(payload.fallbackUsed),
    responseHeaders: payload.responseHeaders || null
  };
}

function summarizeStatic(feed, result) {
  if (!result) return { skipped: true };
  if (result.error) {
    return {
      error: result.error,
      errorMessage: result.error,
      count: 0,
      newestTimestamp: null,
      identifiers: []
    };
  }
  return summarizeProxyPayload(feed, result.data || {}, result);
}

function isDescending(items = []) {
  let previous = null;
  for (const item of items) {
    const stamp = extractTimestamp(item);
    if (!stamp) continue;
    if (previous !== null && stamp > previous) return false;
    previous = stamp;
  }
  return true;
}

function extractStateCode(sampleParams = {}) {
  const raw = sampleParams.jurisdiction || sampleParams.state || sampleParams.jurisdictionCode || '';
  const match = String(raw).match(/state:([a-z]{2})/i);
  if (match) return match[1].toUpperCase();
  return String(raw || '').slice(0, 2).toUpperCase();
}

function hasGeoCoordinates(item) {
  const lat = item?.geo?.lat ?? item?.latitude ?? item?.lat;
  const lon = item?.geo?.lon ?? item?.longitude ?? item?.lon;
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
}

function extractCongressCitations(payload) {
  const data = payload?.data || payload?.parsedBody || payload || {};
  const reports = data?.reports || data?.committeeReports || data?.committeeReport || [];
  return Array.isArray(reports)
    ? reports.map((report) => report.citation || report.number || report.title).filter(Boolean).slice(0, 5)
    : [];
}

async function evaluateCommitteeReportSortHealth(base, timeoutMs) {
  const descUrl = 'https://api.congress.gov/v3/committee-report?format=json&limit=20&sort=updateDate+desc';
  const ascUrl = 'https://api.congress.gov/v3/committee-report?format=json&limit=20&sort=updateDate+asc';
  const [desc, asc] = await Promise.all([
    callCongressDetail(base, descUrl, timeoutMs),
    callCongressDetail(base, ascUrl, timeoutMs)
  ]);
  if (!desc.ok || !asc.ok || desc.error || asc.error) {
    return {
      ok: false,
      message: 'Unable to verify committee report sort health.'
    };
  }
  const descTop = extractCongressCitations(desc.data);
  const ascTop = extractCongressCitations(asc.data);
  const same = JSON.stringify(descTop) === JSON.stringify(ascTop) && descTop.length > 0;
  return {
    ok: !same,
    message: same ? 'Committee report asc/desc top citations are identical.' : null,
    descTop,
    ascTop
  };
}

function compareStaticSnapshot(entry, liveSummary, staticSummary) {
  if (!staticSummary || staticSummary.skipped) return null;
  if (staticSummary.error) {
    return createAlert({
      feedId: entry.id,
      regressionClass: 'static-snapshot-unavailable',
      severity: 'warning',
      message: 'Published static snapshot could not be fetched.',
      metadata: { identity: 'static-snapshot' }
    });
  }
  if (liveSummary.rawItemCount > 0 && staticSummary.rawItemCount === 0) {
    return createAlert({
      feedId: entry.id,
      regressionClass: 'static-snapshot-empty',
      severity: 'warning',
      message: 'Live feed has data but the published static snapshot is empty.',
      metadata: { identity: 'static-empty' }
    });
  }
  if (liveSummary.newestTimestamp && staticSummary.newestTimestamp) {
    const ageDeltaMinutes = (liveSummary.newestTimestamp - staticSummary.newestTimestamp) / (1000 * 60);
    if (ageDeltaMinutes > entry.freshnessWindowMinutes) {
      return createAlert({
        feedId: entry.id,
        regressionClass: 'static-snapshot-stale',
        severity: 'warning',
        message: 'Published static snapshot lags live data beyond the feed freshness window.',
        metadata: { identity: 'static-stale' }
      });
    }
  }
  return null;
}

export function evaluateInvariant(name, context) {
  const { entry, proxySummary, rawSummary, signalSummary } = context;
  switch (name) {
    case 'feed-fetch':
      if (proxySummary.error && !SKIPPABLE_ERRORS.has(proxySummary.error)) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'feed-fetch-failed',
          severity: entry.tier === 'core' ? 'critical' : 'warning',
          message: proxySummary.errorMessage || proxySummary.error,
          metadata: { identity: 'feed-fetch' }
        });
      }
      return null;
    case 'signal-normalization':
      if (signalSummary.error && !SKIPPABLE_ERRORS.has(signalSummary.error)) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'signal-normalization-failed',
          severity: entry.tier === 'core' ? 'critical' : 'warning',
          message: signalSummary.errorMessage || signalSummary.error,
          metadata: { identity: 'signals' }
        });
      }
      return null;
    case 'freshness': {
      const newest = signalSummary.newestTimestamp || proxySummary.newestTimestamp || proxySummary.fetchedAt;
      if (!newest) return null;
      const ageMinutes = (Date.now() - newest) / (1000 * 60);
      if (ageMinutes > entry.freshnessWindowMinutes) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'freshness-window-exceeded',
          severity: entry.tier === 'core' ? 'warning' : 'info',
          message: `Latest data is ${Math.round(ageMinutes)} minutes old.`,
          metadata: { identity: 'freshness' }
        });
      }
      return null;
    }
    case 'rss-structure':
      if (!proxySummary.rawItemCount) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'rss-empty',
          severity: entry.tier === 'core' ? 'warning' : 'info',
          message: 'RSS payload returned no items.',
          metadata: { identity: 'rss' }
        });
      }
      return null;
    case 'json-structure':
      if (proxySummary.parseError) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'json-parse-failed',
          severity: entry.tier === 'core' ? 'critical' : 'warning',
          message: proxySummary.parseError,
          metadata: { identity: 'json-parse' }
        });
      }
      return null;
    case 'non-empty':
      if (!signalSummary.count && !proxySummary.rawItemCount) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'empty-payload',
          severity: entry.tier === 'core' ? 'warning' : 'info',
          message: 'No items were returned by the live feed.',
          metadata: { identity: 'empty' }
        });
      }
      return null;
    case 'geojson-features':
      if (!Array.isArray(proxySummary.parsedBody?.features) || !proxySummary.parsedBody.features.length) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'geojson-features-missing',
          severity: entry.tier === 'core' ? 'warning' : 'info',
          message: 'GeoJSON features array missing or empty.',
          metadata: { identity: 'geojson' }
        });
      }
      return null;
    case 'newest-descending':
    case 'descending-update-sort':
      if (!isDescending(signalSummary.items.slice(0, 10))) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'descending-sort-broken',
          severity: entry.tier === 'core' ? 'critical' : 'warning',
          message: 'Recent signal timestamps are not descending.',
          metadata: { identity: 'sort' }
        });
      }
      return null;
    case 'state-param-roundtrip': {
      const expectedState = extractStateCode(entry.sampleParams);
      const mismatched = signalSummary.items
        .slice(0, 10)
        .filter((item) => item.jurisdictionCode && item.jurisdictionCode !== expectedState);
      if (expectedState && mismatched.length) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'state-param-roundtrip',
          severity: 'critical',
          message: `State-filtered results include mismatched jurisdictions for ${expectedState}.`,
          metadata: { identity: expectedState }
        });
      }
      return null;
    }
    case 'eia-response-data':
      if (!Array.isArray(proxySummary.parsedBody?.response?.data)
        && !Array.isArray(proxySummary.parsedBody?.series?.[0]?.data)) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'eia-response-data',
          severity: 'critical',
          message: 'EIA response is missing response.data or legacy series data.',
          metadata: { identity: 'eia' }
        });
      }
      return null;
    case 'nws-alert-geometry':
      if (!proxySummary.parsedBody?.features?.some((feature) => feature?.geometry?.coordinates)) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'nws-alert-geometry',
          severity: 'critical',
          message: 'NWS alerts payload is missing geometry coordinates.',
          metadata: { identity: 'nws' }
        });
      }
      return null;
    case 'openaq-meta-results':
      if (!proxySummary.parsedBody?.meta || !Array.isArray(proxySummary.parsedBody?.results)) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'openaq-meta-results',
          severity: 'critical',
          message: 'OpenAQ response is missing meta/results.',
          metadata: { identity: 'openaq' }
        });
      }
      return null;
    case 'geo-coordinates':
      if (!signalSummary.items.some((item) => hasGeoCoordinates(item))) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'geo-coordinates-missing',
          severity: entry.tier === 'core' ? 'critical' : 'warning',
          message: 'Expected geospatial coordinates are missing.',
          metadata: { identity: 'geo' }
        });
      }
      return null;
    case 'kev-schema':
      if (!Array.isArray(proxySummary.parsedBody?.vulnerabilities) || !proxySummary.parsedBody.vulnerabilities[0]?.cveID) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'kev-schema',
          severity: 'critical',
          message: 'CISA KEV payload is missing vulnerabilities[].cveID.',
          metadata: { identity: 'kev' }
        });
      }
      return null;
    case 'coinpaprika-schema':
      if (!proxySummary.parsedBody || (proxySummary.parsedBody.market_cap_usd == null && !Array.isArray(proxySummary.parsedBody?.quotes) && !Array.isArray(proxySummary.parsedBody))) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'coinpaprika-schema',
          severity: entry.tier === 'core' ? 'critical' : 'warning',
          message: 'CoinPaprika response is missing expected market fields.',
          metadata: { identity: 'coinpaprika' }
        });
      }
      return null;
    case 'nasa-eonet-events':
      if (!Array.isArray(proxySummary.parsedBody?.events) || !proxySummary.parsedBody.events.length) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'nasa-eonet-events',
          severity: 'critical',
          message: 'NASA EONET response is missing events[].',
          metadata: { identity: 'eonet' }
        });
      }
      return null;
    case 'param-acceptance':
      if (proxySummary.error || signalSummary.error) {
        return createAlert({
          feedId: entry.id,
          regressionClass: 'param-acceptance',
          severity: entry.tier === 'core' ? 'warning' : 'info',
          message: 'Parameterized feed request failed.',
          metadata: { identity: 'params' }
        });
      }
      return null;
    default:
      return null;
  }
}

function shouldCompareStatic(entry) {
  return entry.tier === 'core' && !entry.requiresConfig;
}

async function auditEntry(entry, options) {
  const timeoutMs = Number(entry.timeoutMs || options.timeoutMs);
  const proxyTransport = await callFeedProxy(options.base, entry.id, entry.sampleParams, timeoutMs);
  const proxySummary = summarizeProxyPayload(entry, proxyTransport.data || {}, proxyTransport);

  const { query, ...params } = entry.sampleParams || {};
  const rawFormat = entry.format === 'rss' ? 'text' : 'json';
  const rawResult = await callMcpTool(options.mcp, 'raw.fetch', {
    sourceId: entry.id,
    ...(query ? { query } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    format: rawFormat
  }, timeoutMs);
  const rawSummary = summarizeMcpRaw(entry, rawResult);

  const signalResult = await callMcpTool(options.mcp, 'signals.list', {
    sourceId: entry.id,
    ...(query ? { query } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    limit: 25
  }, timeoutMs);
  const signalSummary = summarizeSignals(signalResult);

  let staticSummary = { skipped: true };
  if (options.includeStatic && options.staticBase && shouldCompareStatic(entry)) {
    const staticResult = await fetchStaticFeed(options.staticBase, entry.id, timeoutMs);
    staticSummary = summarizeStatic(entry, staticResult);
  }

  const alerts = [];
  for (const invariant of entry.invariants) {
    if (invariant === 'committee-report-sort-health') {
      const sortCheck = await evaluateCommitteeReportSortHealth(options.base, timeoutMs);
      if (!sortCheck.ok) {
        alerts.push(createAlert({
          feedId: entry.id,
          regressionClass: 'committee-report-sort-health',
          severity: 'critical',
          message: sortCheck.message || 'Committee report sort health check failed.',
          metadata: { identity: 'committee-report-sort' }
        }));
      }
      continue;
    }
    const alert = evaluateInvariant(invariant, {
      entry,
      proxySummary,
      rawSummary,
      signalSummary
    });
    if (alert) alerts.push(alert);
  }

  if (proxySummary.stale) {
    alerts.push(createAlert({
      feedId: entry.id,
      regressionClass: 'feed-stale',
      severity: 'warning',
      message: 'Feed proxy returned stale data.',
      metadata: { identity: 'stale' }
    }));
  }
  if (proxySummary.fallback || rawSummary.fallbackUsed || signalSummary.fallbackUsed) {
    alerts.push(createAlert({
      feedId: entry.id,
      regressionClass: 'fallback-engaged',
      severity: 'warning',
      message: 'Fallback data path was used for this feed.',
      metadata: { identity: 'fallback' }
    }));
  }
  const staticAlert = compareStaticSnapshot(entry, signalSummary.count ? signalSummary : proxySummary, staticSummary);
  if (staticAlert) alerts.push(staticAlert);

  const normalizedAlerts = dedupeAlerts(alerts.map((alert) => applyKnownUpstreamQuirks(alert, entry.knownUpstreamQuirks)));
  const status = normalizedAlerts.length
    ? normalizedAlerts[0].severity
    : 'ok';

  return {
    feedId: entry.id,
    tier: entry.tier,
    category: entry.category,
    status,
    alerts: normalizedAlerts,
    proxy: proxySummary,
    raw: rawSummary,
    signals: signalSummary,
    static: staticSummary
  };
}

export async function runFeedAudit(entries, options) {
  const results = [];
  const queue = [...entries];
  const concurrency = Number(options?.concurrency || 4);

  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) return;
      results.push(await auditEntry(entry, options));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, () => worker()));
  return results.sort((a, b) => a.feedId.localeCompare(b.feedId));
}
