import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildMcpServer, fetchRaw } from '../../gcp/mcp-proxy/server.js';
import { buildGdacsPrimaryFailureDiagnostic } from '../../gcp/feed-proxy/firms-diagnostics.js';
import { verifyGdacsCandidate, verifyGdacsEnvelope } from '../verify_gdacs_candidate.mjs';
import { gdacsMachineMime, normalizeGdacsMachine, parseGdacsMachineBody, fetchGdacsMachinePayload, sourceUrl } from '../../gcp/mcp-proxy/gdacs-machine.js';
import { summarizeSignals, summarizeProxyPayload } from '../../analysis/monitor/lib/audit.mjs';

const localRequire = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
const requireMcp = createRequire(localRequire.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = requireMcp('@modelcontextprotocol/sdk/inMemory.js');
const now = Date.parse('2026-11-18T03:20:00Z');
const synthetic = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [20, 10] }, properties: {
    eventname: 'Fixture earthquake', description: '<html>private marker</html>', alertlevel: 'Green',
    eventtype: 'EQ', eventid: 123, episodeid: 456, source: 'Fixture agency',
    datemodified: '2026-11-18T02:42:22', fromdate: '2026-11-18T01:42:22', todate: '2026-11-18T01:42:22',
    url: { report: 'https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=123&episodeid=456&tracking=hidden' }
  } }]
};
const fixture = process.env.TSR_GDACS_SAVED_BODY ? JSON.parse(fs.readFileSync(process.env.TSR_GDACS_SAVED_BODY)) : synthetic;
const feeds = JSON.parse(fs.readFileSync(new URL('../../data/feeds.json', import.meta.url)));
const feed = feeds.feeds.find(item => item.id === 'gdacs-alerts');
const machineResponse = () => Response.json(fixture);
const cachedRss = { id: feed.id, body: '<rss xmlns:georss="http://www.georss.org/georss"><channel><title>GDACS</title><item><title>Old</title><link>https://www.gdacs.org/report.aspx?eventid=123</link><georss:point>10 20</georss:point><pubDate>Tue, 17 Nov 2026 01:00:00 GMT</pubDate></item></channel></rss>',
  contentType: 'application/xml', httpStatus: 200, fallback: 'live-cache', stale: true };

