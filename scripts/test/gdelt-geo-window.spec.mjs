import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mergeFeedParams, sanitizeParamsObject } from '../../gcp/feed-proxy/state-signals.js';

const feedSource = fs.readFileSync(new URL('../../gcp/feed-proxy/server.js', import.meta.url), 'utf8');
const mcpSource = fs.readFileSync(new URL('../../gcp/mcp-proxy/server.js', import.meta.url), 'utf8');
const geo = JSON.parse(fs.readFileSync(new URL('../../data/feeds.json', import.meta.url), 'utf8'))
  .feeds.find(feed => feed.id === 'gdelt-conflict-geo');

function extract(source, declaration) {
  const start = source.indexOf(declaration);
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, declaration);
  return source.slice(start, end + 2).replace(/^export /, '');
}

function mcpContext(lookback = 30) {
  const context = {
    URL, Date, DEFAULT_LOOKBACK_DAYS: lookback, ACLED_PROXY: '', sanitizeParamsObject, mergeFeedParams,
    getHistoryParamMapper: () => null, hasHistoryTemplate: () => false,
    retiredSource: () => null, supportsHistoryRange: () => false, isStateConnectorFeed: () => false,
    resolveServerKey: () => { throw new Error('key-resolution-boundary'); }
  };
  const declarations = [
    'function computeTimespan(', 'function buildUrl(', 'function getUrlTemplateParamNames(',
    'function getRuntimeOnlyParamNames(', 'function getCongressDateWindow(',
    'function applyCongressCommitteeDateWindow(', 'function formatIsoDate(', 'function applyHistoryRange(',
    'function getGdeltGeoWindowError(', 'export function buildFeedUrl(', 'async function fetchRawUncached('
  ];
  vm.runInNewContext(declarations.map(declaration => extract(mcpSource, declaration)).join('\n')
    + '\nthis.url = buildFeedUrl; this.raw = fetchRawUncached;', context);
  return context;
}

test('shared GEO constructors use seven days independently of other-feed lookback defaults', () => {
  assert.ok(geo);
  assert.equal(geo.supportsParams, undefined);
  for (const lookback of [30, 90]) {
    const feedContext = { URL, DEFAULT_LOOKBACK_DAYS: lookback };
    vm.runInNewContext(extract(feedSource, 'function buildGdeltConflictUrl(') + '\nthis.url = buildGdeltConflictUrl;', feedContext);
    const mcp = mcpContext(lookback);
    for (const url of [feedContext.url(geo), mcp.url(geo, {})]) {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, 'https://api.gdeltproject.org/api/v2/geo/geo');
      assert.equal(parsed.searchParams.get('timespan'), '7d');
      assert.equal(parsed.searchParams.get('query'), geo.defaultQuery);
      assert.equal(parsed.searchParams.get('mode'), 'pointdata');
      assert.equal(parsed.searchParams.get('format'), 'geojson');
      assert.equal(parsed.searchParams.get('maxpoints'), '300');
    }
    const other = { ...geo, id: 'other-timespan-fixture' };
    assert.equal(new URL(mcp.url(other, {})).searchParams.get('timespan'), `${lookback}d`);
    const explicit = { query: 'fixture query' };
    const requested = new URL(mcp.url(geo, explicit));
    assert.equal(requested.searchParams.get('timespan'), '7d');
    assert.equal(requested.searchParams.get('query'), explicit.query);
    assert.equal(requested.searchParams.has('start'), false);
    assert.equal(requested.searchParams.has('end'), false);
  }
});

