import { parseCliArgs } from './lib/client.mjs';
import { runMonitor, shouldFailMonitorRun } from './lib/run.mjs';

const argv = process.argv.slice(2);
const options = parseCliArgs(argv);
const report = await runMonitor('core', argv);
console.log(JSON.stringify({
  mode: report.mode,
  generatedAt: report.generatedAt,
  notify: report.notify,
  superseded: Boolean(report.semanticSuperseded ?? report.superseded),
  supersededBy: report.supersededBy || null,
  semanticSuperseded: Boolean(report.semanticSuperseded ?? report.superseded),
  semanticSupersededBy: report.semanticSupersededBy || report.supersededBy || null,
  publicationSuperseded: Boolean(report.publicationSuperseded),
  publicationSupersededBy: report.publicationSupersededBy || null,
  summary: report.summary,
  newAlerts: report.deltas.newAlerts.length,
  resolvedAlerts: report.deltas.resolvedAlerts.length
}, null, 2));

if (shouldFailMonitorRun(report, options)) {
  process.exitCode = 1;
}
