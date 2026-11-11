import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('static GDELT GEO resolves its documented seven-day window without changing other feed defaults', async () => {
  const source = fs.readFileSync(new URL('../build_static_cache.mjs', import.meta.url), 'utf8');
  const declarations = [
    'function buildUrl(', 'function getUrlTemplateParamNames(', 'function getRuntimeOnlyParamNames(',
    'function applyUrlParams(', 'function applyCongressCommitteeDateWindow(', 'function applyKey(',
    'function normalizeContentType(', 'function looksLikeHtmlDocument(', 'function isJsonHtmlError(',
    'function buildStaticRequestParams(', 'async function buildFeedPayload('
  ];
  const code = declarations.map(declaration => {
    const start = source.indexOf(declaration);
    assert.ok(start >= 0, declaration);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  const calls = [];
  let status = 200;
  const context = {
    URL, Date, SEEDED_JSON_FALLBACK_IDS: new Set(), appConfig: { userAgent: 'fixture' }, TIMEOUT_MS: 1,
    isEiaFeed: () => false,
    fetchWithFallbacks: async url => {
      calls.push(new URL(url));
      return new Response(status === 200 ? '{"type":"FeatureCollection","features":[]}' : 'unavailable', {
        status, headers: { 'content-type': 'application/json' }
      });
    }
  };
  vm.runInNewContext(code + '\nthis.params = buildStaticRequestParams; this.build = buildFeedPayload;', context);
  const feeds = JSON.parse(fs.readFileSync(new URL('../../data/feeds.json', import.meta.url), 'utf8')).feeds;
  const geo = feeds.find(feed => feed.id === 'gdelt-conflict-geo');
  assert.ok(geo);
  const original = JSON.stringify(feeds);
  for (const feed of feeds) {
    if (feed.id === geo.id) continue;
    const defaults = feed.supportsParams ? { ...(feed.defaultParams || {}) } : {};
    const expected = feed.id === 'state-legislation'
      ? { jurisdiction: 'ocd-jurisdiction/country:us/state:ny/government', ...defaults }
      : defaults;
    assert.deepEqual({ ...context.params(feed) }, expected, feed.id);
  }
  for (const feed of [geo, { ...geo, supportsParams: true, defaultParams: { timespan: '24h' } }]) {
    const payload = await context.build(feed);
    const url = calls.at(-1);
    assert.equal(url.origin + url.pathname, 'https://api.gdeltproject.org/api/v2/geo/geo');
    assert.equal(url.searchParams.get('timespan'), feed.defaultParams?.timespan || '7d');
    assert.equal(url.searchParams.getAll('timespan').length, 1);
    assert.equal(url.searchParams.get('query'), geo.defaultQuery);
    assert.equal(url.searchParams.get('mode'), 'pointdata');
    assert.equal(url.searchParams.get('format'), 'geojson');
    assert.equal(url.searchParams.get('maxpoints'), '300');
    assert.doesNotMatch(decodeURIComponent(url.href), /\{\{/);
    assert.equal(payload.error, undefined);
    assert.equal(payload.fallback, undefined);
  }
  status = 404;
  const failure = await context.build(geo);
  assert.equal(failure.error, 'http_404');
  assert.equal(failure.httpStatus, 404);
  assert.equal(failure.body, 'unavailable');
  assert.equal(failure.fallback, undefined);
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(feeds), original);
});
