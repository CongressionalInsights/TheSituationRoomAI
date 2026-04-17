import path from 'node:path';
import { loadMonitoringCatalog } from './catalog.mjs';
import { parseCliArgs, readJson, writeJson, writeText, ensureDir } from './client.mjs';
import { watchDocumentation } from './doc_watch.mjs';
import { runFeedAudit } from './audit.mjs';
import {
  applyKnownUpstreamQuirks,
  buildMarkdownReport,
  createAlert,
  dedupeAlerts,
  diffAlerts,
  summarizeAlerts
} from './reporting.mjs';

function toHistoryStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildDocAlerts(docResults = [], entriesById = new Map()) {
  return docResults
    .filter((result) => result.classification)
    .map((result) => {
      const feedId = result.representativeFeedId || 'docs';
      const entry = entriesById.get(feedId);
      return applyKnownUpstreamQuirks(createAlert({
        feedId,
        regressionClass: result.classification.regressionClass,
        severity: result.classification.severity,
        message: `${result.classification.message} ${result.url}`,
        docsHash: result.hash || null,
        metadata: {
          identity: result.key,
          url: result.url,
          surfaceKey: result.key,
          surfaceType: result.surfaceType,
          affectedFeedIds: result.feedIds
        }
      }), entry?.knownUpstreamQuirks || []);
    });
}

export async function runMonitor(mode, argv = []) {
  const cli = parseCliArgs(argv);
  const catalog = loadMonitoringCatalog();
  const auditableEntries = catalog.entries.filter((entry) => entry.auditEnabled !== false);
  const entries = mode === 'core'
    ? auditableEntries.filter((entry) => entry.tier === 'core')
    : auditableEntries;

  ensureDir(cli.outputDir);
  const latestPath = path.join(cli.outputDir, 'latest.json');
  const latestMarkdownPath = path.join(cli.outputDir, 'latest.md');
  const historyDir = path.join(cli.outputDir, 'history');
  ensureDir(historyDir);

  const previousReport = readJson(latestPath, null);
  const previousDocs = Object.fromEntries((previousReport?.docResults || []).map((result) => [result.key, result]));

  const feedResults = await runFeedAudit(entries, cli);
  const docResults = cli.includeDocs
    ? await watchDocumentation({ entries, previousDocs, timeoutMs: cli.timeoutMs })
    : [];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  const feedAlerts = feedResults.flatMap((result) => result.alerts);
  const docAlerts = buildDocAlerts(docResults, entriesById);
  const alerts = dedupeAlerts([...feedAlerts, ...docAlerts]);
  const deltas = diffAlerts(alerts, previousReport?.alerts || []);
  const summary = summarizeAlerts(alerts);

  const report = {
    mode,
    generatedAt: new Date().toISOString(),
    base: cli.base,
    mcp: cli.mcp,
    staticBase: cli.includeStatic ? cli.staticBase : null,
    notify: deltas.newAlerts.length > 0 || deltas.resolvedAlerts.length > 0,
    summary: {
      ...summary,
      totalFeeds: auditableEntries.length,
      checkedFeeds: entries.length,
      checkedDocSurfaces: docResults.length
    },
    deltas,
    alerts,
    feedResults,
    docResults
  };

  if (cli.writeLatest) {
    writeJson(latestPath, report);
    writeText(latestMarkdownPath, buildMarkdownReport(report));
    const historyPath = path.join(historyDir, `${toHistoryStamp()}.${mode}.json`);
    writeJson(historyPath, report);
  }

  return report;
}
