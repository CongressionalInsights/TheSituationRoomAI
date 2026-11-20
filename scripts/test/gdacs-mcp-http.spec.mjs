import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import { httpServer } from '../../gcp/mcp-proxy/server.js';
import { fetchGdacsMachinePayload, sourceUrl } from '../../gcp/mcp-proxy/gdacs-machine.js';
import { auditEntry } from '../../analysis/monitor/lib/audit.mjs';
import { loadMonitoringCatalog } from '../../analysis/monitor/lib/catalog.mjs';
import { callMcpTool } from '../../analysis/monitor/lib/client.mjs';
import { verifyGdacsCandidate } from '../verify_gdacs_candidate.mjs';

test('GDACS release smoke verifies original event identities without exposing them in monitor output', async t => {
  const now = Date.parse('2026-11-18T03:20:00Z');
  const saved = process.env.TSR_GDACS_SAVED_BODY;
  const fixture = saved ? JSON.parse(fs.readFileSync(saved)) : {
    type: 'FeatureCollection',
    features: [{type: 'Feature', geometry: {type: 'Point', coordinates: [20, 10]}, properties: {
      eventname: 'Fixture earthquake', alertlevel: 'Green', eventtype: 'EQ', eventid: 123, episodeid: 456, source: 'Fixture agency',
      datemodified: '2026-11-18T02:42:22', fromdate: '2026-11-18T01:42:22', todate: '2026-11-18T01:42:22',
      url: {report: 'https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=123&episodeid=456'}
    }}]
  };
  t.mock.timers.enable({ apis: ['Date'], now });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise(resolve => httpServer.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + httpServer.address().port + '/mcp';
  const nativeFetch = globalThis.fetch;
  const envelope = await fetchGdacsMachinePayload({ now: () => now, fetchImpl: async () => Response.json(fixture) });
  let feedResult = envelope;
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === endpoint) return nativeFetch(url, options);
    if (String(url) === 'https://fixture.test/api/feed') return Promise.resolve(Response.json(feedResult));
    if (String(url).startsWith('https://fixture.test/data/feeds/gdacs-alerts.json?')) return Promise.resolve(Response.json(envelope));
    if (String(url) === sourceUrl) {
      attempts++;
      return Promise.resolve(Response.json(fixture));
    }
    return Promise.resolve(new Response('<html>Fixture denied</html>', { headers: { 'content-type': 'text/html' } }));
  });
  const tools = [];
  let rawProof;
  const proof = await verifyGdacsCandidate('mcp', 'https://gha-100-1---situation-room-mcp-xtas2c6vka-uc.a.run.app', {
    now: () => now,
    callTool: async (_target, name, args, timeout, options) => {
      const result = await callMcpTool(endpoint, name, args, timeout, options);
      assert.equal(result.ok, true);
      tools.push(name);
      if (name === 'raw.fetch') {
        assert.match(result.data.body, /eventid=REDACTED/);
        assert.match(result.data.data.items[0].url, /eventid=REDACTED/);
        rawProof = result.gdacsVerification;
      }
      return result;
    }
  });
  assert.deepEqual(tools, ['raw.fetch', 'signals.list']);
  assert.equal(proof.status, 'machine_fallback_verified');
  assert.equal(rawProof?.count, fixture.features.length);
  assert.doesNotMatch(JSON.stringify(rawProof), /eventid|episodeid|report\.aspx/);
  assert.equal(proof.count, fixture.features.length);
  assert.equal(proof.signalsCount, Math.min(25, fixture.features.length));
  assert.equal(proof.newestAt, Date.parse('2026-11-18T02:42:22Z'));
  assert.equal(attempts, 2);

  const entry = loadMonitoringCatalog().entriesById['gdacs-alerts'];
  const monitor = { base: 'https://fixture.test', mcp: endpoint, staticBase: 'https://fixture.test', includeStatic: true, timeoutMs: 5000 };
  const full = await auditEntry(entry, monitor);
  assert.equal(full.raw.error, null);
  assert.equal(full.raw.rawItemCount, fixture.features.length);
  assert.equal(full.raw.coverage.product, 'events4app');
  assert.equal(full.raw.parsedBody, undefined, 'monitor retains only machine summary data');
  assert.equal(full.static.rawItemCount, fixture.features.length);
  assert.equal(full.proxy.stale, true, 'original primary-degradation flag remains');
  assert.deepEqual(full.alerts.map(alert => alert.regressionClass), ['primary-feed-degraded', 'fallback-engaged']);
  t.mock.timers.setTime(now + 90 * 60_000);
  const old = await auditEntry(entry, monitor);
  assert.ok(old.alerts.some(alert => alert.regressionClass === 'feed-stale'));
  assert.ok(old.alerts.some(alert => alert.regressionClass === 'freshness-window-exceeded'));
  t.mock.timers.setTime(now);
  feedResult = { ...envelope, fallback: 'live-cache' };
  const copied = await auditEntry(entry, monitor);
  assert.ok(copied.alerts.some(alert => alert.regressionClass === 'feed-stale'));
  assert.ok(!copied.alerts.some(alert => alert.regressionClass === 'primary-feed-degraded'));
});
