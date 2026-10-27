import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BLS_CPI_URL, getBlsApiError, inspectBlsPayload, sanitizeBlsBody, isDefaultBlsRequest } from '../../gcp/feed-proxy/bls.js';
import { fetchBlsMcp } from '../../gcp/feed-proxy/bls-mcp.js';
import { fetchRaw, resetBlsRawCacheForTest, buildRawStructuredContent } from '../../gcp/mcp-proxy/server.js';
import { normalizeJsonSignals } from '../../gcp/mcp-proxy/signal-normalization.js';
import { summarizeProxyPayload } from '../../analysis/monitor/lib/audit.mjs';
import { summarizeCpiPublication } from '../../analysis/monitor/lib/cpi_cadence.mjs';

const retained = JSON.parse(fs.readFileSync(new URL('./fixtures/monitor/eia-bls-retained.json', import.meta.url)))['bls-cpi'];
const feed = JSON.parse(fs.readFileSync(new URL('../../data/feeds.json', import.meta.url))).feeds.find(entry => entry.id === 'bls-cpi');
const quota = { status: 'REQUEST_NOT_PROCESSED', responseTime: 0,
  message: ['Request could not be serviced, as the daily threshold for total number of requests allocated to the user with registration key  has been reached.'], Results: {} };
const headers = { 'content-type': 'application/json' };
const snapshot = body => ({ id: feed.id, body: JSON.stringify(body), contentType: 'application/json', httpStatus: 200 });
const variants = [quota, null, {}, { ...retained, Results: {} },
  { ...retained, Results: { series: [] } }, { ...retained, Results: { series: [{ seriesID: 'CUUR0000SA0', data: [] }] } },
  { ...retained, error: 'provider_error' }, { ...retained, Results: { series: [{ seriesID: 'WRONG', data: retained.Results.series[0].data }] } }];

test('BLS exact retained quota, empty/error series and wrong identity are not healthy HTTP200 data', () => {
  assert.equal(fs.readFileSync(new URL('../../gcp/feed-proxy/bls.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../gcp/mcp-proxy/bls.js', import.meta.url), 'utf8'));
  for (const body of variants) assert.ok(inspectBlsPayload(body, 'CUUR0000SA0').error, JSON.stringify(body));
  const summary = summarizeProxyPayload(feed, snapshot(quota));
  assert.equal(summary.httpStatus, 200);
  assert.equal(summary.apiSuccess, false);
  assert.equal(summary.schemaValid, false);
  assert.equal(summary.error, 'bls_api_error');
  assert.equal(summary.rawItemCount, 0);
  const schedule = JSON.parse(fs.readFileSync(new URL('../../data/feed-monitoring.json', import.meta.url)))['bls-cpi'].publicationSchedule;
  const result = summarizeCpiPublication({ ...feed, publicationSchedule: schedule }, { items: [] }, {}, summary, summary);
  assert.equal(result.collectionAvailability.proxy, 'unavailable');
  assert.equal(result.collectionAvailability.signals, 'unavailable');
  for (const body of [
    { ...retained, Results: { series: [null] } },
    { ...retained, Results: { error: 'bad', series: retained.Results.series } },
    { ...retained, Results: { series: [{ ...retained.Results.series[0], error: 'bad' }] } },
    { ...retained, Results: { series: [{ ...retained.Results.series[0], data: [{ ...retained.Results.series[0].data[0], error: 'bad' }] }] } }
  ]) assert.ok(inspectBlsPayload(body).error);
  assert.doesNotThrow(() => summarizeProxyPayload(feed, snapshot({ ...retained, Results: { series: [null] } })));
});

test('BLS missing values and M13 remain legitimate observations without zero/current fabrication', () => {
  const body = structuredClone(retained);
  body.Results.series[0].data = [
    { year: '2026', period: 'M09', value: '-' }, { year: '2025', period: 'M13', value: '300.2' },
    { year: '2026', period: 'M08', value: null }, { year: '2026', period: 'M07', value: '0' }
  ];
  assert.equal(inspectBlsPayload(body, 'CUUR0000SA0').error, null);
  const rows = normalizeJsonSignals(JSON.stringify(body), feed);
  assert.equal(rows[0].value, null);
  assert.equal(rows[1].publishedAt, null);
  assert.equal(rows[2].value, null);
  assert.equal(rows[3].value, 0);
  assert.equal(summarizeProxyPayload(feed, snapshot(body)).error, null);
  const arrayResults = { ...body, Results: [body.Results] };
  assert.equal(inspectBlsPayload(arrayResults).error, null);
});

