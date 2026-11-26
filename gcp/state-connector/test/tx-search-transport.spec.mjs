import test from 'node:test';
import assert from 'node:assert/strict';
import { pagesIssueUrl } from '../adapters/tx-search-issue.js';

test('Texas snapshot fetch caps decoded bytes and rejects redirects without changing the caller contract', async (t) => {
  const key = 'test-connector-key';
  const previous = process.env.API_KEY;
  process.env.API_KEY = key;
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  });
  t.mock.method(console, 'log', () => {});
  const { handleRequest } = await import('../server.js');
  const mock = t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, pagesIssueUrl);
    assert.equal(opts.redirect, 'error');
    assert.equal(new Headers(opts.headers).has('X-API-Key'), false);
    return new Response('x'.repeat(4097));
  });
  const res = {
    setHeader() {},
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handleRequest({ method: 'GET', url: '/signals?state=TX&signalType=rulemaking', headers: { 'x-api-key': key } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.meta.verifiedZeroResults, false);
  assert.match(res.body.meta.errors[0].message, /exceeds the response limit/);
  assert.equal(mock.mock.callCount(), 1);
});
