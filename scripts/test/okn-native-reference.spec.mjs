import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { buildMcpServer, httpServer } from '../../gcp/mcp-proxy/server.js';

const requireFromProxy = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
const { Client } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/inMemory.js'));
const { StreamableHTTPClientTransport } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));

const read = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const makeInputs = () => ({
  kennebec: read('okn-kennebec-reference.json'), himeji: read('okn-wikidata-himeji.json'),
});
const cases = Object.fromEntries(read('okn-native-reference-wire.json').cases.map(x => [x.name, x]));
const run = (client, testCase) => client.callTool(cases[testCase].request);
const sha = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

async function local(t, opts) {
  const server = buildMcpServer(opts);
  const client = new Client({ name: 'native-reference-in-memory', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('native raw.fetch provides both exact pinned contracts only with programmatic fixture input', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('upstream fetch not permitted'));
  const source = makeInputs();
  const client = await local(t, { scopedReferenceFixtures: source });
  // Neither the caller nor a later injected-object mutation can change trusted provenance.
  source.kennebec.primary.observations[0].value = 888;
  source.himeji.publisherReceipt.claims[0].value = '988';
  for (const name of ['kennebec', 'himeji', 'wrong_place', 'wrong_entity']) {
    assert.deepEqual(await run(client, name), cases[name].response);
  }
  const k = (await run(client, 'kennebec')).structuredContent;
  const h = (await run(client, 'himeji')).structuredContent;
  assert.equal(sha(k.items[0].reference), '49ef8d5995651ce53e53662589af929abb063665190582d8ec0224dddb25db94');
  assert.deepEqual(k.items[0].reference.historicalObservations.map(x => [x.sampleYear,x.value,x.unit]), [
    [2023, 11.8, 'ng/g'], [2023, 20.4, 'ng/g'],
  ]);
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].event.year, 1993);
  assert.equal(h.provenance.crosswalkRole, 'identifier_link_only');
  assert.equal(h.provenance.entityRevision, '2568222523');
  for (const evidence of [k, h]) {
    assert.equal(evidence.graphCoverageVerified, false);
    assert.equal(evidence.verifiedZeroResults, false);
    assert.equal(evidence.freshness, null);
    assert.equal(evidence.provenance.retrievedAt, null);
    assert.equal(evidence.evidenceMode, 'pinned_publisher_fixture');
  }
  for (const sourceCase of ['kennebec', 'himeji']) {
    const args = cases[sourceCase].request.arguments;
    for (const unsupported of [
      { ...args, params: { ...args.params, force: true } },
      { ...args, params: { ...args.params, url: 'https://not-a-provider.invalid' } },
      { ...args, query: 'similar name' },
      { ...args, start: '1993-01-01', end: '2023-12-31' },
      { ...args, format: 'csv' },
    ]) {
      const result = await client.callTool({ name: 'raw.fetch', arguments: unsupported });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.coverageStatus, 'UNSUPPORTED');
      assert.equal(result.structuredContent.verifiedZeroResults, false);
      assert.deepEqual(result.structuredContent.items, []);
    }
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('damaged evidence is uncertainty, while missing opt-in lane keeps native unknown-source behavior', async t => {
  const inputs = makeInputs();
  inputs.himeji.publisherReceipt = {};
  delete inputs.kennebec;
  const client = await local(t, { scopedReferenceFixtures: inputs });
  assert.deepEqual(await run(client, 'bad_receipt'), cases.bad_receipt.response);
  assert.deepEqual(await run(client, 'kennebec_default_off'), cases.kennebec_default_off.response);
});

test('catalog, tools and existing reference reads stay unchanged with or without local fixtures', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('upstream fetch not permitted'));
  const off = await local(t);
  const on = await local(t, { scopedReferenceFixtures: makeInputs() });
  assert.deepEqual(await off.listTools(), await on.listTools());
  for (const args of [{}, { category: 'reference' }, { category: 'state', state: 'NC' }]) {
    const request = { name: 'catalog.sources', arguments: args };
    assert.deepEqual(await off.callTool(request), await on.callTool(request));
  }
  for (const name of ['kennebec_default_off', 'himeji_default_off']) {
    assert.deepEqual(await run(off, name), cases[name].response);
    const {sourceId} = cases[name].request.arguments;
    const request = {name:'raw.history',arguments:{sourceId,start:'1993-01-01',end:'2023-12-31'}};
    assert.deepEqual(await off.callTool(request), await on.callTool(request));
  }
  const geoconnex = {name:'raw.fetch', arguments:{sourceId:'okn-geoconnex-watersheds',format:'json',params:{huc8:'06010105'}}};
  const baseline = await off.callTool(geoconnex);
  assert.equal(baseline.structuredContent.error, 'unknown_source');
  assert.deepEqual(await on.callTool(geoconnex), baseline);
  assert.equal(fetch.mock.callCount(), 0);
});

test('real HTTP MCP never enables the local fixture mode from caller fields', async t => {
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve())));
  const endpoint = new URL('http://127.0.0.1:' + httpServer.address().port + '/mcp');
  const actualFetch = globalThis.fetch;
  let egress = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === endpoint.href) return actualFetch(url, options);
    egress++;
    return assert.fail('upstream fetch not permitted');
  });
  const client = new Client({name:'native-http-default-off',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  try {
    for (const name of ['kennebec_default_off', 'himeji_default_off']) {
      const {request,response} = cases[name];
      const args = { ...request.arguments, scopedReferenceFixtures: true,
        params: { ...request.arguments.params, force: true } };
      assert.deepEqual(await client.callTool({name:request.name,arguments:args}), response);
    }
  } finally { await client.close(); }
  assert.equal(egress, 0);
});
