import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFeedManager } from '../../public/modules/feeds.js';

const appSource = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const contextSource = appSource.slice(appSource.indexOf('function getFeedRefreshContext('), appSource.indexOf('\nasync function fetchFeed('));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture(t, overrides = {}) {
  t.mock.method(Date, 'now', () => fixture.now);
  fixture.now = 1_800_000_000_000;
  const feed = { id: 'bbc-world', name: 'BBC', url: 'https://fixture.invalid/rss', format: 'rss', category: 'news', ttlMinutes: 10, supportsQuery: true, defaultQuery: 'policy' };
  const state = { feeds: [feed], settings: { refreshMinutes: 5, scope: 'global', radiusKm: 200 }, location: { lat: 37, lon: -122 }, feedStatus: {}, items: [], lastStaleRetry: fixture.now, retryingFeeds: false, staleRetrying: false };
  const context = { selected: 'ALL', country: { code: 'US', bbox: [-125, 24, -66, 49] }, key: '', keyParam: '', keyHeader: '', static: false, live: false, suffix: '', proxy: 'fixture-proxy' };
  const calls = [];
  const busy = [];
  const result = (source = feed, extra = {}) => ({ feed: source, fetchedAt: fixture.now, httpStatus: 200, error: null, errorMessage: null, items: [{ feedId: source.id, title: 'Fixture news', url: 'https://fixture.invalid/item', category: 'news', publishedAt: '2026-10-07T12:00:00Z' }], ...extra });
  const helpers = Object.fromEntries(['setHealth', 'updateProxyHealth', 'loadStaticAnalysis', 'loadStaticBuild', 'updateDataFreshBadge', 'renderAllPanels', 'renderSignals', 'renderFeedHealth', 'drawMap', 'generateAnalysis', 'maybeAutoRunAnalysis', 'refreshCustomTickers', 'renderTicker', 'renderFinanceSpotlight', 'renderLocal', 'updatePanelErrors'].map((key) => [key, () => {}]));
  Object.assign(helpers, {
    setRefreshing: (value) => busy.push(value),
    isStaticMode: () => context.static,
    shouldFetchLiveInStatic: () => context.live,
    translateQuery: (source, query) => query + context.suffix,
    fetchFeed: async (source, query, force) => { calls.push({ id: source.id, query, force, selected: context.selected }); return result(source); },
    fetchCustomFeedDirect: async (source) => result(source),
    isFeedStale: (source, status) => fixture.now - status.fetchedAt > (source.ttlMinutes + 5) * 60_000,
    canonicalUrl: (url) => url,
    isNonEnglish: () => false,
    enrichItem: (item) => item,
    applyScope: (items) => items,
    clusterNews: (items) => items,
    countCriticalIssues: (results) => results.filter((entry) => entry.error).length,
    geocodeItems: async () => false,
    ...overrides
  });
  // Execute the owning app's context helper, not a second test-only key implementation.
  helpers.getFeedRefreshContext = new Function('buildStateFeedRequestParams', 'getKeyConfig', 'isStaticMode', 'shouldFetchLiveInStatic', 'buildAcledUrl', 'buildGdeltConflictUrl', 'buildUcdpCandidateUrl', 'applyQueryToUrl', 'state', 'getSelectedCountry', `${contextSource}; return getFeedRefreshContext;`)(
    () => ({ state: context.selected }),
    () => ({ key: context.key, keyParam: context.keyParam, keyHeader: context.keyHeader }),
    helpers.isStaticMode, helpers.shouldFetchLiveInStatic,
    () => context.proxy, () => context.proxy, () => context.proxy,
    (url, query) => `${url}?q=${query}`, state, () => context.country
  );
  const manager = createFeedManager({ state, elements: {}, helpers: {
    ...helpers,
    fetchFeed: (...args) => helpers.fetchFeed(...args),
    fetchCustomFeedDirect: (...args) => helpers.fetchCustomFeedDirect(...args)
  } });
  return { manager, feed, state, context, calls, busy, result, helpers, advance: (ms) => { fixture.now += ms; } };
}

