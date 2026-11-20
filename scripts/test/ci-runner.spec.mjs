import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { listOfflineTests, runOfflineTests } from '../run_tests.mjs';
import { nodeTestConcurrency } from '../run_node_tests.mjs';

test('offline workers retain the hosted default and cap larger machines', () => {
  assert.equal(nodeTestConcurrency(1), 1);
  assert.equal(nodeTestConcurrency(4), 3);
  assert.equal(nodeTestConcurrency(32), 4);
});

test('offline discovery includes new/nested and connector specs but never browser specs or helpers', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-ci-inventory-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const expected = ['scripts/test/new.spec.mjs', 'scripts/test/nested/changed.spec.mjs', 'gcp/state-connector/test/adapters.spec.mjs'].sort();
  for (const file of [...expected, 'scripts/test/ui.spec.mjs', 'scripts/test/nested/panel.ui.spec.mjs', 'scripts/test/helpers/fixture.mjs']) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), '');
  }
  assert.deepEqual(listOfflineTests(cwd), expected);
});

test('offline command refuses empty inventories and propagates a real failed test', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-ci-failure-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.throws(() => runOfflineTests({ cwd, stdio: 'pipe' }), /refusing an empty/);
  fs.mkdirSync(path.join(cwd, 'scripts/test'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts/test/broken.spec.mjs'), "import test from 'node:test'; test('broken contract', () => { throw Error('fixture regression'); });");
  // Start an independent runner: Node marks processes launched from a test
  // worker with NODE_TEST_CONTEXT and suppresses recursive --test runs.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const script = `import { runOfflineTests } from ${JSON.stringify(new URL('../run_tests.mjs', import.meta.url).href)};
    process.exitCode = runOfflineTests({ cwd: process.argv[1] }).status ?? 1;`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, cwd], { env });
  assert.equal(result.status, 1);
  assert.match(result.stdout.toString(), /broken contract/);
});

test('offline specs cannot import another spec and repeat its cases', () => {
  for (const file of listOfflineTests()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /^import\b[^;]*?['"][^'"]+\.spec\.mjs['"]/gm, file);
  }
});

test('CI supersedes only the same PR preflight and keeps manual/push runs independent', () => {
  const workflow = fs.readFileSync('.github/workflows/deploy-mcp-proxy.yml', 'utf8');
  const header = workflow.split('\njobs:')[0];
  assert.match(header, /\n  pull_request:\n    branches: \[main\]/);
  assert.doesNotMatch(header, /^concurrency:|\n    paths(?:-ignore)?:/m);
  const preflight = workflow.split('\n  preflight:')[1].split('\n  deploy:')[0];
  const group = preflight.match(/\n      group: (.+)/)[1];
  const cancel = preflight.match(/\n      cancel-in-progress: \$\{\{ (.+) \}\}/)[1];
  const evaluate = (event_name, number, run_id) => {
    const github = { event_name, event: { pull_request: { number } }, run_id };
    return {
      group: group.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => vm.runInNewContext(expression, { github })),
      cancel: vm.runInNewContext(cancel, { github })
    };
  };
  const pr = evaluate('pull_request', 123, 1);
  assert.equal(pr.cancel, true);
  assert.equal(pr.group, evaluate('pull_request', 123, 2).group);
  assert.notEqual(pr.group, evaluate('pull_request', 456, 2).group);
  for (const event of ['push', 'workflow_dispatch', 'schedule']) {
    const first = evaluate(event, null, 1);
    assert.equal(first.cancel, false);
    assert.notEqual(first.group, evaluate(event, null, 2).group);
    assert.notEqual(first.group, pr.group);
  }
});
