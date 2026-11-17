import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function listOfflineTests(cwd = repoRoot) {
  // These are the two offline suite roots. Browser specs remain in Playwright;
  // this matches playwright.config.mjs's /ui\.spec\.mjs$/ boundary.
  return globSync(['scripts/test/**/*.spec.mjs', 'gcp/state-connector/test/**/*.spec.mjs'], {
    cwd, exclude: ['**/*ui.spec.mjs']
  }).sort();
}

export function runOfflineTests({ cwd = repoRoot, args = [], stdio = 'inherit' } = {}) {
  const files = listOfflineTests(cwd);
  if (!files.length) throw new Error('No offline test files found; refusing an empty successful run.');
  // Keep Node's default per-file process isolation. Cap file workers to fit the
  // existing four-CPU public runner, and respect smaller local CPU allocations.
  const concurrency = Math.min(4, availableParallelism());
  return spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...args, ...files], { cwd, stdio });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runOfflineTests({ args: process.argv.slice(2) });
  if (result.error) throw result.error;
  if (result.signal) console.error(`Offline tests terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}
