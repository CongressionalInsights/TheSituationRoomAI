import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspectTypedSeriesSignals, summarizeProxyPayload } from '../analysis/monitor/lib/audit.mjs';
import feedCatalog from '../data/feeds.json' with { type: 'json' };

const SOURCE_IDS = ['energy-eia', 'energy-eia-brent', 'energy-eia-ng', 'bls-cpi'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function checkTransport(summary, sourceId, label) {
  if (!summary || summary.error || summary.parseError || (summary.httpStatus != null && summary.httpStatus !== 200)) {
    fail('typed_transport_failed', `${sourceId}: ${label} is absent or failed`);
  }
  if (summary.fallbackUsed !== false || summary.stale || summary.fallback
    || summary.proxyUsed === 'live-cache' || /\/data\/feeds\//.test(summary.fetchedUrl || '')) {
    fail('typed_fallback_hold', `${sourceId}: ${label} is stale or fallback data; release proof is held`);
  }
}

export function verifyTypedSeriesReport(report, expectedEndpoint) {
  let endpoint;
  try { endpoint = new URL(expectedEndpoint); } catch {}
  if (!endpoint || !['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/mcp') || report?.mcp !== expectedEndpoint) {
    fail('typed_endpoint_mismatch', 'Report must name the exact candidate MCP endpoint without credentials, query or fragment');
  }
  if (!Array.isArray(report.feedResults)) fail('typed_results_missing', 'Report has no feed results');
  const sources = SOURCE_IDS.map((sourceId) => {
    const matches = report.feedResults.filter((result) => result?.feedId === sourceId);
    if (matches.length !== 1) fail('typed_result_cardinality', `${sourceId}: require exactly one feed result`);
    const result = matches[0];
    checkTransport(result.raw, sourceId, 'raw');
    checkTransport(result.signals, sourceId, 'signals');
    const entry = feedCatalog.feeds.find((feed) => feed.id === sourceId);
    const raw = summarizeProxyPayload(entry, { body: result.raw.parsedBody, httpStatus: result.raw.httpStatus });
    if (result.raw.httpStatus !== 200 || raw.parseError || !raw.rawItemCount || raw.rawItemCount !== result.raw.rawItemCount
      || raw.sampleItems.some((item) => !item.seriesId || !item.period)) {
      fail('typed_raw_malformed', `${sourceId}: raw observations are empty or inconsistent`);
    }
    if (!Array.isArray(result.signals.items) || !result.signals.items.length
      || result.signals.count !== result.signals.items.length) {
      fail('typed_list_malformed', `${sourceId}: normalized observations are empty or inconsistent`);
    }
    if (result.signals.count < Math.min(25, raw.rawItemCount)) {
      fail('typed_list_coverage_hold', `${sourceId}: list coverage is below the core audit limit; cardinality drift or truncation holds release`);
    }
    const inspection = inspectTypedSeriesSignals(entry, result.signals, raw);
    if (inspection.invalidCount || inspection.fabricatedCount) {
      fail('typed_semantic_corruption', `${sourceId}: normalized identity, type or source-date contract failed`);
    }
    if (!inspection.comparison.matchedCount) {
      fail('typed_comparison_coverage_hold', `${sourceId}: no compatible raw observation key; independent-snapshot coverage holds release`);
    }
    if (inspection.comparison.availabilityLossCount
      || (inspection.comparison.rawAvailableCount && !inspection.comparison.availableCount)) {
      fail('typed_availability_comparison_hold', `${sourceId}: numeric availability is reduced relative to raw evidence; an independent availability transition or normalization loss holds release`);
    }
    const alerts = [...(result.alerts || []), ...(report.alerts || []).filter((alert) => alert?.feedId === sourceId)];
    if (alerts.some((alert) => /^signal-normalization/.test(alert.regressionClass || '')
      || alert.regressionClass === 'observation-freshness-fabricated')) {
      fail('typed_semantic_alert', `${sourceId}: report retains a semantic normalization or fabricated-freshness error`);
    }
    return { sourceId, rawItemCount: raw.rawItemCount, signalCount: result.signals.count,
      newestObservationTimestamp: inspection.newestTimestamp, comparison: inspection.comparison,
      observationAgeWarnings: alerts.filter((alert) => alert.regressionClass === 'freshness-window-exceeded') };
  });
  return { ok: true, endpoint: expectedEndpoint, providerCalls: 0, sources,
    qualification: 'Raw and list are independent acquisitions. This gate checks representation, compatible-key metadata and numeric availability coverage, not exact cross-acquisition numeric equality or release lateness. Availability or cardinality transitions can hold release without proving mapper corruption.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, expectedEndpoint] = process.argv.slice(2);
  if (!reportPath || !expectedEndpoint) throw new Error('Usage: verify_typed_series_report.mjs <report.json> <exact-candidate-mcp-endpoint>');
  console.log(JSON.stringify(verifyTypedSeriesReport(JSON.parse(fs.readFileSync(reportPath, 'utf8')), expectedEndpoint), null, 2));
}