test('Feed GEO rejects unsupported explicit windows before cache, key or transport access', async () => {
  const context = { Date, sanitizeParamsObject,
    mergeFeedParams: () => { throw new Error('ordinary-feed-boundary'); } };
  vm.runInNewContext(extract(feedSource, 'async function fetchFeed(') + '\nthis.run = fetchFeed;', context);
  for (const params of [{ timespan: '30d' }, { timespan: '24h' }, { TimeSpan: '8d' },
    { start: '2026-10-01' }, { end: '2026-11-01' }, { STARTDATETIME: '20261101000000' },
    { enddatetime: '20261110000000' }]) {
    for (const force of [false, true]) {
      const result = await context.run(geo, { params, force });
      assert.equal(result.error, 'unsupported_geo_window');
      assert.equal(result.httpStatus, 400);
      assert.equal(result.fallbackUsed, false);
      assert.equal(result.body, undefined);
      assert.equal(result.items, undefined);
    }
  }
  await assert.rejects(context.run(geo), /ordinary-feed-boundary/);
  for (const keyParam of ['timespan', 'STARTDATETIME', 'enddatetime', 'start', 'end']) {
    const result = await context.run(geo, { key: '30d-fixture-not-a-credential', keyParam });
    assert.equal(result.error, 'unsupported_geo_window');
    assert.equal(result.httpStatus, 400);
  }
  await assert.rejects(context.run({ ...geo, id: 'other-fixture' }, { params: { timespan: '30d' } }), /ordinary-feed-boundary/);
});

test('MCP GEO rejects all unrepresentable explicit windows without clamping or claiming history', async () => {
  const context = mcpContext();
  for (const options of [
    { start: '2026-10-01', end: '2026-10-31' },
    { start: '2026-11-01T00:00:00Z', end: '2026-11-01T01:00:00Z' },
    { start: '2026-11-01T02:00:00Z', end: '2026-11-01T03:00:00Z' },
    { start: '2026-11-01', end: '2026-11-08' },
    { start: '2026-11-01', end: '2026-11-01' },
    { start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00.001Z' },
    { start: 'invalid', end: '2026-11-01' }, { start: '2026-11-01' }, { end: '2026-11-01' },
    { start: '2026-11-08', end: '2026-11-01' },
    { params: { timespan: '30d' } }, { params: { timespan: '24h' } },
    { params: { startdatetime: '20261101000000', enddatetime: '20261110000000' } },
    { key: '30d-fixture-not-a-credential', keyParam: 'timespan' }
  ]) {
    const result = await context.raw(geo, options);
    assert.equal(result.error, 'unsupported_geo_window');
    assert.equal(result.httpStatus, 400);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.upstreamStatus, null);
    assert.equal(result.items, undefined);
    assert.throws(() => context.url(geo, options), error => error.error === 'unsupported_geo_window');
  }
  for (const options of [{}, { params: { mode: 'pointdata' } }]) {
    await assert.rejects(context.raw(geo, options), /key-resolution-boundary/);
  }
  const history = await context.raw(geo, { history: true, start: '2026-10-01', end: '2026-10-31' });
  assert.equal(history.error, 'history_not_supported');
  await assert.rejects(context.raw({ ...geo, id: 'other-fixture' }, { start: '2026-10-01', end: '2026-10-31' }), /key-resolution-boundary/);
});

