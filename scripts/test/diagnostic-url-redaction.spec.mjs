import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { buildMcpServer, buildRawStructuredContent, fetchRaw, httpServer } from '../../gcp/mcp-proxy/server.js';
import { redactDiagnosticText, redactDiagnosticUrl, sanitizeDiagnosticPayload, sanitizeEiaPayload } from '../../gcp/mcp-proxy/public-payload-safety.js';
import { summarizeProxyPayload, summarizeSignals } from '../../analysis/monitor/lib/audit.mjs';

globalThis.fetch = async () => { throw new Error('Unmocked diagnostic fixture transport'); };
const syntheticCredential = 'synthetic-diagnostic-only';
const wrap = (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}&view=raw`;
const assertSafe = (value) => assert.equal(JSON.stringify(value).includes(syntheticCredential), false,
  'exported diagnostic contains a synthetic credential');

test('diagnostic URL redaction: one-level non-EIA failure preserves 408 without exporting credentials', async (t) => {
  const credential = 'synthetic-diagnostic-only';
  const upstream = `https://fixture.invalid/reports?api_key=${credential}&limit=7`;
  const wrapper = `https://api.allorigins.win/raw?url=${encodeURIComponent(upstream)}&view=raw`;
  const feed = { id: 'congress-reports', url: wrapper, format: 'json' };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://api.allorigins.win');
    assert.equal(new URL(request.searchParams.get('url')).searchParams.get('api_key'), credential,
      'transport must retain the synthetic credential');
    return new Response('Request timeout', { status: 408 });
  });
  const result = await fetchRaw(feed, { start: '2026-10-01', end: '2026-10-28' });
  assert.equal(result.error, 'fetch_failed');
  assert.equal(result.httpStatus, 408);
  assert.equal(result.upstreamStatus, 408);
  assert.equal(result.fallbackUsed, false);
  assert.equal(JSON.stringify(result).includes(credential), false, 'exported diagnostic contains a synthetic credential');
  const safeUrl = new URL(result.fetchedUrl);
  const safeUpstream = new URL(safeUrl.searchParams.get('url'));
  assert.equal(safeUpstream.searchParams.get('api_key'), 'REDACTED');
  assert.equal(safeUpstream.searchParams.get('limit'), '7');
  assert.equal(safeUrl.searchParams.get('view'), 'raw');
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('diagnostic URL redaction: direct, case and encoded names retain nonsecret query semantics', () => {
  for (const name of ['api_key', 'apikey', 'key', 'token', 'api-key', 'x-api-key', 'client_secret', 'access_token', 'password']) {
    const encoded = [...name].map((char) => `%${char.charCodeAt(0).toString(16)}`).join('');
    for (const key of [name, name.toUpperCase(), encoded, encodeURIComponent(encoded)]) {
      const input = `https://fixture.invalid/reports?${key}=${syntheticCredential}&limit=7&topic=a%26b&tag=one&tag=two#section-1`;
      const safe = redactDiagnosticUrl(input);
      assertSafe(safe);
      const url = new URL(safe);
      assert.equal(url.searchParams.get('limit'), '7');
      assert.equal(url.searchParams.get('topic'), 'a&b');
      assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
      assert.equal(url.hash, '#section-1');
      assert.equal(redactDiagnosticUrl(safe), safe, 'redaction must be idempotent');
    }
  }
  const duplicate = new URL(redactDiagnosticUrl(`https://fixture.invalid/?key=${syntheticCredential}&key=${syntheticCredential}&limit=7`));
  assert.deepEqual(duplicate.searchParams.getAll('key'), ['REDACTED', 'REDACTED']);
});

test('diagnostic URL redaction: encoded and nested wrappers, userinfo and FIRMS paths', () => {
  const original = `https://fixture.invalid/reports?API%5FKEY=${syntheticCredential}&limit=7`;
  for (let count = 0; count <= 3; count += 1) {
    let input = original;
    for (let index = 0; index < count; index += 1) input = wrap(input);
    for (const value of [input, encodeURIComponent(input), wrap(encodeURIComponent(input))]) {
      const safe = redactDiagnosticUrl(value);
      assertSafe(safe);
      assertSafe(redactDiagnosticText(`HTTP 408: ${value}`));
      assert.equal(redactDiagnosticUrl(safe), safe);
    }
  }
  for (const format of ['json', 'csv']) {
    const safe = redactDiagnosticUrl(wrap(`https://fixture.invalid/api/area/${format}/${syntheticCredential}/VIIRS/world/1?limit=7`));
    assertSafe(safe);
    assert.match(new URL(safe).searchParams.get('url'), new RegExp(`/${format}/REDACTED/`));
  }
  assertSafe(redactDiagnosticUrl(wrap(`https://user:${syntheticCredential}@fixture.invalid/path?limit=7`)));
});

