import path from 'node:path';
import { loadMonitoringCatalog } from './lib/catalog.mjs';
import { parseCliArgs, ensureDir, readJson, writeJson } from './lib/client.mjs';
import { watchDocumentation } from './lib/doc_watch.mjs';

const options = parseCliArgs(process.argv.slice(2));
const catalog = loadMonitoringCatalog();
const latestPath = path.join(options.outputDir, 'latest.json');
const previous = readJson(latestPath, null);
const previousDocs = Object.fromEntries((previous?.docResults || []).map((result) => [result.key, result]));
const docResults = await watchDocumentation({
  entries: catalog.entries,
  previousDocs,
  timeoutMs: options.timeoutMs
});

ensureDir(options.outputDir);
const outputPath = path.join(options.outputDir, 'doc-watch.json');
writeJson(outputPath, {
  generatedAt: new Date().toISOString(),
  count: docResults.length,
  changed: docResults.filter((result) => result.changed).length,
  docResults
});

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  outputPath,
  checkedSurfaces: docResults.length,
  changedSurfaces: docResults.filter((result) => result.changed).length
}, null, 2));
