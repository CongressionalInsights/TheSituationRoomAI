import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildMcpServer, httpServer, MCP_REQUEST_LIMITS } from '../../gcp/mcp-proxy/server.js';

const require = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
const sdkModule = (name) => require.resolve(`@modelcontextprotocol/sdk/${name}`).replace('/dist/cjs/', '/dist/esm/');
const { StreamableHTTPServerTransport } = await import(sdkModule('server/streamableHttp.js'));
const { WebStandardStreamableHTTPServerTransport } = await import(sdkModule('server/webStandardStreamableHttp.js'));
const { McpServer } = await import(sdkModule('server/mcp.js'));
const { z } = await import(require.resolve('zod'));

// All tests in the importing fixture suite must stub upstream work explicitly.
globalThis.fetch = async () => { throw new Error('Upstream fetch blocked in MCP fixtures'); };
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const messages = (text) => text.startsWith('event:') || text.startsWith('data:')
  ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  : text ? [JSON.parse(text)] : [];

async function loopback(t, listener = httpServer.listeners('request')[0]) {
  const server = http.createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(server.listening, false);
  });
  return server.address().port;
}

function request(port, body, { method = 'POST', path = '/mcp', headers = {}, chunked = false, chunks } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: {
      'Content-Type': 'application/json',
      ...(chunked ? {} : { 'Content-Length': bytes.length }), ...headers
    } }, res => {
      const output = [];
      res.on('data', chunk => output.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(output).toString() }));
    });
    req.on('error', reject);
    for (const chunk of chunks || [bytes]) req.write(chunk);
    req.end();
  });
}

test('MCP limits use the exact locked SDK and supported default byte budget', () => {
  assert.equal(JSON.parse(readFileSync(new URL('../../../package.json', pathToFileURL(sdkModule('server/mcp.js'))))).version, '1.32.2');
  assert.deepEqual(MCP_REQUEST_LIMITS, { maxRequestBodySize: 4194304, maxToolInputElements: 10000 });
});

test('production raw HTTP preserves anonymous/authInfo, metadata, stateless headers and routing', async (t) => {
  const received = [];
  const connect = McpServer.prototype.connect;
  t.mock.method(McpServer.prototype, 'connect', async function (transport) {
    await connect.call(this, transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => { received.push(extra.authInfo); return onmessage(message, extra); };
  });
  const handler = httpServer.listeners('request')[0];
  const auth = { token: 'local-fixture', clientId: 'fixture', scopes: ['read'] };
  const port = await loopback(t, (req, res) => {
    if (req.headers.authorization) req.auth = auth;
    return handler(req, res);
  });
  const handle = StreamableHTTPServerTransport.prototype.handleRequest;
  const entry = t.mock.method(StreamableHTTPServerTransport.prototype, 'handleRequest', function (...args) {
    assert.equal(args.length, 2, 'production must never pass parsedBody');
    assert.equal(args[0].readableEnded, false, 'SDK must own the unread stream');
    return handle.apply(this, args);
  });
  const initialize = await request(port, rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' }
  }));
  assert.equal(initialize.status, 200);
  assert.equal(messages(initialize.text)[0].result.protocolVersion, '2025-11-25');
  assert.equal(initialize.headers['mcp-session-id'], undefined);
  assert.match(initialize.headers['content-type'], /text\/event-stream/);
  const notification = await request(port, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  const tools = await request(port, rpc('tools/list'), { headers: { Authorization: 'Bearer local-fixture', Origin: 'https://fixture.invalid' } });
  assert.equal(messages(tools.text)[0].result.tools.length, 7);
  assert.equal(tools.headers['access-control-allow-origin'], '*');
  assert.equal(tools.headers.vary, 'Origin');
  const catalog = await request(port, call('catalog.sources', { state: 'NC' }));
  assert.ok(messages(catalog.text)[0].result.structuredContent.sources.length > 0);
  assert.deepEqual(received, [undefined, undefined, auth, undefined]);
  assert.equal(entry.mock.callCount(), 4);
  for (const accept of ['application/json', 'text/event-stream', '*/*']) {
    assert.equal((await request(port, rpc('tools/list'), { headers: { Accept: accept } })).status, 200);
  }
  for (const [method, path, status] of [['GET', '/mcp', 200], ['OPTIONS', '/mcp', 204], ['DELETE', '/mcp', 405], ['GET', '/health', 200], ['GET', '/.well-known/mcp.json', 200], ['GET', '/missing', 404]]) {
    assert.equal((await request(port, '', { method, path })).status, status);
  }
});

