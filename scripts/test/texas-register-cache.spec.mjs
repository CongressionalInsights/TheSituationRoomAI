import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import texas from '../../gcp/state-connector/adapters/tx.js';

const sourceUrl = 'https://www.sos.texas.gov/texreg/sos/index.html';
const fixture = `<title>Texas Register November 27, 2026</title><h1>
 <span name="headerDate">November 27, 2026</span></h1>
 <a href="../archive/November272026/Proposed Rules/index.html">Proposed rules</a>`;
const builder = readFileSync(new URL('../build_static_cache.mjs', import.meta.url), 'utf8');
const declaration = 'async function buildTexasRegisterIssue()';
const offset = builder.indexOf(declaration);
assert.ok(offset >= 0);
const code = builder.slice(offset, builder.indexOf('\n}', offset) + 2);

function run(response) {
  return vm.runInNewContext(code + '\nbuildTexasRegisterIssue()', {
    texas, Date, Buffer, TIMEOUT_MS: 12000, appConfig: { userAgent: 'offline fixture' },
    fetchWithTimeout: async (url, options, timeoutMs, consume) => {
      assert.equal(url, sourceUrl);
      assert.equal(options.redirect, 'error');
      assert.equal(timeoutMs, 12000);
      if (response instanceof Error) throw response;
      return consume(response);
    }
  });
}
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('the Texas Pages artifact contains only the verified official issue and acquisition provenance', async () => {
  const artifact = await run(html(fixture));
  assert.equal(artifact.status, 'available');
  assert.equal(artifact.schema, 'tsr-texas-register-issue/v1');
  assert.equal(artifact.producer, 'tsr-pages-static-cache');
  assert.equal(artifact.sourceUrl, sourceUrl);
  assert.equal(artifact.httpStatus, 200);
  assert.ok(Number.isFinite(Date.parse(artifact.acquiredAt)));
  assert.deepEqual({ ...artifact.issue }, {
    title: 'Texas Register issue for November 27, 2026', issueDate: '2026-11-27',
    url: 'https://www.sos.texas.gov/texreg/archive/November272026/index.html'
  });
  assert.match(builder, /await writeJson\(join\(FEED_DIR, 'texas-register-current-issue\.json'\), texasIssue\)/);
});

test('a refusal, transport failure, malformed issue, or oversized body is an explicit unavailable artifact', async () => {
  for (const [response, failure, status] of [
    [html('private error text', 405), 'source_http_error', 405],
    [new Error('private transport details'), 'transport_failed', null],
    [html('<title>No current issue</title>'), 'invalid_issue', 200],
    [html('x'.repeat(513 * 1024)), 'body_limit', 200]
  ]) {
    const artifact = await run(response);
    assert.equal(artifact.status, 'unavailable');
    assert.equal(artifact.failure, failure);
    assert.equal(artifact.httpStatus, status);
    assert.ok(Number.isFinite(Date.parse(artifact.attemptedAt)));
    assert.equal(artifact.issue, undefined);
    assert.equal(artifact.acquiredAt, undefined);
    assert.doesNotMatch(JSON.stringify(artifact), /private/);
  }
});