test('diagnostic URL redaction: malformed credential URLs and bounded recursion fail closed', () => {
  for (const input of [
    `invalid-url?api_key=${syntheticCredential}%26tail&limit=7`,
    `https://[invalid]/path?%61pi_key=${syntheticCredential}&limit=7`,
    wrap(`https%3A%2F%2Ffixture.invalid%2F%3Fapi_key%3D${syntheticCredential}%ZZ`),
    `invalid-url?token=${syntheticCredential} with spaces&limit=7`,
    wrap(encodeURIComponent(`invalid-url?key=${syntheticCredential}&limit=7`))
  ]) assertSafe(redactDiagnosticUrl(input));
  let deep = `https://fixture.invalid/?api_key=${syntheticCredential}`;
  for (let count = 0; count < 16; count += 1) deep = wrap(deep);
  assertSafe(redactDiagnosticUrl(deep));
  const wide = new URL('https://fixture.invalid/wrapper');
  for (let count = 0; count < 300; count += 1) wide.searchParams.append(`url${count}`, `https://fixture.invalid/?key=${syntheticCredential}`);
  assertSafe(redactDiagnosticUrl(wide.toString()));
  assertSafe(redactDiagnosticUrl(`https://fixture.invalid/?padding=${'a'.repeat(65536)}&key=${syntheticCredential}`));
  for (const value of [undefined, null, '', 'ordinary data', 'not a URL', 'https://fixture.invalid/report?topic=a%20b&tag=one&tag=two#part']) {
    assert.equal(redactDiagnosticUrl(value), value);
  }
  assert.equal(redactDiagnosticText('ordinary token data; key unavailable; date 2026-10-28'),
    'ordinary token data; key unavailable; date 2026-10-28');
});

test('diagnostic URL redaction: payload boundary preserves source/status/date/gap/unknown and successful bodies', () => {
  const url = wrap(`https://fixture.invalid/?api_key=${syntheticCredential}&limit=7`);
  const fields = { sourceId: 'congress-reports', error: 'fetch_failed', httpStatus: 408, upstreamStatus: 408,
    acquiredAt: null, publishedAt: null, fetchedAt: 1793188800000, coverageStatus: 'UNKNOWN',
    verifiedZeroResults: false, gap: 'upstream-timeout', signals: [], fallbackUsed: false, proxyUsed: null };
  const input = { ...fields, fetchedUrl: url, message: `HTTP 408 at ${url}`, body: JSON.stringify({ message: `Timed out at ${url}` }) };
  const safe = sanitizeDiagnosticPayload(input);
  assertSafe(safe);
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(safe[key], value, key);
  assert.equal(input.fetchedUrl, url, 'sanitization must not modify transport/input state');
  assert.equal(sanitizeDiagnosticPayload(null), null);
  const ordinaryBody = JSON.stringify({ token: 'ordinary-domain-data', items: [{ title: 'Retained', value: 0 }] });
  assert.equal(sanitizeDiagnosticPayload({ body: ordinaryBody, httpStatus: 200 }).body, ordinaryBody);
  const structured = buildRawStructuredContent({ sourceId: 'congress-reports', feed: { id: 'congress-reports', url },
    result: { fetchedUrl: url, body: ordinaryBody, contentType: 'application/json', fallbackUsed: false }, responseFormat: 'json' });
  assertSafe(structured);
  assert.deepEqual(structured.data, JSON.parse(ordinaryBody));
});

