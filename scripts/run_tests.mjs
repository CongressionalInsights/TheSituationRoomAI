import { listNodeTests, runNodeTests } from './run_node_tests.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function listOfflineTests(cwd = repoRoot) {
  // Compatibility entrypoint; main's runner owns discovery and execution.
  return listNodeTests(cwd);
}

export function runOfflineTests({ cwd = repoRoot, args = [], stdio = 'inherit' } = {}) {
  return runNodeTests({ cwd, args, stdio });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runOfflineTests({ args: process.argv.slice(2) });
  if (result.error) throw result.error;
  if (result.signal) console.error(`Offline tests terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}