test('healthy exact-TTL reuse preserves items, source timestamps and status; expiry fetches', async (t) => {
  const f = fixture(t);
  await f.manager.refreshAll();
  const items = structuredClone(f.state.items);
  const status = structuredClone(f.state.feedStatus);
  f.advance(5 * 60_000);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.items, items);
  assert.deepEqual(f.state.feedStatus, status);
  f.advance(5 * 60_000);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 2, 'TTL boundary, not the stale-health buffer, ends reuse');
});

test('overlapping automatic all/targeted batches share one Promise and stay busy', async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.helpers.fetchFeed = async (source) => { f.calls.push(source.id); return gate.promise; };
  const all = f.manager.refreshAll();
  const targeted = f.manager.refreshFeeds([f.feed.id]);
  assert.equal(f.calls.length, 1);
  gate.resolve(f.result());
  await Promise.all([all, targeted]);
  assert.equal(f.busy.at(-1), false);
  assert.equal(f.busy.filter((value) => value === false).length, 1);
});

for (const order of ['force-first', 'automatic-first']) {
  test(`manual force bypasses pending work; ${order} completion cannot overwrite forced data`, async (t) => {
    const f = fixture(t);
    const old = deferred();
    const fresh = deferred();
    f.helpers.fetchFeed = async (source, query, force) => { f.calls.push({ force }); return force ? fresh.promise : old.promise; };
    const automatic = f.manager.refreshAll();
    const forced = f.manager.refreshFeeds([f.feed.id], { force: true });
    const follower = f.manager.refreshAll();
    assert.deepEqual(f.calls, [{ force: false }, { force: true }]);
    const freshResult = f.result(f.feed, { fetchedAt: fixture.now + 1, items: [{ ...f.result().items[0], title: 'Fresh forced data' }] });
    if (order === 'force-first') {
      fresh.resolve(freshResult);
      await Promise.all([forced, follower]);
      old.resolve(f.result());
    } else {
      old.resolve(f.result());
      await automatic;
      assert.equal(f.busy.at(-1), true);
      fresh.resolve(freshResult);
    }
    await Promise.all([automatic, forced, follower]);
    assert.equal(f.state.items[0].title, 'Fresh forced data');
    assert.equal(f.state.feedStatus[f.feed.id].fetchedAt, freshResult.fetchedAt);
  });
}

test('each concurrent force is fresh; latest-started force wins even out of order', async (t) => {
  const f = fixture(t);
  await f.manager.refreshAll();
  const gates = [deferred(), deferred()];
  let index = 0;
  f.helpers.fetchFeed = () => gates[index++].promise;
  const a = f.manager.refreshAll(true);
  const b = f.manager.refreshAll(true);
  assert.equal(index, 2);
  gates[1].resolve(f.result(f.feed, { items: [{ ...f.result().items[0], title: 'Second force' }] }));
  await b;
  gates[0].resolve(f.result());
  await a;
  assert.equal(f.state.items[0].title, 'Second force');
  await f.manager.refreshAll();
  assert.equal(index, 2);
});

for (const [name, change] of [
  ['translated query', (f) => { f.context.suffix = ' when:1d'; }],
  ['default query', (f) => { f.feed.defaultQuery = 'weather'; }],
  ['state', (f) => { f.context.selected = 'CA'; }],
  ['source URL', (f) => { f.feed.url = 'https://fixture.invalid/other'; }],
  ['format', (f) => { f.feed.format = 'json'; }],
  ['credential', (f) => { f.context.key = 'fixture-key'; }],
  ['credential header', (f) => { f.context.keyHeader = 'X-Fixture'; }],
  ['credential parameter', (f) => { f.context.keyParam = 'token'; }],
  ['transport mode', (f) => { f.context.static = true; }]
]) {
  test(`${name} change isolates both cached and in-flight results`, async (t) => {
    const f = fixture(t);
    await f.manager.refreshAll();
    change(f);
    await f.manager.refreshAll();
    assert.equal(f.calls.length, 2);
    const gate = deferred();
    const started = deferred();
    f.advance(10 * 60_000);
    f.helpers.fetchFeed = () => { started.resolve(); return gate.promise; };
    const pending = f.manager.refreshAll();
    await started.promise;
    const before = structuredClone(f.state.items);
    if (name === 'source URL') f.feed.url += '/new';
    else f.context.selected = 'NY';
    gate.resolve(f.result(f.feed, { items: [{ ...f.result().items[0], title: 'Wrong context' }] }));
    await pending;
    assert.deepEqual(f.state.items, before);
  });
}