test('diagnostic URL redaction: direct success transports escaped credentials and leaves source data intact', async (t) => {
  const credential = `${syntheticCredential}&extra=private? #/%`;
  const feed = { id: 'diagnostic-fixture', url: 'https://fixture.invalid/reports?limit=7', keyParam: 'api_key', format: 'json' };
  const body = JSON.stringify({ items: [{ title: 'Retained', value: 0, publishedAt: null }], token: 'ordinary-data' });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://fixture.invalid');
    assert.equal(request.searchParams.get('api_key'), credential);
    assert.equal(request.searchParams.get('limit'), '7');
    return new Response(body, { headers: { 'content-type': 'application/json', 'last-modified': 'Tue, 20 Oct 2026 10:00:00 GMT' } });
  });
  const result = await fetchRaw(feed, { key: credential });
  assertSafe(result);
  assert.equal(new URL(result.fetchedUrl).searchParams.get('api_key'), 'REDACTED');
  assert.equal(result.body, body);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.proxyUsed, null);
  assert.equal(result.responseHeaders['last-modified'], 'Tue, 20 Oct 2026 10:00:00 GMT');
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('diagnostic URL redaction: actual HTTP transport-error envelope is safe without listening', async (t) => {
  const require = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
  const modulePath = require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js').replace('/dist/cjs/', '/dist/esm/');
  const { StreamableHTTPServerTransport } = await import(modulePath);
  t.mock.method(StreamableHTTPServerTransport.prototype, 'handleRequest', async () => {
    throw new Error(`Synthetic transport failure ${wrap(`https://fixture.invalid/?API_KEY=${syntheticCredential}&limit=7`)}`);
  });
  const req = { method: 'POST', url: '/mcp', rawHeaders: [], headers: { host: 'fixture.invalid', accept: 'application/json, text/event-stream' } };
  let payload;
  const res = Object.assign(new EventEmitter(), {
    setHeader() {}, writeHead(status) { this.statusCode = status; },
    end(value) { payload = JSON.parse(value); this.writableEnded = true; }
  });
  await httpServer.listeners('request')[0](req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(payload.error, 'mcp_transport_failed');
  assertSafe(payload);
});

test('diagnostic URL redaction: JSON escaping remains valid before EIA credential-field removal', async (t) => {
  const message = JSON.stringify({ url: 'https://fixture.invalid/?key=foo"hello', api_key: syntheticCredential,
    details: ['Retained "quoted" text', { path: 'C:\\fixture\\path', count: 0 }] });
  const safe = redactDiagnosticText(message);
  assert.doesNotThrow(() => JSON.parse(safe), 'URL redaction must not invalidate a JSON diagnostic');
  const parsed = JSON.parse(safe);
  assert.deepEqual(parsed.details, JSON.parse(message).details);
  assertSafe(sanitizeEiaPayload({ id: 'energy-eia' }, { message: safe }));

  t.mock.property(process, 'env', { ...process.env, EIA: syntheticCredential });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.ok(['api.eia.gov', 'api.allorigins.win', 'r.jina.ai'].includes(request.hostname));
    const upstream = request.hostname === 'api.allorigins.win' ? new URL(request.searchParams.get('url')) : request;
    assert.equal(upstream.searchParams.get('api_key'), syntheticCredential);
    throw new Error(message);
  });
  const client = await fixtureClient(t);
  const result = await client.callTool({ name: 'raw.fetch', arguments: { sourceId: 'energy-eia', ...dateRange } });
  assert.equal(result.structuredContent.error, 'fetch_failed');
  assertSafe(result);
  assert.equal(JSON.parse(result.structuredContent.message).api_key, undefined);
  assert.equal(globalThis.fetch.mock.callCount(), 3);
});