test('BLS provider registration-key prose never escapes semantic error or success sanitization', () => {
  for (const body of [quota, retained]) {
    const privateBody = { ...body, registrationKey: 'INERT-PRIVATE-REGISTRATION-KEY',
      message: ['registration key INERT-PRIVATE-REGISTRATION-KEY has been reached.'] };
    assert.doesNotMatch(sanitizeBlsBody(privateBody), /INERT-PRIVATE/);
    assert.doesNotMatch(JSON.stringify(summarizeProxyPayload(feed, snapshot(privateBody))), /INERT-PRIVATE/);
  }
});

function rpc(id, source = {}, result = {}) {
  return { jsonrpc: '2.0', id, result: { structuredContent: {
    sourceId: feed.id, url: BLS_CPI_URL, fetchedUrl: BLS_CPI_URL,
    contentType: 'application/json', proxyUsed: null, fallbackUsed: false, data: retained, ...source
  }, ...result } };
}

test('BLS default bridge uses only the existing same-v1 raw operation; explicit options stay direct', async (t) => {
  assert.equal(isDefaultBlsRequest(feed), true);
  for (const options of [{ key: 'inert' }, { keyParam: 'x' }, { keyHeader: 'x' }, { query: 'x' },
    { params: { year: 2020 } }, { proxy: 'x' }, { history: true }, { start: '2020' }]) assert.equal(isDefaultBlsRequest(feed, options), false);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp');
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.params, { name: 'raw.fetch', arguments: { sourceId: feed.id, format: 'json' } });
    return new Response(JSON.stringify(rpc(request.id)), { headers });
  });
  const result = await fetchBlsMcp(1000);
  assert.equal(calls, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.stale, false);
  assert.equal(result.upstreamUrl, BLS_CPI_URL);
});

test('BLS bridge rejects wrong source/schema, provider errors and false nonfallback lineage', async (t) => {
  let source;
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Response(JSON.stringify(rpc(JSON.parse(options.body).id, source)), { headers }));
  for (source of [{ sourceId: 'wrong' }, { url: BLS_CPI_URL.replace('/v1/', '/v2/') }, { data: quota },
    { fetchedUrl: 'https://fixture.invalid/' }, { fallbackUsed: false, stale: true }, { fallbackUsed: false, proxyUsed: 'live-cache' }]) {
    assert.ok((await fetchBlsMcp(1000)).error);
  }
  source = { fallbackUsed: true, proxyUsed: 'live-cache', fetchedUrl: 'https://congressionalinsights.github.io/TheSituationRoomAI/data/feeds/bls-cpi.json' };
  const fallback = await fetchBlsMcp(1000);
  assert.equal(fallback.error, undefined);
  assert.equal(fallback.fallbackUsed, true);
  assert.equal(fallback.stale, true);
  assert.equal(summarizeProxyPayload(feed, fallback).fallbackUsed, true);
});

test('BLS MCP coalesces default acquisition and briefly reuses only valid primary data', async (t) => {
  resetBlsRawCacheForTest();
  t.after(resetBlsRawCacheForTest);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, BLS_CPI_URL);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(retained), { headers });
  });
  const results = await Promise.all([fetchRaw(feed, {}), fetchRaw(feed, {})]);
  const cached = await fetchRaw(feed, {});
  assert.equal(calls, 1);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.acquiredAt, results[0].acquiredAt);
  cached.body = 'changed';
  assert.notEqual((await fetchRaw(feed, {})).body, 'changed');
  await fetchRaw(feed, { params: { startyear: '2025' } });
  assert.equal(calls, 2, 'explicit caller request must not use default cache');
});

test('BLS MCP quota/empty failure can use only a validated degraded snapshot, never cache a quota success', async (t) => {
  resetBlsRawCacheForTest();
  t.after(resetBlsRawCacheForTest);
  let source = quota;
  let saved = retained;
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    const body = String(url).includes('/data/feeds/') ? snapshot(saved) : source;
    return new Response(JSON.stringify(body), { headers });
  });
  for (source of variants.slice(0, 7)) {
    const result = await fetchRaw(feed, {});
    assert.equal(result.error, undefined);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.proxyUsed, 'live-cache');
    const raw = buildRawStructuredContent({ sourceId: feed.id, feed, result, responseFormat: 'json' });
    assert.match(raw.warning, /cache snapshot/);
    assert.equal(raw.fallbackUsed, true);
  }
  assert.equal(urls.length, 14, 'one API attempt and one snapshot per failed acquisition; no proxy replay');
  saved = quota;
  const failed = await fetchRaw(feed, {});
  assert.ok(failed.error);
  assert.equal(failed.httpStatus, 200);
  assert.doesNotMatch(JSON.stringify(failed), /registration key/);
  urls.length = 0;
  await fetchRaw(feed, { key: 'inert-registration-key' });
  assert.equal(urls.length, 1, 'explicit key request cannot fall back to default snapshot');
});

