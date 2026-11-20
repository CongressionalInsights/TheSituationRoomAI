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
