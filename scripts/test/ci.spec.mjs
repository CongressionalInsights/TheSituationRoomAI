import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listNodeTests } from '../run_node_tests.mjs';

test('offline discovery includes nested and new Node specs, excludes browser/fixture files, and reports test failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-ci-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = ['gcp/state-connector/test/adapters.spec.mjs', 'scripts/test/new-owner/nested.spec.mjs'];
  for (const file of [...expected, 'scripts/test/ui.spec.mjs', 'scripts/test/money-flows.ui.spec.mjs',
    'scripts/test/fixtures/recorded.spec.mjs', 'scripts/test/fixture-helper.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'throw new Error("deliberate inventory fixture");');
  }
  assert.deepEqual(listNodeTests(root), expected);
  const runner = path.resolve('scripts/run_node_tests.mjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // The CLI fixture starts a separate test runner.
  const failed = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /deliberate inventory fixture/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-ci-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const missing = spawnSync(process.execPath, [runner], { cwd: empty, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No offline Node tests found/);
});

test('each offline spec owns its tests without importing another spec for side effects', () => {
  for (const file of listNodeTests()) {
    const imports = fs.readFileSync(file, 'utf8').split('\n')
      .filter(line => /^import\s/.test(line));
    assert.ok(imports.every(line => !/['"][^'"]+\.spec\.mjs['"]/.test(line)), file);
  }
});

test('required preflight runs the full suite and only cancels superseded PR validation', () => {
  const workflow = fs.readFileSync('.github/workflows/deploy-mcp-proxy.yml', 'utf8');
  const [preflight, deploy] = workflow.split('\n  deploy:');
  assert.match(preflight, /pull_request:\n\s+branches: \[main\]/);
  assert.match(preflight, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(preflight, /paths(?:-ignore)?:/);
  assert.match(preflight, /\n  preflight:\n/);
  assert.match(preflight, /group: mcp-preflight-\$\{\{ github.event_name \}\}-\$\{\{ github.event.pull_request.number \|\| github.run_id \}\}/);
  assert.match(preflight, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  for (const command of ['npm ci --prefix gcp/mcp-proxy', 'npm ci --prefix gcp/state-connector', '/usr/bin/time -v npm test']) {
    assert.ok(preflight.includes(`run: ${command}\n`), command);
  }
  assert.match(deploy, /needs: preflight/);
  assert.match(deploy, /group: deploy-mcp-proxy\n\s+cancel-in-progress: false/);
  assert.equal(JSON.parse(fs.readFileSync('package.json')).scripts.test,
    'node scripts/verify_feeds_sync.mjs && node scripts/run_node_tests.mjs');
});