function extract(path, names, context) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = names.map((name) => {
    const start = source.indexOf(name);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  return vm.runInNewContext(code + '\n' + names.at(-1).match(/function (\w+)/)[1], context);
}

test('GDACS actual API schema stays update-only, bounded, attributed and safe to serialize', async () => {
  const payload = await fetchGdacsMachinePayload({ now: () => now, fetchImpl: async (url, options) => {
    assert.equal(url, sourceUrl);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return machineResponse();
  } });
  const parsed = parseGdacsMachineBody(payload.body);
  assert.equal(parsed.items.length, fixture.features.length);
  assert.equal(parsed.newestUpdateAt, Date.parse('2026-11-18T02:42:22Z'));
  assert.ok(parsed.items.every(row => row.publishedAt === null && row.source === 'GDACS' && row.updatedAt <= now));
  assert.doesNotMatch(payload.body, /tracking=|private marker|"<html/i);
  assert.equal(normalizeGdacsMachine(synthetic, now - 3_600_000), null);
  const hostile = JSON.parse(payload.body);
  hostile.items[0].id += ':unexpected';
  assert.equal(parseGdacsMachineBody(JSON.stringify(hostile)), null);
  const expanded = JSON.parse(payload.body);
  expanded.items[0].summaryHtml = '<html>untrusted cache field</html>';
  assert.equal(parseGdacsMachineBody(JSON.stringify(expanded)).items[0].summaryHtml, undefined);
  const html = await fetchGdacsMachinePayload({ now: () => now,
    fetchImpl: async () => new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(html, null);
  const old = await fetchGdacsMachinePayload({ now: () => now + 90 * 60_000, fetchImpl: machineResponse });
  assert.equal(old, null);
  const massive = await fetchGdacsMachinePayload({ now: () => now,
    fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(massive, null);
});

test('GDACS Feed and Pages fetching and browser mapping preserve distinct coverage and cache degradation', async () => {
  for (const surface of ['feed', 'pages']) {
    let mode = 'machine';
    let requests = 0;
    const context = {
      gdacsMachineMime, parseGdacsMachineBody,
      fetchGdacsMachinePayload: () => fetchGdacsMachinePayload({ now: () => now,
        fetchImpl: async () => { requests++; return mode === 'machine' ? machineResponse() : new Response(null, { status: 503 }); } }),
      cache: new Map(), seededFeedFallbacks: new Map(), SEEDED_JSON_FALLBACK_IDS: new Set(),
      appConfig: feeds.app, FETCH_TIMEOUT_MS: 20000, TIMEOUT_MS: 20000, URL, Date,
      fetchRssWithFallbacks: async () => ({
        response: { ok: true, status: 200 }, valid: mode === 'rss',
        body: mode === 'rss' ? cachedRss.body : '<html>blocked</html>', contentType: mode === 'rss' ? 'application/xml' : 'text/html'
      }),
      fetchLiveFallback: async () => cachedRss, isUsableRssSnapshot: () => true,
      buildGdacsPrimaryFailureDiagnostic, console: { warn() {} },
      isDefaultOpenAqRequest: () => false, isStateConnectorFeed: () => false, isEiaFeed: () => false,
      buildUrl: url => url, applyUrlParams: url => url, applyCongressCommitteeDateWindow: url => url,
      applyKey: url => ({ url, headers: {} }), mergeFeedParams: () => ({}), sanitizeParamsObject: () => ({}), serializeParams: () => '',
      getUrlTemplateParamNames: () => [], getRuntimeOnlyParamNames: () => [],
      buildStaticRequestParams: () => ({}), resolveServerKey: () => null,
      isStateLegislationScopedRequest: () => false, isStateLegislationAllStatesRequest: () => false,
      canUseLiveFeedFallback: () => true, isUsableStaleFeedPayload: () => false,
      markSnapshotFallback: (_feed, snapshot) => snapshot, sanitizeEiaPayload: (_feed, payload) => payload
    };
    const acquire = surface === 'feed'
      ? extract('../../gcp/feed-proxy/server.js', ['async function fetchFeed('], context)
      : extract('../build_static_cache.mjs', ['async function buildFeedPayload('], context);
    const payload = await acquire(feed, { force: true });
    assert.equal(payload.contentType, gdacsMachineMime);
    assert.equal(verifyGdacsEnvelope(payload, surface, now).status, 'machine_fallback_verified');
    const browser = extract('../../public/app.js', ['async function fetchFeed('], {
      gdacsMachineMime, parseGdacsMachineBody, URLSearchParams, Date, isStaticMode: () => surface === 'pages',
      buildStateFeedRequestParams: () => ({}), getKeyConfig: () => ({}),
      apiFetch: async () => Response.json(payload), parseRss: () => assert.fail('typed updates entered RSS parser')
    });
    const displayed = await browser(feed);
    assert.equal(displayed.items.length, fixture.features.length);
    assert.ok(displayed.items.every(row => row.publishedAt === null && row.externalUrl === row.url && row.feedId === feed.id));
    assert.equal(displayed.stale, true);
    const filter = extract('../../public/app.js', ['function itemTime(', 'function applyFreshnessFilter('], {
      Date: { now: () => now }, state: { settings: { maxAgeDays: 30 } }
    });
    assert.equal(filter(displayed.items).length, displayed.items.length);
    assert.equal(filter([{ ...displayed.items[0], updatedAt: NaN }]).length, 0);
    assert.equal(filter([{ ...displayed.items[0], updatedAt: now + 1000 }]).length, 0);
    mode = 'cache';
    const cached = await acquire(feed, { force: true });
    assert.equal(cached.body, cachedRss.body);
    assert.equal(cached.stale, true);
    assert.equal(verifyGdacsEnvelope(cached, surface, now).status, 'cache_or_unavailable');
    mode = 'rss';
    const primary = await acquire(feed, { force: true });
    assert.equal(primary.body, cachedRss.body);
    assert.equal(primary.fallback, undefined);
    assert.equal(requests, 2, 'successful primary does not call the alternate');
  }
});

test('GDACS MCP raw and typed list reach normalized update-only records via existing tools', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === sourceUrl) { requests++; return machineResponse(); }
    return new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } });
  });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  const client = new Client({ name: 'gdacs-fixture', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(transport);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = async (_endpoint, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { ok: !result.isError, data: result.structuredContent };
  };
  const smoke = await verifyGdacsCandidate('mcp', 'https://gha-100-1---situation-room-mcp-xtas2c6vka-uc.a.run.app',
    { callTool: tool, now: () => now });
  assert.equal(smoke.status, 'machine_fallback_verified');
  assert.equal(smoke.signalsCount, Math.min(25, fixture.features.length));
  const raw = await tool(null, 'raw.fetch', { sourceId: feed.id, format: 'text' });
  const list = await tool(null, 'signals.list', { sourceId: feed.id, limit: 25 });
  const first = list.data.items[0];
  const single = await tool(null, 'signals.get', { sourceId: feed.id, id: first.id });
  assert.equal(single.data.item.updatedAt, first.updatedAt);
  assert.equal(single.data.item.publishedAt, null);
  assert.equal(summarizeSignals(list, feed).newestTimestamp, Date.parse('2026-11-18T02:42:22Z'));
  assert.equal(summarizeProxyPayload(feed, raw.data).rawItemCount, fixture.features.length);
  assert.equal(requests, 5, 'each independent owning call has only one machine attempt');
});

test('GDACS MCP still gets a machine attempt when the primary body stalls', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    calls.push(String(url));
    if (String(url) === sourceUrl) return machineResponse();
    assert.equal(url, feed.url);
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Fixture stalled', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'application/xml' } });
  });
  const result = fetchRaw(feed, {});
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  const payload = await result;
  assert.deepEqual(calls, [feed.url, sourceUrl]);
  assert.equal(payload.contentType, gdacsMachineMime);
  assert.equal(Date.now() - now, 10_000);
});

