import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { inspectBlsPayload } from '../gcp/feed-proxy/bls.js';

export async function verifyFeedContent(base, { fetchImpl = fetch, now = Date.now() } = {}) {
  const request = async (url, body) => {
    const response = await fetchImpl(`${base}${url}`, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    return { status: response.status, data: await response.json() };
  };
  const catalog = await request('/api/feeds');
  const expected = JSON.parse(fs.readFileSync(new URL('../data/feeds.json', import.meta.url)));
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data, { app: expected.app, feeds: expected.feeds }, 'Serving catalog differs from exact checkout');
  const retired = await request('/api/feed', { id: 'stooq-quote', force: true });
  assert.equal(retired.status, 410);
  assert.equal(retired.data.error, 'source_retired');
  const results = {};
  for (const id of ['federal-register', 'congress-api', 'bls-cpi']) {
    const result = await request('/api/feed', { id, force: true });
    assert.equal(result.status, 200, `${id} transport failed`);
    assert.ok(!result.data.error && result.data.body, `${id} acquisition failed`);
    if (id === 'federal-register') assert.ok(JSON.parse(result.data.body).items?.length);
    if (id === 'bls-cpi') {
      assert.equal(inspectBlsPayload(result.data.body, 'CUUR0000SA0').error, null, 'BLS response is not a valid series');
      assert.ok(!result.data.stale && !result.data.fallback && result.data.fallbackUsed === false, 'BLS release acquisition is degraded');
      const schedule = JSON.parse(fs.readFileSync(new URL('../data/feed-monitoring.json', import.meta.url)))['bls-cpi'].publicationSchedule;
      const releases = schedule.releases;
      const due = releases.filter(release => Date.parse(release.scheduledAt) <= now).at(-1);
      assert.ok(due && releases.some(release => Date.parse(release.scheduledAt) > now), 'BLS schedule no longer brackets release');
      const body = JSON.parse(result.data.body);
      const groups = Array.isArray(body.Results) ? body.Results : [body.Results];
      assert.ok(groups.flatMap(group => group.series).some(series => series.seriesID === schedule.seriesId
        && series.data.some(row => `${row.year}-${row.period}` === due.period && typeof row.value === 'string'
          && row.value.trim() !== '' && Number.isFinite(Number(row.value)))), 'Current numeric BLS reference period is not observed');
    }
    results[id] = { httpStatus: result.data.httpStatus, fallbackUsed: result.data.fallbackUsed || false };
  }
  return { catalogCount: catalog.data.feeds.length, retired: true, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyFeedContent(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
}
