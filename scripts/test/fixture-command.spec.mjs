import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureCommand } from './fixtures/command-server.mjs';

test('fixture commands preserve argv, live shell exports, output streams and exact exit status', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-command-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gcloud');
  await fixtureCommand(t, file, function () {
    console.log(JSON.stringify({ args: process.argv.slice(2), flag: process.env.FIXTURE_FLAG,
      optionalPresent: Object.hasOwn(process.env, 'TSR_UNSET_FIXTURE_FLAG'), optional: process.env.TSR_UNSET_FIXTURE_FLAG }));
    console.error('fixture stderr');
    process.exitCode = Number(process.env.FIXTURE_STATUS);
  }, ['FIXTURE_FLAG', 'FIXTURE_STATUS', 'TSR_UNSET_FIXTURE_FLAG']);
  const args = ['', 'two words', "quote'\"\\", 'line\nbreak', 'café'];
  for (const status of [0, 9, 255]) {
    const env = { ...process.env, FIXTURE_STATUS: String(status), HTTP_PROXY: 'http://127.0.0.1:1' };
    delete env.TSR_UNSET_FIXTURE_FLAG;
    if (status === 255) env.TSR_UNSET_FIXTURE_FLAG = '';
    const result = spawnSync('/bin/sh', ['-c', 'export FIXTURE_FLAG="changed by shell"; exec "$@"', 'fixture', file, ...args], {
      encoding: 'utf8', env
    });
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, flag: 'changed by shell', optionalPresent: status === 255,
      ...(status === 255 ? { optional: '' } : {}) });
    assert.equal(result.stderr, 'fixture stderr\n');
    assert.ok(result.stdout.endsWith('\n'));
  }
});

test('fixture commands reset exit state, preserve explicit exit and reject thrown commands', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-command-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gcloud');
  await fixtureCommand(t, file, function () {
    if (process.argv[2] === 'throw') throw Error('unadmitted fake command');
    if (process.argv[2] === 'exit') process.exit(7);
    console.log('fresh success');
  });
  const failed = spawnSync(file, ['throw'], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /unadmitted fake command/);
  assert.equal(spawnSync(file, ['exit']).status, 7);
  assert.equal(spawnSync(file).status, 0);
});

test('fixture commands fail closed when their private server stops', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-command-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gcloud');
  const { worker } = await fixtureCommand(t, file, function () { console.log('inert success'); });
  await worker.terminate();
  const result = spawnSync(file, [], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('fixture socket transport works with a valid long TMPDIR', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-command-long-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const long = path.join(dir, 'long-temporary-directory-'.repeat(6));
  fs.mkdirSync(long);
  assert.ok(Buffer.byteLength(long) > 121);
  const file = path.join(long, 'gcloud');
  const script = `
    import { fixtureCommand } from ${JSON.stringify(new URL('./fixtures/command-server.mjs', import.meta.url).href)};
    import { spawnSync } from 'node:child_process';
    let cleanup;
    try {
      await fixtureCommand({ after(fn) { cleanup = fn; } }, process.argv[2], function () { console.log('long TMPDIR success'); });
      const result = spawnSync(process.argv[2], [], { encoding: 'utf8' });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
    } finally { if (cleanup) await cleanup(); }
  `;
  const env = { ...process.env, TMPDIR: long };
  delete env.NODE_TEST_CONTEXT;
  const child = path.join(long, 'run-fixture.mjs');
  fs.writeFileSync(child, script);
  const result = spawnSync(process.execPath, [child, file], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'long TMPDIR success\n');
});