test('changed translated query rejects a pending result without starting another request', async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.helpers.fetchFeed = () => gate.promise;
  const pending = f.manager.refreshAll();
  f.context.suffix = ' translated';
  gate.resolve(f.result());
  await pending;
  assert.equal(f.state.items.length, 0);
});

test('concurrent state contexts never share requests and latest context wins', async (t) => {
  const f = fixture(t);
  const gates = [deferred(), deferred()];
  f.helpers.fetchFeed = () => { const index = f.calls.length; f.calls.push(index); return gates[index].promise; };
  const all = f.manager.refreshAll();
  f.context.selected = 'CA';
  const targeted = f.manager.refreshFeeds([f.feed.id]);
  assert.equal(f.calls.length, 2);
  gates[1].resolve(f.result(f.feed, { items: [{ ...f.result().items[0], title: 'California' }] }));
  await targeted;
  gates[0].resolve(f.result());
  await all;
  assert.equal(f.state.items[0].title, 'California');
});

test('effective live source URL isolates direct results', async (t) => {
  const f = fixture(t);
  f.feed.acledMode = 'aggregated';
  f.context.live = true;
  let directCalls = 0;
  f.helpers.fetchCustomFeedDirect = async () => { directCalls += 1; return f.result(); };
  await f.manager.refreshAll();
  await f.manager.refreshAll();
  assert.equal(directCalls, 1);
  f.context.proxy = 'changed-fixture-proxy';
  await f.manager.refreshAll();
  assert.equal(directCalls, 2);
});

for (const extra of [
  { error: 'http_503', httpStatus: 503 }, { httpStatus: 0 }, { httpStatus: 304 },
  { stale: true }, { fallback: 'live-cache' }, { fallbackUsed: true }, { warning: 'partial' }, { reuseBlocked: true },
  { fetchedAt: undefined }, { fetchedAt: 0 }, { fetchedAt: '1800000000000' }, { fetchedAt: 1_900_000_000_000 }
]) {
  test(`unhealthy/unknown result is not reused: ${JSON.stringify(extra)}`, async (t) => {
    const f = fixture(t);
    f.helpers.fetchFeed = async (source) => { f.calls.push(source.id); return f.result(source, extra); };
    await f.manager.refreshFeeds([f.feed.id]);
    await f.manager.refreshFeeds([f.feed.id]);
    assert.equal(f.calls.length, 2);
  });
}

test('live failure fallback is shown but not cached as a healthy live result', async (t) => {
  const f = fixture(t);
  f.context.static = true;
  f.context.live = true;
  let directCalls = 0;
  f.helpers.fetchCustomFeedDirect = async () => { directCalls += 1; return f.result(f.feed, { error: 'fetch_failed' }); };
  await f.manager.refreshAll();
  await f.manager.refreshAll();
  assert.equal(directCalls, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.state.items.length, 1);
});

test('retry of fetch_failed remains forced and seeds the next healthy automatic cycle', async (t) => {
  const f = fixture(t);
  f.helpers.fetchFeed = async (source, query, force) => {
    f.calls.push({ force });
    return f.result(source, force ? {} : { error: 'fetch_failed', items: [] });
  };
  await f.manager.refreshAll();
  assert.deepEqual(f.calls, [{ force: false }, { force: true }]);
  assert.equal(f.state.feedStatus[f.feed.id].error, null);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 2);
});

test('stale retry retains its forced transport and cooldown', async (t) => {
  const f = fixture(t);
  f.state.lastStaleRetry = 0;
  f.helpers.fetchFeed = async (source, query, force) => {
    f.calls.push({ force });
    return f.result(source, force ? {} : { fetchedAt: fixture.now - 20 * 60_000 });
  };
  await f.manager.refreshAll();
  assert.deepEqual(f.calls, [{ force: false }, { force: true }]);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 2);
});