test('GDACS Pages passes response consumption into the existing RSS timeout', async () => {
  const attempts = [];
  const read = extract('../build_static_cache.mjs', ['async function fetchRssWithFallbacks('], {
    Math, buildFetchCandidates: url => [url], TIMEOUT_MS: 20000, isLikelyRssPayload: () => true,
    fetchWithTimeout: async (url, _headers, budget, consume) => {
      attempts.push({ url, budget, boundedBody: typeof consume === 'function' });
      return consume(Response.json({ fixture: true }));
    }
  });
  assert.equal((await read(feed.url, {}, [], 20000, { throughBody: true })).body, '{"fixture":true}');
  assert.deepEqual(attempts, [{ url: feed.url, budget: 15000, boundedBody: true }]);
});

test('GDACS release checks report primary unexercised separately and never certify stale snapshots', async () => {
  const current = { ...cachedRss, fallback: undefined, stale: false,
    body: cachedRss.body.replace('Tue, 17 Nov 2026 01:00:00 GMT', 'Wed, 18 Nov 2026 02:42:22 GMT') };
  const target = 'https://gha-100-1---situation-room-feed-xtas2c6vka-uc.a.run.app';
  let requests = 0;
  const proof = await verifyGdacsCandidate('feed', target, { now: () => now, fetchImpl: async (url, init) => {
    requests++;
    assert.equal(url, target + '/api/feed');
    assert.deepEqual(JSON.parse(init.body), { id: feed.id, force: true });
    assert.equal(init.redirect, 'error');
    return Response.json(current);
  } });
  assert.equal(proof.status, 'primary_unexercised');
  assert.equal(requests, 1);
  assert.equal(verifyGdacsEnvelope({ ...current, body: current.body.replace('</rss>', '') }, 'pages', now).status, 'cache_or_unavailable');
  assert.equal(verifyGdacsEnvelope(cachedRss, 'pages', now).status, 'cache_or_unavailable');
  assert.throws(() => verifyGdacsEnvelope({ ...cachedRss, stale: false }, 'pages', now));
  await assert.rejects(verifyGdacsCandidate('feed', 'https://www.gdacs.org', { fetchImpl: () => assert.fail('host guard') }));
});