test('production SDK reader enforces byte boundaries for length/chunked/UTF8 and rejects before dispatch', async (t) => {
  const port = await loopback(t);
  const cap = MCP_REQUEST_LIMITS.maxRequestBodySize;
  const base = JSON.stringify(call('catalog.sources', { category: 'no-match' }));
  const connect = McpServer.prototype.connect;
  let dispatched = 0;
  const transports = [];
  t.mock.method(McpServer.prototype, 'connect', async function (transport) {
    transports.push(transport);
    await connect.call(this, transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (...args) => { dispatched++; return onmessage(...args); };
  });
  for (const chunked of [false, true]) {
    for (const delta of [-1, 0, 1]) {
      // A declared oversize is rejected before reading; don't race an unnecessary 4 MiB write.
      const body = !chunked && delta > 0 ? base : base + ' '.repeat(cap + delta - Buffer.byteLength(base));
      const before = dispatched;
      const response = await request(port, body, { chunked, headers: !chunked ? { 'Content-Length': cap + delta } : {} });
      assert.equal(response.status, delta > 0 ? 413 : 200, `${chunked ? 'chunked' : 'length'} ${delta}`);
      assert.equal(dispatched - before, delta > 0 ? 0 : 1);
      if (delta > 0) assert.match(response.text, /4194304 bytes/);
    }
  }
  const utf8 = Buffer.from(JSON.stringify(call('catalog.sources', { category: '\u00e9\u6f22\ud83c\udf0d' })));
  const split = utf8.indexOf(Buffer.from('\u00e9')) + 1;
  const response = await request(port, utf8, { chunked: true, chunks: [utf8.subarray(0, split), utf8.subarray(split)] });
  assert.equal(response.status, 200);
  assert.equal(messages(response.text)[0].result.structuredContent.sources.length, 0);
  for (const delta of [0, 1]) {
    const padded = Buffer.concat([utf8, Buffer.alloc(cap + delta - utf8.length, ' ')]);
    assert.equal((await request(port, padded, { chunked: true })).status, delta ? 413 : 200);
  }
  for (const body of ['', '{', '{"jsonrpc":"2.0"}']) {
    const before = dispatched;
    const invalid = await request(port, body);
    assert.equal(invalid.status, 400);
    assert.equal(messages(invalid.text)[0].error.code, -32700);
    assert.equal(dispatched, before);
    assert.equal(invalid.headers['access-control-allow-origin'], '*');
  }
  assert.ok(transports.every(transport => transport._webStandardTransport._closed));
  assert.ok(transports.every(transport => transport._webStandardTransport._streamMapping.size === 0));
});

test('SDK raw and supported parsed entry retain the 100-message cap; parsed callers own byte parsing', async (t) => {
  const port = await loopback(t);
  for (const count of [100, 101]) {
    const batch = Array.from({ length: count }, (_, id) => rpc('tools/list', {}, id));
    const response = await request(port, batch);
    assert.equal(response.status, count === 100 ? 200 : 400);
    if (count === 100) assert.equal(messages(response.text).length, 100);
    else assert.match(response.text, /Batch must not exceed 100 messages/);
  }
  // SDK's optional parsedBody API deliberately bypasses byte reading. It remains supported,
  // but callers using it own a bounded parser; TSR's production entry above does not use it.
  const parsedPort = await loopback(t, async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: MCP_REQUEST_LIMITS.maxRequestBodySize });
    const count = Number(req.headers['x-fixture-count']);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, Array.from({ length: count }, (_, id) => rpc('tools/list', {}, id)));
    } finally { await transport.close(); await server.close(); }
  });
  for (const count of [100, 101]) {
    assert.equal((await request(parsedPort, '', { headers: { Accept: 'application/json, text/event-stream', 'X-Fixture-Count': count } })).status, count === 100 ? 200 : 400);
  }
});

