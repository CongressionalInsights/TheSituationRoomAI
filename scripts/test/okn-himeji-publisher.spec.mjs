import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildMcpServer } from '../../gcp/mcp-proxy/server.js';
import {
  acquirePinnedHimejiPublisherReceipt, HIMEJI_BODY_LIMIT, HIMEJI_DEADLINE_MS, HIMEJI_PUBLISHER_URL,
} from '../../gcp/mcp-proxy/okn-himeji-publisher-receipt.js';

const requireFromProxy = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
const { Client } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/inMemory.js'));
const response = (body, opts = {}) => new Response(body, {
  status: opts.status ?? 200,
  headers: { 'content-type': 'application/json', ...opts.headers },
});

test('one bounded acquisition uses the exact official immutable URL and no redirect', async () => {
  let count = 0;
  const result = await acquirePinnedHimejiPublisherReceipt({
    now: () => Date.parse('2026-11-25T12:10:00.000Z'),
    fetchImpl: async (url, options) => {
      count++;
      assert.equal(url, HIMEJI_PUBLISHER_URL);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return response('{}');
    },
  });
  assert.equal(count, 1);
  assert.equal(result.url, HIMEJI_PUBLISHER_URL);
  assert.equal(result.retrievedAt, '2026-11-25T12:10:00.000Z');
  assert.equal(result.body.toString(), '{}');
});

test('media type, HTTP errors, deceptive lengths, and oversized bodies fail closed without retries', async () => {
  for (const make of [
    () => response('{}', {status: 429}),
    () => response('{}', {headers: {'content-type':'text/html'}}),
    () => response('{}', {headers: {'content-length': String(HIMEJI_BODY_LIMIT + 1)}}),
    () => response(Buffer.alloc(HIMEJI_BODY_LIMIT + 1)),
    () => response(null),
    () => { const r=response('{}'); Object.defineProperty(r, 'redirected', {value: true}); return r; },
    () => { const r=response('{}'); Object.defineProperty(r, 'url', {value: 'https://not-a-provider.invalid'}); return r; },
  ]) {
    let count = 0;
    assert.deepEqual(await acquirePinnedHimejiPublisherReceipt({
      fetchImpl: async () => { count++; return make(); },
    }), { error: 'publisher_unavailable' });
    assert.equal(count, 1);
  }
});

test('deadline covers stalled headers and stalled body; times out as unknown', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const make of [
    () => new Promise(() => {}),
    async () => response(new ReadableStream({ pull() { return new Promise(() => {}); } })),
  ]) {
    let signal;
    const pending = acquirePinnedHimejiPublisherReceipt({ fetchImpl: (_url, opts) => { signal=opts.signal; return make(); } });
    await Promise.resolve();
    t.mock.timers.tick(HIMEJI_DEADLINE_MS);
    assert.deepEqual(await pending, {error:'publisher_timeout'});
    assert.equal(signal.aborted, true);
  }
});

test('native MCP selected publisher failure cannot masquerade as successful fallback fixture', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected provider egress'));
  const himeji = JSON.parse(readFileSync(new URL('./fixtures/okn-wikidata-himeji.json', import.meta.url), 'utf8'));
  const options = { sourceId:'okn-wikidata-heritage',format:'json',params:{entityId:'Q188754'} };
  for (const [receipt, error] of [
    [{error:'publisher_timeout'}, 'publisher_timeout'],
    [{url:'https://not-a-provider.invalid'}, 'invalid_publisher_receipt'],
    [{url:HIMEJI_PUBLISHER_URL,status:200,redirected:false,contentType:'application/json',
      retrievedAt:'2026-11-25T12:10:00.000Z',body:Buffer.from('{}')}, 'publisher_body_digest_changed'],
  ]) {
    const srv = buildMcpServer({scopedReferenceFixtures:{ himeji, himejiPublisherReceipt:receipt }});
    const cli = new Client({name:'pin-failure',version:'1.0.0'});
    const [a,b] = InMemoryTransport.createLinkedPair();
    await srv.connect(b); await cli.connect(a);
    try {
      const result = await cli.callTool({name:'raw.fetch',arguments:options});
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error, error);
      assert.equal(result.structuredContent.coverageStatus, 'UNKNOWN');
      assert.equal(result.structuredContent.verifiedZeroResults, false);
      assert.deepEqual(result.structuredContent.items, []);
    } finally { await cli.close(); await srv.close(); }
  }
  assert.equal(upstream.mock.callCount(), 0);
});
