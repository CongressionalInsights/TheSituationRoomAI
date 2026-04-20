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
  buildMarkdownReport,
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
  assert.equal(entry.auditEnabled, true);
  assert.equal(entry.docsUrl, null);
  assert.equal(entry.freshnessWindowMinutes, 90);
  assert.equal(entry.timeoutMs, 30000);
  assert.deepEqual(buildDefaultSampleParams(feed), { query: 'alerts' });
  assert.ok(entry.invariants.includes('rss-structure'));
});

test('monitoring entry honors audit exclusions and per-feed timeout overrides', () => {
  const feed = {
    id: 'connector-feed',
    name: 'Connector Feed',
    category: 'gov',
    format: 'json',
    ttlMinutes: 60
  };
  const entry = resolveMonitoringEntry(feed, {
    auditEnabled: false,
    timeoutMs: 45000
  }, { defaultRefreshMinutes: 60 });
  assert.equal(entry.auditEnabled, false);
  assert.equal(entry.timeoutMs, 45000);
});

test('monitoring overrides pin widened freshness windows for known slow-cadence feeds', () => {
  const monitoring = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed-monitoring.json'), 'utf8'));
  assert.equal(monitoring['gdelt-doc'].timeoutMs, 60000);
  assert.equal(monitoring['cdc-travel-notices'].freshnessWindowMinutes, 30240);
  assert.equal(monitoring['eonet-events'].freshnessWindowMinutes, 5760);
  assert.equal(monitoring['pbs-headlines'].freshnessWindowMinutes, 1440);
  assert.equal(monitoring['bbc-world'].freshnessWindowMinutes, 240);
  assert.equal(monitoring['state-legislation'].freshnessWindowMinutes, 1440);
  assert.equal(monitoring['fda-medwatch'].freshnessWindowMinutes, 4320);
  assert.equal(monitoring['gdelt-doc'].knownUpstreamQuirks[0].id, 'gdelt-signals-http403-transient');
  assert.ok(monitoring['gdelt-doc'].knownUpstreamQuirks.some((quirk) => quirk.id === 'gdelt-feed-http500-transient'));
  assert.ok(monitoring['gdelt-doc'].knownUpstreamQuirks.some((quirk) => quirk.id === 'gdelt-feed-html-json-parse-transient'));
  assert.equal(monitoring['blockstream-mempool'].knownUpstreamQuirks[0].id, 'blockstream-fallback-engaged-transient');
  assert.equal(monitoring['transport-opensky'].knownUpstreamQuirks[0].id, 'opensky-signals-timeout-transient');
  assert.equal(monitoring['nws-alerts'].knownUpstreamQuirks[0].id, 'nws-docs-contract-keyword-noise');
  assert.deepEqual(
    monitoring['energy-eia'].acceptedSurfaceHashes.support['https://www.eia.gov/opendata/'],
    [
      '5062524fcefa96b4d9dbff29c6c99469ca704224501a36c7e2ef2035228f9f13',
      '99e7f6ebd194c4723639d07a8b184c92835039cbb602ca746e2fda21db1d4d46',
      '4998fe189750185f982d1b96e65ed006e3603738a02c8e1e13e5a6152d24deb0'
    ]
  );
});

test('monitoring entry carries accepted doc surface hashes into document surfaces', () => {
  const entry = resolveMonitoringEntry({
    id: 'cisa-kev',
    name: 'CISA KEV',
    category: 'cyber',
    format: 'json',
    ttlMinutes: 60
  }, {
    docsUrl: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    acceptedSurfaceHashes: {
      docs: {
        'https://www.cisa.gov/known-exploited-vulnerabilities-catalog': 'abc123'
      }
    }
  }, { defaultRefreshMinutes: 60 });
  const surfaces = collectDocumentSurfaces([entry]);
  assert.deepEqual(surfaces[0].acceptedHashes, ['abc123']);
});

test('document surfaces accept multiple known hashes for nondeterministic docs pages', () => {
  const entry = resolveMonitoringEntry({
    id: 'nws-alerts',
    name: 'NWS Alerts',
    category: 'weather',
    format: 'json',
    ttlMinutes: 60
  }, {
    docsUrl: 'https://www.weather.gov/documentation/services-web-api',
    acceptedSurfaceHashes: {
      docs: {
        'https://www.weather.gov/documentation/services-web-api': ['hash-a', 'hash-b']
      }
    }
  }, { defaultRefreshMinutes: 60 });
  const surfaces = collectDocumentSurfaces([entry]);
  assert.deepEqual(surfaces[0].acceptedHashes, ['hash-a', 'hash-b']);
});

test('feed proxy deploy workflow injects OpenSky credentials', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'deploy-feed-proxy.yml'), 'utf8');
  assert.match(workflow, /OPENSKY_CLIENTID:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTID\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTSECRET\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTID=opensky-clientid:latest/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET=opensky-clientsecret:latest/);
});

test('mcp proxy deploy workflow injects OpenSky credentials', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'deploy-mcp-proxy.yml'), 'utf8');
  assert.match(workflow, /OPENSKY_CLIENTID:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTID\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTSECRET\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTID=opensky-clientid:latest/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET=opensky-clientsecret:latest/);
});

test('pages deploy workflow validates required static build secrets', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
  assert.match(workflow, /Missing required secret: EIA/);
  assert.match(workflow, /Missing required secret: OPENSTATES/);
});

