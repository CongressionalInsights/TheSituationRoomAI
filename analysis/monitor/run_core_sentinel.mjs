import { parseCliArgs } from './lib/client.mjs';
import { runMonitor } from './lib/run.mjs';

const argv = process.argv.slice(2);
const options = parseCliArgs(argv);
const report = await runMonitor('core', argv);
console.log(JSON.stringify({
  mode: report.mode,
  generatedAt: report.generatedAt,
  notify: report.notify,
  summary: report.summary,
  newAlerts: report.deltas.newAlerts.length,
  resolvedAlerts: report.deltas.resolvedAlerts.length
}, null, 2));

if (!options.allowAlerts && report.summary.critical > 0) {
  process.exitCode = 1;
}