test('diagnostic URL redaction: total error-text length and JSON traversal are bounded', () => {
  const adversarial = '?'.repeat(60000);
  assert.equal(redactDiagnosticText(adversarial) === adversarial, true);
  assert.equal(redactDiagnosticText('?'.repeat(65537)) === 'REDACTED', true, 'oversized text must fail closed');
  let deep = { url: `https://fixture.invalid/?key=${syntheticCredential}` };
  for (let depth = 0; depth < 20; depth += 1) deep = { nested: deep };
  assert.equal(redactDiagnosticText(JSON.stringify(deep)) === 'REDACTED', true, 'over-depth JSON must fail closed');
  const wide = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field${index}`, 'ordinary']));
  assert.equal(redactDiagnosticText(JSON.stringify(wide)) === 'REDACTED', true, 'over-budget JSON must fail closed');
  assert.equal(redactDiagnosticText('{ "message": "ordinary", "count": 0 }'), '{ "message": "ordinary", "count": 0 }');
});

const congressFeed = JSON.parse(readFileSync(new URL('../../gcp/mcp-proxy/feeds.json', import.meta.url))).feeds
  .find((feed) => feed.id === 'congress-reports');
const dateRange = { start: '2026-10-01', end: '2026-10-28' };
const sourceBody = { items: [{ title: 'Retained report', url: 'https://fixture.invalid/report/7',
  summary: 'Retained signal', publishedAt: '2026-10-20T10:00:00Z' }] };

async function fixtureClient(t) {
  const require = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { InMemoryTransport } = await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
  const server = buildMcpServer();
  const client = new Client({ name: 'diagnostic-url-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

for (const mode of ['success', '408', 'transport-error']) {
  test(`diagnostic URL redaction: actual raw/history/list/get/search wrappers ${mode}`, async (t) => {
    // This test process owns only a synthetic environment value, never a provider credential.
    t.mock.property(process, 'env', { ...process.env, DATA_GOV: syntheticCredential });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      const request = new URL(url);
      calls.push(request.hostname);
      assert.ok(['api.congress.gov', 'api.allorigins.win', 'r.jina.ai'].includes(request.hostname));
      const upstream = request.hostname === 'api.allorigins.win' ? new URL(request.searchParams.get('url')) : request;
      assert.equal(upstream.searchParams.get('api_key'), syntheticCredential, 'transport must retain its credential');
      assert.equal(upstream.searchParams.get('format'), 'json');
      if (request.hostname === 'api.congress.gov') throw new Error('Synthetic direct transport failure');
      const echoed = wrap(wrap(`https://fixture.invalid/reports?api_key=${syntheticCredential}&limit=7`));
      if (mode === 'transport-error') throw new Error(`Synthetic failed URL ${echoed}`);
      return mode === 'success'
        ? new Response(JSON.stringify(sourceBody), { headers: { 'content-type': 'application/json', 'last-modified': 'Tue, 20 Oct 2026 10:00:00 GMT' } })
        : new Response(JSON.stringify({ message: `Timeout ${echoed}` }), { status: 408, headers: { 'content-type': 'application/json' } });
    });
    const client = await fixtureClient(t);
    const wrappers = ['raw.fetch', 'raw.history', 'signals.list', 'signals.get', 'search.smart'];
    for (const name of wrappers) {
      const args = name === 'search.smart' ? { sources: ['congress-reports'], ...dateRange }
        : { sourceId: 'congress-reports', ...dateRange, params: { limit: 7 }, ...(name === 'signals.get' ? { id: 'not-found' } : {}),
          ...(['raw.fetch', 'raw.history'].includes(name) ? { format: 'json' } : {}) };
      const result = await client.callTool({ name, arguments: args });
      assertSafe(result);
      const payload = result.structuredContent;
      assert.ok(payload, 'real MCP dispatch must return structured content');
      if (name === 'raw.history') {
        assert.equal(payload.error, 'history_not_supported', 'do not invent historical support');
        assert.equal(payload.sourceId, 'congress-reports');
        continue;
      }
      if (name === 'search.smart') {
        assert.deepEqual(payload.range, dateRange);
        assert.deepEqual(payload.sourcesQueried, payload.sourcesChecked);
        assert.equal(payload.sourcesChecked.length, 1);
        const checked = payload.sourcesChecked[0];
        assert.equal(checked.sourceId, 'congress-reports');
        assert.equal(checked.ok, mode === 'success');
        assert.equal(checked.configured, true);
        assert.equal(checked.fallbackUsed, mode === 'success');
        if (mode === 'success') {
          assert.equal(checked.count, 1);
          assert.equal(payload.signals[0].publishedAt, Date.parse(sourceBody.items[0].publishedAt));
          assert.equal(payload.signals[0].sourceId, 'congress-reports');
          assert.equal(payload.signals[0].url, sourceBody.items[0].url);
        } else {
          assert.equal(checked.httpStatus, mode === '408' ? 408 : null);
          assert.equal(checked.error, 'fetch_failed');
          assert.deepEqual(payload.signals, []);
        }
      } else if (mode === 'success') {
        assert.equal(payload.sourceId, 'congress-reports');
        assert.equal(payload.fallbackUsed, true);
        assert.equal(payload.proxyUsed, 'allorigins');
        if (name.startsWith('raw.')) assert.deepEqual(payload.data, sourceBody);
        if (name === 'signals.list') {
          assert.equal(payload.items.length, 1);
          assert.equal(payload.items[0].publishedAt, Date.parse(sourceBody.items[0].publishedAt));
          const summary = summarizeSignals({ data: payload }, congressFeed);
          assertSafe(summary);
          assert.equal(summary.newestTimestamp, Date.parse(sourceBody.items[0].publishedAt));
        }
        if (name === 'signals.get') assert.equal(payload.item, null);
      } else {
        assert.equal(payload.error, 'fetch_failed');
        assert.equal(payload.httpStatus, mode === '408' ? 408 : null);
        const summary = summarizeProxyPayload(congressFeed, payload);
        assertSafe(summary);
        assert.equal(summary.error, 'fetch_failed');
        assert.equal(summary.newestTimestamp, null);
      }
    }
    assert.equal(calls.length, (wrappers.length - 1) * (mode === 'transport-error' ? 3 : 2));
  });
}