test('doc alerts apply per-feed known upstream quirks', () => {
  const runSource = fs.readFileSync(path.join(process.cwd(), 'analysis', 'monitor', 'lib', 'run.mjs'), 'utf8');
  assert.match(runSource, /applyKnownUpstreamQuirks\(createAlert\(/);
  assert.match(runSource, /const docAlerts = buildDocAlerts\(docResults, entriesById\)/);
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

test('monitoring config quirks downgrade recent Google News and Congress doc noise', () => {
  const monitoring = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed-monitoring.json'), 'utf8'));

  const googleNewsAlert = createAlert({
    feedId: 'google-news-us',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Published live-cache snapshot satisfied the request.'
  });
  const downgradedGoogleNewsAlert = applyKnownUpstreamQuirks(
    googleNewsAlert,
    monitoring['google-news-us'].knownUpstreamQuirks
  );
  assert.equal(downgradedGoogleNewsAlert.severity, 'info');
  assert.equal(downgradedGoogleNewsAlert.suppressNew, true);
  assert.match(downgradedGoogleNewsAlert.message, /live-cache snapshot/i);

  const congressDocsAlert = createAlert({
    feedId: 'congress-api',
    regressionClass: 'docs-fetch-failed',
    severity: 'warning',
    message: 'Failed to fetch Congress API support page.'
  });
  const downgradedCongressDocsAlert = applyKnownUpstreamQuirks(
    congressDocsAlert,
    monitoring['congress-api'].knownUpstreamQuirks
  );
  assert.equal(downgradedCongressDocsAlert.severity, 'info');
  assert.equal(downgradedCongressDocsAlert.suppressNew, true);
  assert.match(downgradedCongressDocsAlert.message, /informational unless the primary api\.congress\.gov docs surface also regresses/i);
});

test('markdown report shows quirk-adjusted severity for changed official surfaces', () => {
  const markdown = buildMarkdownReport({
    mode: 'full',
    generatedAt: '2026-04-18T15:02:10.844Z',
    summary: { checkedFeeds: 91, totalFeeds: 91, critical: 0, warning: 0, info: 1 },
    deltas: { newAlerts: [], resolvedAlerts: [], ongoingAlerts: [] },
    alerts: [
      {
        feedId: 'nws-alerts',
        regressionClass: 'docs-contract-change',
        severity: 'info',
        message: 'Official docs or changelog includes contract-change keywords. https://www.weather.gov/documentation/services-web-api',
        metadata: {
          surfaceKey: 'changelog:https://www.weather.gov/documentation/services-web-api',
          url: 'https://www.weather.gov/documentation/services-web-api'
        }
      }
    ],
    feedResults: [],
    docResults: [
      {
        key: 'changelog:https://www.weather.gov/documentation/services-web-api',
        changed: true,
        surfaceType: 'changelog',
        url: 'https://www.weather.gov/documentation/services-web-api',
        classification: {
          severity: 'critical'
        }
      },
      {
        key: 'docs:https://www.weather.gov/documentation/services-web-api',
        changed: true,
        surfaceType: 'docs',
        url: 'https://www.weather.gov/documentation/services-web-api',
        classification: {
          severity: 'critical'
        }
      }
    ]
  });

  assert.match(markdown, /changelog https:\/\/www\.weather\.gov\/documentation\/services-web-api \(info\)/);
  assert.match(markdown, /docs https:\/\/www\.weather\.gov\/documentation\/services-web-api \(info\)/);
  assert.doesNotMatch(markdown, /changelog https:\/\/www\.weather\.gov\/documentation\/services-web-api \(critical\)/);
  assert.doesNotMatch(markdown, /docs https:\/\/www\.weather\.gov\/documentation\/services-web-api \(critical\)/);
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

test('GovInfo package arrays are summarized as raw items', () => {
  const feed = { id: 'govinfo-api', format: 'json' };
  const summary = summarizeProxyPayload(feed, {
    body: JSON.stringify({
      packages: [
        {
          packageId: 'CMR-1',
          title: 'Mandated report',
          lastModified: '2026-03-16T14:22:40Z'
        }
      ]
    }),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(summary.rawItemCount, 1);
  assert.equal(summary.parseError, null);
  assert.ok(summary.newestTimestamp);
});

test('monitor summaries honor snake_case update timestamps', () => {
  const feed = { id: 'state-legislation', format: 'json' };
  const updatedAt = '2026-04-10T06:13:39.839413+00:00';
  const latestActionDate = '2026-04-01';
  const summary = summarizeProxyPayload(feed, {
    body: JSON.stringify({
      results: [
        {
          title: 'State bill with newer update timestamp',
          updated_at: updatedAt,
          latest_action_date: latestActionDate
        }
      ]
    }),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(summary.newestTimestamp, Date.parse(updatedAt));
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

  const nasaFeed = { id: 'nasa-firms', format: 'json' };
  const nasaEntry = { id: 'nasa-firms', tier: 'core', sampleParams: {} };
  const nasaSummary = summarizeProxyPayload(nasaFeed, {
    body: JSON.stringify({
      items: [
        {
          title: 'Fire detection',
          geo: { lat: 34.1, lon: -118.2 },
          publishedAt: '2026-03-15T12:00:00Z'
        }
      ]
    }),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('geo-coordinates', buildContext(nasaEntry, nasaSummary, {
    error: null,
    count: 1,
    items: [{ geo: { lat: 34.1, lon: -118.2 }, publishedAt: '2026-03-15T12:00:00Z' }],
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  })), null);

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
