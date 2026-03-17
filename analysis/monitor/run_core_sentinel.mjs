import { runMonitor } from './lib/run.mjs';

const report = await runMonitor('core', process.argv.slice(2));
console.log(JSON.stringify({
  mode: report.mode,
  generatedAt: report.generatedAt,
  notify: report.notify,
  summary: report.summary,
  newAlerts: report.deltas.newAlerts.length,
  resolvedAlerts: report.deltas.resolvedAlerts.length
}, null, 2));

if (report.summary.critical > 0) {
  process.exitCode = 1;
}