test('production element ceiling accepts shallow arrays/records and rejects before schema/handler/provider', async (t) => {
  const port = await loopback(t);
  const cap = MCP_REQUEST_LIMITS.maxToolInputElements;
  const legitimate = messages((await request(port, call('search.smart', {
    sources: ['fixture-unknown'], categories: ['gov'], query: 'retained query',
    params: { state: 'NC', page: 1, include: true }, totalLimit: 20
  }))).text)[0].result;
  assert.equal(Boolean(legitimate.isError), false);
  assert.deepEqual(legitimate.structuredContent.sourcesChecked, []);
  for (const extra of [0, 1]) {
    const params = Object.fromEntries(Array.from({ length: cap - 2 + extra }, (_, i) => [`p${i}`, i]));
    const result = messages((await request(port, call('raw.fetch', { sourceId: 'fixture-unknown', params }))).text)[0].result;
    assert.equal(Boolean(result.isError), extra === 1);
    if (!extra) assert.equal(result.structuredContent.error, 'unknown_source');
    else assert.match(result.content[0].text, /maximum of 10000 elements/);
  }
  let parsed = 0;
  let handled = 0;
  const connect = McpServer.prototype.connect;
  t.mock.method(McpServer.prototype, 'connect', function (transport) {
    this.registerTool('fixture.metadata', { inputSchema: z.object({ values: z.array(z.string()), params: z.record(z.string(), z.boolean()) }).superRefine(() => parsed++) }, async () => {
      handled++;
      return { content: [{ type: 'text', text: 'metadata' }] };
    });
    return connect.call(this, transport);
  });
  for (const extra of [0, 1]) {
    const result = messages((await request(port, call('fixture.metadata', { values: Array(cap - 3 + extra).fill('source'), params: { enabled: true } }))).text)[0].result;
    assert.equal(Boolean(result.isError), extra === 1);
  }
  assert.equal(parsed, 1);
  assert.equal(handled, 1);
});

test('SDK stream failures release reader locks and production aborts/exceptions close transports', async (t) => {
  const unicodeId = '\u00e9\u6f22\ud83c\udf0d';
  const encoded = Buffer.from(JSON.stringify(call('raw.fetch', { sourceId: unicodeId })));
  const split = encoded.indexOf(Buffer.from(unicodeId)) + 1;
  const unicodeBody = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.subarray(0, split));
    controller.enqueue(encoded.subarray(split, split + 2));
    controller.enqueue(encoded.subarray(split + 2));
    controller.close();
  } });
  const unicodeServer = buildMcpServer();
  const unicodeTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: MCP_REQUEST_LIMITS.maxRequestBodySize });
  await unicodeServer.connect(unicodeTransport);
  try {
    const response = await unicodeTransport.handleRequest(new Request('http://127.0.0.1/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: unicodeBody, duplex: 'half'
    }));
    assert.equal(messages(await response.text())[0].result.content[0].text, `Unknown source: ${unicodeId}`);
    assert.equal(unicodeBody.locked, false);
  } finally { await unicodeTransport.close(); await unicodeServer.close(); }
  let read = 0;
  const declaredBody = new ReadableStream({ pull() { read++; } }, { highWaterMark: 0 });
  const declaredTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: MCP_REQUEST_LIMITS.maxRequestBodySize });
  const declared = await declaredTransport.handleRequest(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'Content-Length': MCP_REQUEST_LIMITS.maxRequestBodySize + 1 }, body: declaredBody, duplex: 'half'
  }));
  assert.equal(declared.status, 413);
  assert.equal(read, 0, 'declared oversize must reject without reading');
  assert.equal(declaredBody.locked, false);
  await declaredTransport.close();
  await declaredBody.cancel();
  for (const name of ['Error', 'AbortError']) {
    const error = new Error('local stream failure');
    error.name = name;
    const body = new ReadableStream({ start(controller) { controller.error(error); } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: MCP_REQUEST_LIMITS.maxRequestBodySize });
    const response = await transport.handleRequest(new Request('http://127.0.0.1/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body, duplex: 'half'
    }));
    assert.equal(response.status, 400);
    assert.equal(body.locked, false);
    await transport.close();
    assert.equal(transport._streamMapping.size, 0);
  }
  const port = await loopback(t);
  const connect = McpServer.prototype.connect;
  let connected;
  let closed;
  const connectedPromise = new Promise(resolve => { connected = resolve; });
  const closedPromise = new Promise(resolve => { closed = resolve; });
  t.mock.method(McpServer.prototype, 'connect', async function (transport) {
    await connect.call(this, transport);
    const close = transport.close.bind(transport);
    transport.close = async () => { await close(); closed(transport); };
    connected();
  });
  const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 1000 }, agent: false });
  req.on('error', () => {});
  req.write('{');
  await connectedPromise;
  req.destroy();
  const aborted = await closedPromise;
  assert.equal(aborted._webStandardTransport._closed, true);
  assert.equal(aborted._webStandardTransport._streamMapping.size, 0);
  t.mock.method(StreamableHTTPServerTransport.prototype, 'handleRequest', async () => { throw new Error('fixture transport error'); });
  const response = await request(port, rpc('tools/list'));
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.text).error, 'mcp_transport_failed');
});
