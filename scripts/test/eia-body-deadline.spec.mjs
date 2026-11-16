import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('gcp/feed-proxy/server.js', 'utf8');
const helperStart = source.indexOf('async function fetchWithTimeout(');
const helper = source.slice(helperStart, source.indexOf('\n}', helperStart) + 2);
const primaryStart = source.indexOf('      for (let attempt = 0; attempt < EIA_RETRY_ATTEMPTS;');
const primary = source.slice(primaryStart, source.indexOf('    } else {', primaryStart));
const legacyStart = source.indexOf('        const [legacyResponse, legacyBody]');
const legacy = source.slice(legacyStart, source.indexOf('\n      } catch', legacyStart));
function fixture(branch, responses) {
  let active = 0, calls = 0, reads = 0;
  const context = {
    AbortController, headers: {}, applied: { url: 'https://fixture.invalid/primary' }, legacyUrl: 'https://fixture.invalid/legacy',
    EIA_RETRY_ATTEMPTS: 2, EIA_RETRY_DELAY_MS: 1, FETCH_TIMEOUT_MS: 2, timeoutMs: 2,
    sleep: async () => {}, response: null, responseOk: false, body: '', contentType: '',
    setTimeout: callback => { active++; return setTimeout(callback, 5); },
    clearTimeout: timer => { active--; clearTimeout(timer); },
    fetch: async (_url, { signal }) => {
      const next = responses[calls++];
      return { ok: next.ok ?? true, status: next.status ?? 200, headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => {
          reads++; assert.equal(active, 1, 'body must remain within abort lifetime');
          if (next.slow) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('fixture', 'AbortError')), { once: true }));
          if (next.error) throw new Error('decode fixture');
          return next.body ?? '{"response":{"data":[]}}';
        } };
    }
  };
  vm.runInNewContext(helper + '\nthis.execute=async()=>{' + branch + '\n};', context);
  return { context, run: () => context.execute(), state: () => ({ active, calls, reads }) };
}
for (const [name, branch] of [['primary', primary], ['legacy', legacy]]) {
  test(`EIA ${name} body aborts and cleans up after headers`, async () => {
    const f = fixture(branch, [{ slow: true }]);
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.deepEqual(f.state(), { active: 0, calls: 1, reads: 1 });
    assert.equal(f.context.body, '');
  });
  test(`EIA ${name} success and body failure both clear timer`, async () => {
    for (const error of [false, true]) {
      const f = fixture(branch, [{ body: 'exact fixture bytes', error }]);
      if (error) await assert.rejects(f.run(), /decode fixture/);
      else { await f.run(); assert.equal(f.context.body, 'exact fixture bytes'); }
      assert.equal(f.state().active, 0);
    }
  });
}
test('EIA primary retries HTTP failures without consuming discarded bodies; reads final error', async () => {
  for (const ok of [true, false]) {
    const f = fixture(primary, [{ ok: false, error: true }, { ok, body: 'final body' }]);
    await f.run();
    assert.deepEqual(f.state(), { active: 0, calls: 2, reads: 1 });
    assert.equal(f.context.responseOk, ok);
    assert.equal(f.context.body, 'final body');
  }
});
test('EIA legacy HTTP failure does not consume body or replace prior response', async () => {
  const f = fixture(legacy, [{ ok: false, error: true }]);
  await f.run(); assert.deepEqual(f.state(), { active: 0, calls: 1, reads: 0 });
  assert.equal(f.context.response, null);
});
test('EIA stale cache returns before legacy acquisition and remains explicitly stale', async () => {
  const start = source.indexOf('    const hasUsableStale = staleCache', primaryStart);
  const end = source.indexOf('    const legacyUrl =', start);
  const context = { staleCache: { httpStatus: 200, body: 'cached bytes', fetchedAt: 1 }, Date };
  vm.runInNewContext('this.run=()=>{'+source.slice(start, end)+'};', context);
  const result = context.run(); assert.equal(result.stale, true); assert.equal(result.body, 'cached bytes');
  assert.equal(context.staleCache.fetchedAt, 1);
});

test('EIA final HTTP error body rejection retains status through catch, legacy failure and public payload', async () => {
  const catchStart = source.indexOf('  } catch (error) {', primaryStart);
  const catchEnd = source.indexOf('\n  if (isEiaSeries && (!response || !responseOk))', catchStart);
  const fallbackEnd = source.indexOf('\n  if (!response) {', catchEnd);
  const payloadStart = source.indexOf('  const payload = {', fallbackEnd);
  const payloadEnd = source.indexOf("  if (payload.error && feed.id === 'nasa-firms')", payloadStart);
  const cacheStart = source.indexOf('  const shouldCache =', payloadEnd);
  const cacheEnd = source.indexOf("  if (payload.error && feed.id === 'gdacs-alerts')", cacheStart);
  const branch = 'try {\n' + primary + source.slice(catchStart, catchEnd)
    + source.slice(catchEnd, fallbackEnd) + source.slice(payloadStart, payloadEnd)
    + source.slice(cacheStart, cacheEnd) + '\nreturn payload;';
  for (const slow of [false, true]) {
    const f = fixture(branch, [{ ok: false, status: 503 }, { ok: false, status: 401, slow, error: !slow }, { ok: false, status: 502 }]);
    Object.assign(f.context, { feed: { id: 'energy-eia-brent', format: 'json' }, isEiaSeries: true,
      staleCache: null, buildEiaLegacyUrl: () => 'https://fixture.invalid/legacy', effectiveKey: 'fixture',
      isRssFeed: false, isJsonHtmlError: () => false, bypassOpenAqUserCache: false,
      cacheKey: 'fixture', cache: { set: () => assert.fail('HTTP error must not be cached') } });
    const payload = await f.run();
    assert.equal(payload.httpStatus, 401);
    assert.equal(payload.error, 'http_401');
    assert.equal(payload.contentType, 'application/json');
    assert.equal(payload.body, '');
    assert.deepEqual(f.state(), { active: 0, calls: 3, reads: 1 });
  }
});
