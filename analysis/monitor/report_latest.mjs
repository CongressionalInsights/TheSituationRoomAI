import path from 'node:path';
import { buildMarkdownReport } from './lib/reporting.mjs';
import { parseCliArgs, readJson, writeText } from './lib/client.mjs';

const options = parseCliArgs(process.argv.slice(2));
const latestPath = path.join(options.outputDir, 'latest.json');
const latestMarkdownPath = path.join(options.outputDir, 'latest.md');
const report = readJson(latestPath, null);

if (!report) {
  console.error(`No report found at ${latestPath}`);
  process.exit(1);
}

writeText(latestMarkdownPath, buildMarkdownReport(report));
console.log(JSON.stringify({
  latestPath,
  latestMarkdownPath
}, null, 2));