function feedFunction(file, additions = {}) {
  const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const start = source.indexOf('async function fetchFeed(');
  const code = source.slice(start, source.indexOf('\n}', start) + 2);
  const context = { Date, URL, cache: new Map(), appConfig: { defaultRefreshMinutes: 1 }, FETCH_TIMEOUT_MS: 1000,
    inspectBlsPayload, sanitizeBlsBody, isDefaultBlsRequest, fetchBlsMcp, isDefaultOpenAqRequest: () => false,
    mergeFeedParams: () => ({}), sanitizeParamsObject: value => value || {}, serializeParams: value => JSON.stringify(value),
    isStateConnectorFeed: () => false, isUsableStaleFeedPayload: (_feed, payload) => payload && !inspectBlsPayload(payload.body).error,
    markSnapshotFallback: (_feed, payload) => ({ ...payload, stale: true, fallback: 'live-cache' }),
    loadLocalFeed: () => null, resolveServerKey: () => null, isEiaFeed: () => false,
    getUrlTemplateParamNames: () => [], getRuntimeOnlyParamNames: () => [], buildUrl: value => value,
    applyUrlParams: value => value, applyCongressCommitteeDateWindow: value => value, applyKey: url => ({ url, headers: {} }),
    canUseLiveFeedFallback: () => false, isStateLegislationScopedRequest: () => false, isStateLegislationAllStatesRequest: () => false,
    isJsonHtmlError: () => false, ...additions };
  vm.runInNewContext(code + '\nthis.run = fetchFeed;', context);
  return context;
}

test('BLS Feed and local handlers reject direct quota/empty responses without caching; default is the validated bridge', async () => {
  for (const file of ['gcp/feed-proxy/server.js', 'server.mjs']) {
    const context = feedFunction(file, { fetchBlsMcp: async () => ({ ...snapshot(retained), fallbackUsed: false }),
      fetchWithTimeout: async () => new Response(JSON.stringify(quota), { headers }),
      fetchLiveFallback: async () => null });
    assert.equal((await context.run(feed, { force: true })).fallbackUsed, false);
    context.cache.clear();
    const bad = await context.run(feed, { force: true, params: { startyear: '2020' } });
    assert.equal(bad.error, 'bls_api_error');
    assert.equal(bad.httpStatus, 200);
    assert.equal(context.cache.size, 0);
    assert.doesNotMatch(bad.body, /registration key/);
  }
});

test('BLS static builder executes semantic fallback checks and preserves degraded sanitized lineage', async () => {
  const source = fs.readFileSync(new URL('../../scripts/build_static_cache.mjs', import.meta.url), 'utf8');
  const code = ['function isUsableJsonSnapshot(', 'async function loadBestFallbackPayload('].map(declaration => {
    const start = source.indexOf(declaration);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  let live = snapshot(quota);
  const context = { Date, getBlsApiError, sanitizeBlsBody, isJsonHtmlError: () => false,
    fetchLiveFallback: async () => live, fetchFeedProxyFallback: async () => snapshot(retained),
    buildFeedProxyFallbackParams: () => ({}), seededFeedFallbacks: new Map() };
  vm.runInNewContext(code + '\nthis.usable = isUsableJsonSnapshot; this.fallback = loadBestFallbackPayload;', context);
  for (const body of variants) assert.equal(context.usable(snapshot(body), feed), false);
  const recovered = await context.fallback(feed);
  assert.equal(recovered.fallback, 'feed-proxy');
  assert.equal(recovered.stale, true);
  assert.equal(recovered.fallbackUsed, true);
  live = snapshot({ ...retained, message: ['registration key INERT-SECRET'] });
  const saved = await context.fallback(feed);
  assert.equal(saved.fallback, 'live-cache');
  assert.doesNotMatch(saved.body, /INERT-SECRET/);
});

test('BLS Feed and local defaults reacquire after degraded snapshots instead of retaining the daily cache TTL', async () => {
  for (const file of ['gcp/feed-proxy/server.js', 'server.mjs']) {
    let calls = 0;
    const context = feedFunction(file, { fetchBlsMcp: async () => ({ ...snapshot(retained), fetchedAt: Date.now(),
      fallbackUsed: ++calls === 1, stale: calls === 1, fallback: calls === 1 ? 'live-cache' : null }) });
    assert.equal((await context.run(feed, {})).fallbackUsed, true);
    assert.equal(context.cache.size, 0);
    assert.equal((await context.run(feed, {})).fallbackUsed, false);
    assert.equal(calls, 2);
    assert.equal(context.cache.size, 1);
    await context.run(feed, {});
    assert.equal(calls, 2, 'only usable primary data may use normal TTL');
  }
});
