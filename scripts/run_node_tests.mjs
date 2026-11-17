import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function listNodeTests(cwd = process.cwd()) {
  return globSync(['scripts/test/**/*.spec.mjs', 'gcp/state-connector/test/**/*.spec.mjs'], {
    cwd,
    exclude: ['**/fixtures/**', '**/node_modules/**', '**/ui.spec.mjs', '**/*.ui.spec.mjs']
  }).sort();
}

export function runNodeTests({ cwd = process.cwd(), args = [], stdio = 'inherit' } = {}) {
  const tests = listNodeTests(cwd);
  if (!tests.length) throw new Error('No offline Node tests found; refusing an empty successful run.');
  // Keep Node's default worker limit and per-file process isolation.
  return spawnSync(process.execPath, ['--test', ...args, ...tests], { cwd, stdio });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tests = listNodeTests();
  if (!tests.length) throw new Error('No offline Node tests found; run from the repository root.');
  if (process.argv.length === 3 && process.argv[2] === '--list') {
    console.log(JSON.stringify(tests, null, 2));
  } else {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/run_node_tests.mjs [--list]');
    // Keep Node's per-file process isolation. Unknown dependencies always get the full suite.
    const result = runNodeTests();
    if (result.error) throw result.error;
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exit(result.status ?? 1);
  }
}
