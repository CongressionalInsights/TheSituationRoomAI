import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listOfflineTests, runOfflineTests } from '../run_tests.mjs';

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