test('Feed GET and POST top-level windows are rejected before route options are dropped', async () => {
  const start = feedSource.indexOf("  if (url.pathname === '/api/feed') {");
  const end = feedSource.indexOf('\n  if (', start + 1);
  assert.ok(start >= 0 && end > start);
  let body = {};
  let calls = 0;
  const guardContext = { Date, sanitizeParamsObject,
    mergeFeedParams: () => { throw new Error('ordinary-feed-boundary'); } };
  vm.runInNewContext(extract(feedSource, 'async function fetchFeed(') + '\nthis.run = fetchFeed;', guardContext);
  const context = {
    Date, URL, origin: 'https://fixture.invalid',
    readBody: async () => JSON.stringify(body),
    sanitizeParamsObject, feedsConfig: { feeds: [geo, { ...geo, id: 'other-fixture' }] },
    fetchFeed: async (feed, options) => {
      calls += 1;
      try { return await guardContext.run(feed, options); } catch (error) {
        assert.match(error.message, /ordinary-feed-boundary/);
        return { id: feed.id, httpStatus: 200 };
      }
    },
    sanitizeEiaPayload: (_feed, payload) => payload, console: { log() {} },
    sendJson: (_res, status, payload) => ({ status, payload })
  };
  vm.runInNewContext('this.route = async (req, res, url) => {' + feedSource.slice(start, end) + '};', context);
  for (const name of ['timespan', 'start', 'end', 'STARTDATETIME', 'enddatetime']) {
    for (const method of ['GET', 'POST']) {
      body = method === 'POST' ? { id: geo.id, [name]: '30d-fixture' } : {};
      const url = new URL(`https://fixture.invalid/api/feed?id=${geo.id}`);
      if (method === 'GET') url.searchParams.set(name, '30d-fixture');
      const result = await context.route({ method }, {}, url);
      assert.equal(result.status, 400);
      assert.equal(result.payload.error, 'unsupported_geo_window');
      assert.equal(result.payload.fallbackUsed, false);
    }
  }
  assert.equal(calls, 0);
  body = {};
  const ordinary = await context.route({ method: 'GET' }, {}, new URL(`https://fixture.invalid/api/feed?id=${geo.id}`));
  assert.equal(ordinary.status, 200);
  assert.equal(calls, 1);
  for (const request of [
    { method: 'GET', suffix: '&param.timespan=30d', body: {} },
    { method: 'GET', suffix: '&key=30d-fixture&keyParam=timespan', body: {} },
    { method: 'POST', suffix: '', body: { id: geo.id, params: { timespan: '30d' } } },
    { method: 'POST', suffix: '', body: { id: geo.id, key: '30d-fixture', keyParam: 'timespan' } }
  ]) {
    body = request.body;
    const result = await context.route({ method: request.method }, {}, new URL(`https://fixture.invalid/api/feed?id=${geo.id}${request.suffix}`));
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'unsupported_geo_window');
  }
  body = {};
  const other = await context.route({ method: 'GET' }, {}, new URL('https://fixture.invalid/api/feed?id=other-fixture&timespan=30d'));
  assert.equal(other.status, 200);
});

test('MCP GEO cannot consume an unbound published snapshot for its seven-day default', () => {
  const context = {};
  vm.runInNewContext(extract(mcpSource, 'export function shouldUseLiveFallback(') + '\nthis.check = shouldUseLiveFallback;', context);
  assert.equal(context.check(geo, {}), false);
  assert.equal(context.check(geo, { query: geo.defaultQuery }), false);
  assert.equal(context.check(geo, { start: '2026-11-01', end: '2026-11-02' }), false);
  assert.equal(context.check({}), true, 'legacy options-only behavior preserved');
  assert.equal(context.check({ id: 'openaq-api' }, {}), false);
});

test('MCP public raw and list errors distinguish local window rejection from provider responses', async () => {
  const mcp = mcpContext();
  for (const name of ['raw.fetch', 'signals.list']) {
    const toolStart = mcpSource.indexOf(`  '${name}',`);
    const start = mcpSource.indexOf('  async ({ sourceId', toolStart);
    const end = mcpSource.indexOf('\n);', start);
    assert.ok(toolStart >= 0 && start > toolStart && end > start, name);
    const context = {
      feeds: [geo], retiredToolResult: () => null, fetchRaw: mcp.raw,
      sanitizeEiaPayload: (_feed, result) => result, coverageFields: () => ({})
    };
    vm.runInNewContext('this.tool = ' + mcpSource.slice(start, end).trim() + ';', context);
    const result = await context.tool({ sourceId: geo.id, start: '2026-11-01', end: '2026-11-02' });
    assert.equal(result.structuredContent.error, 'unsupported_geo_window');
    assert.equal(result.structuredContent.httpStatus, 400);
    assert.equal(result.structuredContent.items, undefined);
    if (name === 'raw.fetch') assert.equal(result.structuredContent.upstreamStatus, null);
  }
});