test('targeted error retains prior items/count and failed work is retried next cycle', async (t) => {
  const f = fixture(t);
  await f.manager.refreshAll();
  const items = structuredClone(f.state.items);
  f.helpers.fetchFeed = async (source) => { f.calls.push(source.id); return f.result(source, { error: 'http_503', errorMessage: 'unavailable', httpStatus: 503, items: [] }); };
  await f.manager.refreshFeeds([f.feed.id], { force: true });
  assert.deepEqual(f.state.items, items);
  assert.equal(f.state.feedStatus[f.feed.id].count, 1);
  assert.equal(f.state.feedStatus[f.feed.id].errorMessage, 'unavailable');
  await f.manager.refreshFeeds([f.feed.id]);
  assert.equal(f.calls.length, 3);
});

test('rejected transport Promise does not stick in the coalescing map', async (t) => {
  const f = fixture(t);
  f.helpers.fetchFeed = async () => { f.calls.push('reject'); throw new Error('fixture'); };
  await f.manager.refreshFeeds([f.feed.id]);
  await f.manager.refreshFeeds([f.feed.id]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.state.feedStatus[f.feed.id].error, 'fetch_failed');
});

test('custom and GPSJam remain excluded from result reuse and coalescing', async (t) => {
  const f = fixture(t);
  f.state.feeds = [{ ...f.feed, id: 'custom-fixture', isCustom: true }, { ...f.feed, id: 'gpsjam' }];
  await Promise.all([f.manager.refreshAll(), f.manager.refreshAll()]);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 6);
});

test('default refresh TTL applies to feeds without a TTL', async (t) => {
  const f = fixture(t);
  delete f.feed.ttlMinutes;
  await f.manager.refreshAll();
  f.advance(299_999);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 1);
  f.advance(1);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 2);
});

test('static automatic cycle cannot supersede or coalesce a manual live override', async (t) => {
  const f = fixture(t);
  f.context.static = true;
  const started = deferred();
  const gate = deferred();
  f.helpers.fetchCustomFeedDirect = () => { started.resolve(); return gate.promise; };
  const force = f.manager.refreshAll(true);
  await started.promise;
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 0, 'automatic static read is held while manual live request is active');
  gate.resolve(f.result(f.feed, { items: [{ ...f.result().items[0], title: 'Manual live override' }] }));
  await force;
  assert.equal(f.state.items[0].title, 'Manual live override');
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 1, 'later static request has its own context');
});

test('refreshAll drops removed feeds while preserving only superseded active feed results', async (t) => {
  const f = fixture(t);
  f.state.items = [{ feedId: 'removed-feed', title: 'Removed' }];
  await f.manager.refreshAll();
  assert.equal(f.state.items.some((item) => item.feedId === 'removed-feed'), false);
});

for (const [name, change] of [
  ['scope', (f) => { f.state.settings.scope = 'local'; }],
  ['country', (f) => { f.context.country = { code: 'CA', bbox: [-141, 41, -52, 84] }; }],
  ['latitude', (f) => { f.state.location.lat = 42; }],
  ['longitude', (f) => { f.state.location.lon = -75; }],
  ['radius', (f) => { f.state.settings.radiusKm = 100; }]
]) {
  test(`OpenSky parsing ${name} change invalidates cached and pending results`, async (t) => {
    const f = fixture(t);
    f.feed.id = 'transport-opensky';
    await f.manager.refreshAll();
    change(f);
    await f.manager.refreshAll();
    assert.equal(f.calls.length, 2);
    f.advance(10 * 60_000);
    const gate = deferred();
    f.helpers.fetchFeed = () => gate.promise;
    const pending = f.manager.refreshAll();
    const before = structuredClone(f.state.items);
    f.state.settings.radiusKm += 1;
    gate.resolve(f.result(f.feed, { items: [{ ...f.result().items[0], title: 'Wrong geography' }] }));
    await pending;
    assert.deepEqual(f.state.items, before);
  });
}

