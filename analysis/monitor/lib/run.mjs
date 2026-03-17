import path from 'node:path';
import { loadMonitoringCatalog } from './catalog.mjs';
import { parseCliArgs, readJson, writeJson, writeText, ensureDir } from './client.mjs';
import { watchDocumentation } from './doc_watch.mjs';
import { runFeedAudit } from './audit.mjs';
import {
  buildMarkdownReport,
  createAlert,
  dedupeAlerts,
  diffAlerts,
  summarizeAlerts
} from './reporting.mjs';

function toHistoryStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildDocAlerts(docResults = []) {
  return docResults
    .filter((result) => result.classification)
    .map((result) => createAlert({
      feedId: result.representativeFeedId || 'docs',
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
    }));
}

export async function runMonitor(mode, argv = []) {
  const cli = parseCliArgs(argv);
  const catalog = loadMonitoringCatalog();
  const entries = mode === 'core'
    ? catalog.entries.filter((entry) => entry.tier === 'core')
    : catalog.entries;

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

  const feedAlerts = feedResults.flatMap((result) => result.alerts);
  const docAlerts = buildDocAlerts(docResults);
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
      totalFeeds: catalog.entries.length,
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
