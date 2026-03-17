import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildDefaultSampleParams,
  resolveMonitoringEntry
} from '../../analysis/monitor/lib/catalog.mjs';
import { parseCliArgs } from '../../analysis/monitor/lib/client.mjs';
import {
  normalizeDocText,
  extractDatedEntries,
  classifyDocChange,
  collectDocumentSurfaces
} from '../../analysis/monitor/lib/doc_watch.mjs';
import {
  summarizeProxyPayload,
  evaluateInvariant
} from '../../analysis/monitor/lib/audit.mjs';
import {
  createAlert,
  applyKnownUpstreamQuirks,
  dedupeAlerts,
  diffAlerts
} from '../../analysis/monitor/lib/reporting.mjs';

const fixture = (name) => fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'fixtures', 'monitor', name), 'utf8');
const parseFixture = (name) => JSON.parse(fixture(name));

function buildContext(entry, proxySummary, signalSummary = { error: null, items: [], count: 0, newestTimestamp: null }) {
  return {
    entry,
    proxySummary,
    rawSummary: proxySummary,
    signalSummary
  };
}

test('CLI can allow alerts without failing workflow runs', () => {
  assert.equal(parseCliArgs([]).allowAlerts, false);
  assert.equal(parseCliArgs(['--allow-alerts']).allowAlerts, true);
});

test('monitoring entry derives defaults for feeds without explicit overrides', () => {
  const feed = {
    id: 'example-feed',
    name: 'Example Feed',
    category: 'news',
    format: 'rss',
    supportsQuery: true,
    defaultQuery: 'alerts',
    ttlMinutes: 30
  };
  const entry = resolveMonitoringEntry(feed, {}, { defaultRefreshMinutes: 60 });
  assert.equal(entry.tier, 'standard');
  assert.equal(entry.docsUrl, null);
  assert.equal(entry.freshnessWindowMinutes, 90);
  assert.deepEqual(buildDefaultSampleParams(feed), { query: 'alerts' });
  assert.ok(entry.invariants.includes('rss-structure'));
});

test('document helpers normalize content, extract dates, and classify contract changes', () => {
  const html = fixture('docs-contract.html');
  const normalized = normalizeDocText(html, 'text/html');
  assert.match(normalized, /Breaking schema change/i);
  const dated = extractDatedEntries(html);
  assert.equal(dated[0].date, 'April 1, 2026');
  const classification = classifyDocChange({
    previous: { hash: 'old' },
    current: { hash: 'new', normalizedText: normalized },
    surfaceType: 'changelog',
    tier: 'core'
  });
  assert.equal(classification.regressionClass, 'docs-contract-change');
  assert.equal(classification.severity, 'critical');
});

test('document surfaces dedupe shared URLs across feeds', () => {
  const surfaces = collectDocumentSurfaces([
    { id: 'congress-api', tier: 'core', docsUrl: 'https://api.congress.gov/', changelogUrl: null, statusUrl: null, supportUrl: null },
    { id: 'congress-reports', tier: 'core', docsUrl: 'https://api.congress.gov/', changelogUrl: null, statusUrl: null, supportUrl: null }
  ]);
  assert.equal(surfaces.length, 1);
  assert.deepEqual(surfaces[0].feedIds.sort(), ['congress-api', 'congress-reports']);
  assert.equal(surfaces[0].representativeFeedId, 'congress-api');
});

test('known quirks downgrade alerts and alert diffs suppress repeated known issues', () => {
  const alert = createAlert({
    feedId: 'congress-reports',
    regressionClass: 'committee-report-sort-health',
    severity: 'critical',
    message: 'Committee report asc/desc top citations are identical.'
  });
  const downgraded = applyKnownUpstreamQuirks(alert, [{
    id: 'committee-report-sort-degraded',
    regressionClass: 'committee-report-sort-health',
    severity: 'warning',
    suppressNew: true,
    note: 'Known upstream issue.'
  }]);
  assert.equal(downgraded.severity, 'warning');
  const deduped = dedupeAlerts([downgraded, downgraded]);
  assert.equal(deduped.length, 1);
  const deltas = diffAlerts(deduped, [downgraded]);
  assert.equal(deltas.newAlerts.length, 0);
});

test('RSS fixture is summarized correctly', () => {
  const feed = { id: 'google-news-us', format: 'rss' };
  const summary = summarizeProxyPayload(feed, {
    body: fixture('rss.xml'),
    contentType: 'application/rss+xml',
    httpStatus: 200
  }, {});
  assert.equal(summary.rawItemCount, 2);
  assert.equal(summary.error, null);
  assert.ok(summary.newestTimestamp);
});

test('deep-core invariants pass on valid fixtures and fail on state mismatch', () => {
  const openaqFeed = { id: 'openaq-api', format: 'json' };
  const openaqEntry = {
    id: 'openaq-api',
    tier: 'core',
    sampleParams: {}
  };
  const openaqSummary = summarizeProxyPayload(openaqFeed, {
    body: fixture('openaq.json'),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('openaq-meta-results', buildContext(openaqEntry, openaqSummary)), null);

  const eiaFeed = { id: 'energy-eia', format: 'json' };
  const eiaEntry = { id: 'energy-eia', tier: 'core', sampleParams: {} };
  const eiaSummary = summarizeProxyPayload(eiaFeed, {
    body: fixture('eia.json'),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('eia-response-data', buildContext(eiaEntry, eiaSummary)), null);

  const nwsFeed = { id: 'nws-alerts', format: 'json' };
  const nwsEntry = { id: 'nws-alerts', tier: 'core', sampleParams: {} };
  const nwsSummary = summarizeProxyPayload(nwsFeed, {
    body: fixture('nws.geojson'),
    contentType: 'application/geo+json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('nws-alert-geometry', buildContext(nwsEntry, nwsSummary)), null);

  const stateSignals = parseFixture('state-legislation-signals.json').items;
  const stateEntry = {
    id: 'state-legislation',
    tier: 'core',
    sampleParams: {
      jurisdiction: 'ocd-jurisdiction/country:us/state:ny/government'
    }
  };
  assert.equal(evaluateInvariant('state-param-roundtrip', buildContext(stateEntry, eiaSummary, {
    error: null,
    count: stateSignals.length,
    items: stateSignals,
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  })), null);

  const mismatchAlert = evaluateInvariant('state-param-roundtrip', buildContext(stateEntry, eiaSummary, {
    error: null,
    count: 1,
    items: [{ jurisdictionCode: 'CA', publishedAt: '2026-03-15T12:00:00Z' }],
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  }));
  assert.equal(mismatchAlert.regressionClass, 'state-param-roundtrip');

  const sortAlert = evaluateInvariant('descending-update-sort', buildContext({
    id: 'congress-api',
    tier: 'core',
    sampleParams: {}
  }, eiaSummary, {
    error: null,
    count: 2,
    items: [
      { id: 'older', publishedAt: '2026-03-14T12:00:00Z' },
      { id: 'newer', publishedAt: '2026-03-15T12:00:00Z' }
    ],
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  }));
  assert.equal(sortAlert.regressionClass, 'descending-sort-broken');
});