test('app payload fallback metadata blocks reuse without changing existing health/result flags', async () => {
  const source = appSource.slice(appSource.indexOf('async function fetchFeed('), appSource.indexOf('\nfunction getH3Lib('));
  const feed = { id: 'bbc-world', format: 'rss' };
  const fetch = new Function('isStaticMode', 'buildStateFeedRequestParams', 'getKeyConfig', 'apiFetch', 'parseRss', 'parseJson', `${source}; return fetchFeed;`)(
    () => false, () => ({}), () => ({}),
    async () => ({ status: 200, json: async () => ({ httpStatus: 200, fetchedAt: 1_800_000_000_000, body: 'fixture', stale: true, fallback: 'live-cache' }) }),
    () => [], () => []
  );
  const result = await fetch(feed);
  assert.equal(result.reuseBlocked, true);
  assert.equal(result.stale, undefined, 'preserve prior result/health semantics rather than introducing a stale flag');
  assert.equal(result.error, null);
});

test('opt-in UI comparison loads historical baseline only inside setup, never during collection', () => {
  const source = fs.readFileSync(new URL('./feed-refresh-efficiency.ui.spec.mjs', import.meta.url), 'utf8');
  const calls = [];
  const noop = () => {};
  const fakeTest = Object.assign(noop, { skip: noop, beforeAll: noop, afterAll: noop });
  const moduleBody = source.split('\n').filter((line) => !line.startsWith('import ')).join('\n').replace('import.meta.url', JSON.stringify(new URL('./feed-refresh-efficiency.ui.spec.mjs', import.meta.url).href));
  new Function('test', 'expect', 'fs', 'path', 'http', 'execFileSync', 'fileURLToPath', 'process', moduleBody)(
    fakeTest, {}, {}, { }, {}, (...args) => { calls.push(args); throw new Error('Historical commit unavailable'); },
    () => '/fixture/', { env: {} }
  );
  assert.equal(calls.length, 0);
});

for (const manualMode of ['all', 'targeted']) for (const automaticMode of ['all', 'targeted']) for (const completion of ['automatic-first', 'manual-first']) {
test(`multi-feed force lifetime: ${manualMode}/${automaticMode}/${completion}`, async (t) => {
  const f = fixture(t);
  f.context.static = true;
  const slowFeed = { ...f.feed, id: 'guardian-world' };
  f.state.feeds.push(slowFeed);
  const slow = deferred();
  const started = deferred();
  const automaticResult = deferred();
  f.helpers.fetchCustomFeedDirect = async (feed) => {
    if (feed.id === slowFeed.id) { started.resolve(); return slow.promise; }
    return f.result(feed, { items: [{ ...f.result(feed).items[0], title: 'Fast manual live' }] });
  };
  f.helpers.fetchFeed = async (feed) => { f.calls.push(feed.id); await automaticResult.promise; return f.result(feed, { items: [{ ...f.result(feed).items[0], title: 'Automatic static' }] }); };
  const manual = manualMode === 'all' ? f.manager.refreshAll(true)
    : f.manager.refreshFeeds(f.state.feeds.map((feed) => feed.id), { force: true });
  await started.promise;
  // Allow the fast live Promise to finish, while the other feed still holds the batch.
  await Promise.resolve();
  await Promise.resolve();
  const automatic = automaticMode === 'all' ? f.manager.refreshAll()
    : f.manager.refreshFeeds([f.feed.id]);
  const finishManual = () => slow.resolve(f.result(slowFeed, { items: [{ ...f.result(slowFeed).items[0], title: 'Slow manual live' }] }));
  if (completion === 'automatic-first') {
    automaticResult.resolve();
    await automatic;
    finishManual();
  } else {
    finishManual();
    await manual;
    automaticResult.resolve();
  }
  await Promise.all([manual, automatic]);
  assert.equal(f.calls.length, 0, 'completed force protection survives request-map cleanup');
  assert.deepEqual(f.state.items.map((item) => item.title), ['Fast manual live', 'Slow manual live']);
  await f.manager.refreshAll();
  assert.equal(f.calls.length, 2, 'protection releases after results are applied');
});
}
