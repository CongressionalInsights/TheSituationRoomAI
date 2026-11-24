import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../build_static_cache.mjs', import.meta.url), 'utf8');
const direct = 'https://www.theguardian.com/world/rss';
const relay = 'https://relay.invalid/';
const rss = '<rss><channel><item><title>Fixture</title></item></channel></rss>';
const secret = 'never-log-this-value';
const xml = () => new Response(rss, { headers: { 'Content-Type': 'text/xml' } });

function fixture(first) {
  const logs = [];
  const calls = [];
  const fn = script.slice(script.indexOf('async function fetchRssWithFallbacks('),
    script.indexOf('async function getOpenSkyToken('));
  const fetchRss = vm.runInNewContext(fn + '\nfetchRssWithFallbacks', {
    Buffer,
    buildFetchCandidates: (url, proxies) => [url, ...proxies],
    console: { log: line => logs.push(line) },
    fetchWithTimeout: async (url, headers, ms) => {
      calls.push({ url, headers, ms });
      return url === direct ? first() : xml();
    },
    isLikelyRssPayload: (_type, body) => body.startsWith('<rss>'),
    normalizeContentType: (value = '') => value.split(';')[0]
  });
  return { logs, calls, fetchRss };
}

const cases = [
  ['request failure', () => { throw new Error(secret, { cause: { code: 'UND_ERR_SOCKET' } }); },
    { stage: 'fetch', status: null, redirected: null, type: null, bodyBytes: null, failureCode: 'UND_ERR_SOCKET' }],
  ['unknown error code', () => { throw new Error(secret, { cause: { code: secret } }); },
    { stage: 'fetch', status: null, redirected: null, type: null, bodyBytes: null, failureCode: 'unknown' }],
  ['timeout', () => { throw new DOMException(secret, 'AbortError'); },
    { stage: 'fetch', status: null, redirected: null, type: null, bodyBytes: null, failureCode: 'timeout' }],
  ['body failure after headers', () => ({
    status: 200, redirected: false, headers: new Headers({ 'Content-Type': 'text/xml', 'Set-Cookie': secret }),
    text: async () => { throw new Error(secret, { cause: { code: 'Z_DATA_ERROR' } }); }
  }), { stage: 'body', status: 200, redirected: false, type: 'xml', bodyBytes: null, failureCode: 'Z_DATA_ERROR' }],
  ['HTTP rejection after redirect', () => ({
    ok: false, status: 403, redirected: true, url: direct + '?' + secret,
    headers: new Headers({ 'Content-Type': 'text/html', 'Set-Cookie': secret }), text: async () => secret
  }), { stage: 'http', status: 403, redirected: true, type: 'html', bodyBytes: secret.length, failureCode: null }],
  ['HTML 200 rejected as RSS', () => new Response('<html>' + secret + '</html>', {
    headers: { 'Content-Type': 'text/html' }
  }), { stage: 'rss', status: 200, redirected: false, type: 'html', bodyBytes: 13 + secret.length, failureCode: null }]
];

for (const [name, first, expected] of cases) {
  test('Guardian reports ' + name + ' once and retains the normal relay fallback', async () => {
    const { fetchRss, logs, calls } = fixture(first);
    const headers = { Accept: 'application/rss+xml' };
    const result = await fetchRss(direct, headers, [relay], 20000, { diagnoseGuardian: true });
    assert.equal(result.valid, true);
    assert.equal(result.body, rss);
    assert.deepEqual(calls, [{ url: direct, headers, ms: 15000 }, { url: relay, headers, ms: 5000 }]);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], new RegExp(secret + '|https?:'));
    const { elapsedMs, ...evidence } = JSON.parse(logs[0]);
    assert.ok(elapsedMs >= 0);
    assert.deepEqual(evidence, { event: 'guardian_pages_primary', feedId: 'guardian-world', ...expected });
  });
}

test('valid direct RSS is accepted without calling the relay, including for other feeds without diagnostics', async () => {
  const traced = fixture(xml);
  assert.equal((await traced.fetchRss(direct, {}, [relay], 20000, { diagnoseGuardian: true })).body, rss);
  assert.equal(traced.calls.length, 1);
  assert.equal(JSON.parse(traced.logs[0]).stage, 'accepted');
  const other = fixture(xml);
  assert.equal((await other.fetchRss('https://other.invalid/rss', {}, [relay], 20000)).body, rss);
  assert.equal(other.calls.length, 1);
  assert.deepEqual(other.logs, []);
  assert.match(script, /diagnoseGuardian: feed\.id === 'guardian-world'/);
});
