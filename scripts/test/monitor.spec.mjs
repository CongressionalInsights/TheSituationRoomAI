import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  buildMonitorBaseline,
  buildMonitorBaselineScope,
  defaultMonitorBaselineDir,
  loadMonitorBaseline,
  MONITOR_PENDING_PUBLICATION_SCHEMA_VERSION,
  MONITOR_PUBLICATION_SCHEMA_VERSION,
  monitorBaselinePath,
  monitorPublicationHeadPath,
  monitorPublicationJournalPath,
  monitorPublicationLockPath,
  recoverMonitorPublicationJournal,
  recoverMonitorPublications,
  withMonitorPublicationLock,
  writeMonitorBaselineAtomic
} from '../../analysis/monitor/lib/baseline.mjs';
import {
  buildDefaultSampleParams,
  resolveMonitoringEntry
} from '../../analysis/monitor/lib/catalog.mjs';
import {
  callMcpTool,
  fetchText,
  hashContent,
  parseCliArgs,
  sanitizeObservedUrl
} from '../../analysis/monitor/lib/client.mjs';
import {
  normalizeDocText,
  extractDatedEntries,
  classifyDocChange,
  collectDocumentSurfaces
} from '../../analysis/monitor/lib/doc_watch.mjs';
import {
  compareStaticSnapshot,
  getRawFetchFormat,
  summarizeProxyPayload,
  evaluateInvariant
} from '../../analysis/monitor/lib/audit.mjs';
import {
  buildMarkdownReport,
  createAlert,
  applyKnownUpstreamQuirks,
  dedupeAlerts,
  diffAlerts
} from '../../analysis/monitor/lib/reporting.mjs';
import {
  applyMonitorWriteDisposition,
  shouldFailMonitorRun
} from '../../analysis/monitor/lib/run.mjs';

const fixture = (name) => fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'fixtures', 'monitor', name), 'utf8');
const parseFixture = (name) => JSON.parse(fixture(name));
const baselineModuleUrl = new URL('../../analysis/monitor/lib/baseline.mjs', import.meta.url).href;

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const lockWorkerSource = String.raw`
import fs from 'node:fs';

const [
  moduleUrl,
  lockPath,
  releasePath,
  insidePath,
  logPath,
  holdMsRaw,
  timeoutMsRaw,
  staleLockMsRaw
] = process.argv.slice(1);
const { withMonitorPublicationLock } = await import(moduleUrl);
const waitArray = new Int32Array(new SharedArrayBuffer(4));

try {
  withMonitorPublicationLock(lockPath, () => {
    if (insidePath !== '-') {
      fs.writeFileSync(insidePath, String(process.pid), { flag: 'wx' });
    }
    if (logPath !== '-') fs.appendFileSync(logPath, 'enter ' + process.pid + '\n');
    process.stdout.write('entered ' + process.pid + '\n');
    if (releasePath === '-') {
      Atomics.wait(waitArray, 0, 0, Number(holdMsRaw));
    } else {
      while (!fs.existsSync(releasePath)) Atomics.wait(waitArray, 0, 0, 10);
    }
    if (logPath !== '-') fs.appendFileSync(logPath, 'exit ' + process.pid + '\n');
    if (insidePath !== '-') fs.unlinkSync(insidePath);
  }, {
    timeoutMs: Number(timeoutMsRaw),
    staleLockMs: Number(staleLockMsRaw)
  });
  process.stdout.write('released ' + process.pid + '\n');
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 2;
}
`;

const delayedReclaimerSource = String.raw`
import fs from 'node:fs';

const [moduleUrl, lockPath, observedPath, resumePath, insidePath, logPath] = process.argv.slice(1);
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const renameSync = fs.renameSync;
let delayed = false;
fs.renameSync = (source, destination) => {
  if (!delayed && source === lockPath && destination.includes('.retired-')) {
    delayed = true;
    fs.writeFileSync(observedPath, String(process.pid), { flag: 'wx' });
    process.stdout.write('observed ' + process.pid + '\n');
    while (!fs.existsSync(resumePath)) Atomics.wait(waitArray, 0, 0, 10);
  }
  return renameSync(source, destination);
};

const { withMonitorPublicationLock } = await import(moduleUrl);
try {
  withMonitorPublicationLock(lockPath, () => {
    fs.writeFileSync(insidePath, String(process.pid), { flag: 'wx' });
    fs.appendFileSync(logPath, 'enter ' + process.pid + '\n');
    process.stdout.write('entered ' + process.pid + '\n');
    Atomics.wait(waitArray, 0, 0, 25);
    fs.appendFileSync(logPath, 'exit ' + process.pid + '\n');
    fs.unlinkSync(insidePath);
  }, { timeoutMs: 3000, staleLockMs: 60000 });
  process.stdout.write('released ' + process.pid + '\n');
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 2;
}
`;

function spawnLockWorker({
  lockPath,
  releasePath = '-',
  insidePath = '-',
  logPath = '-',
  holdMs = 25,
  timeoutMs = 3000,
  staleLockMs = 60000
}) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    lockWorkerSource,
    baselineModuleUrl,
    lockPath,
    releasePath,
    insidePath,
    logPath,
    String(holdMs),
    String(timeoutMs),
    String(staleLockMs)
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let enteredSettled = false;
  let resolveEntered;
  let rejectEntered;
  const entered = new Promise((resolve, reject) => {
    resolveEntered = resolve;
    rejectEntered = reject;
  });
  entered.catch(() => {});
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!enteredSettled && stdout.includes('entered ')) {
      enteredSettled = true;
      resolveEntered(stdout);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!enteredSettled) {
        enteredSettled = true;
        rejectEntered(new Error(`Lock worker exited before acquiring: ${stderr || stdout}`));
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Lock worker exited ${code ?? signal}: ${stderr || stdout}`));
      }
    });
  });
  return { child, entered, completed, output: () => ({ stdout, stderr }) };
}

function spawnDelayedReclaimer({ lockPath, observedPath, resumePath, insidePath, logPath }) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    delayedReclaimerSource,
    baselineModuleUrl,
    lockPath,
    observedPath,
    resumePath,
    insidePath,
    logPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let resolveObserved;
  let rejectObserved;
  let resolveEntered;
  let rejectEntered;
  const observed = new Promise((resolve, reject) => {
    resolveObserved = resolve;
    rejectObserved = reject;
  });
  const entered = new Promise((resolve, reject) => {
    resolveEntered = resolve;
    rejectEntered = reject;
  });
  observed.catch(() => {});
  entered.catch(() => {});
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('observed ')) resolveObserved(stdout);
    if (stdout.includes('entered ')) resolveEntered(stdout);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      rejectObserved(error);
      rejectEntered(error);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Delayed reclaimer exited ${code ?? signal}: ${stderr || stdout}`);
        rejectObserved(error);
        rejectEntered(error);
        reject(error);
      }
    });
  });
  return { child, observed, entered, completed, output: () => ({ stdout, stderr }) };
}

function lockOwnerPath(lockPath) {
  return path.join(lockPath, 'owner.json');
}

function readLockOwner(lockPath) {
  return JSON.parse(fs.readFileSync(lockOwnerPath(lockPath), 'utf8'));
}

function writeLockOwner(lockPath, owner) {
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockOwnerPath(lockPath), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
}

function retiredLockPath(lockPath, token) {
  return `${lockPath}.retired-${token}`;
}

function nonLockStateEntries(directory) {
  return fs.readdirSync(directory).filter((name) => !name.includes('.lock.'));
}

function buildContext(entry, proxySummary, signalSummary = { error: null, items: [], count: 0, newestTimestamp: null }) {
  return {
    entry,
    proxySummary,
    rawSummary: proxySummary,
    signalSummary
  };
}

function snapshotRecord(raw) {
  if (raw === null) {
    return { previousBase64: null, previousSha256: null };
  }
  const buffer = Buffer.from(raw);
  return {
    previousBase64: buffer.toString('base64'),
    previousSha256: hashContent(buffer.toString('utf8'))
  };
}

function rollbackRecord(raw, outputDir, stagedPath) {
  if (raw === null) {
    return { rollback: null, previousSha256: null };
  }
  const rollbackPath = `${stagedPath}.rollback`;
  fs.writeFileSync(rollbackPath, raw);
  return {
    rollback: path.relative(outputDir, rollbackPath),
    previousSha256: hashContent(raw)
  };
}

function writePendingMonitorPublication({
  baselineDir,
  outputDir,
  mode,
  scopeId,
  state = 'pending',
  publication,
  baselineRaw,
  previousBaselineRaw,
  artifacts
}) {
  const journalPath = monitorPublicationJournalPath(mode, baselineDir, scopeId);
  const stages = {};
  for (const [key, artifact] of Object.entries(artifacts)) {
    const targetPath = path.join(outputDir, artifact.target);
    const stagedPath = `${targetPath}.fixture.stage`;
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.writeFileSync(stagedPath, artifact.raw);
    stages[key] = {
      target: artifact.target,
      staged: path.relative(outputDir, stagedPath),
      sha256: hashContent(artifact.raw),
      ...rollbackRecord(artifact.previousRaw ?? null, outputDir, stagedPath)
    };
  }
  const publicationRaw = JSON.stringify(publication, null, 2);
  const markerPath = path.join(outputDir, 'latest-commit.json');
  const headPath = monitorPublicationHeadPath(baselineDir);
  const markerRaw = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : null;
  const headRaw = fs.existsSync(headPath) ? fs.readFileSync(headPath, 'utf8') : null;
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify({
    schemaVersion: MONITOR_PENDING_PUBLICATION_SCHEMA_VERSION,
    state,
    mode,
    scopeId,
    outputDir,
    publication,
    baseline: {
      path: `${mode}.${scopeId}.json`,
      sha256: hashContent(baselineRaw),
      newBase64: Buffer.from(baselineRaw).toString('base64'),
      ...snapshotRecord(previousBaselineRaw)
    },
    stages,
    marker: {
      target: 'latest-commit.json',
      sha256: hashContent(publicationRaw),
      ...snapshotRecord(markerRaw)
    },
    head: {
      path: path.basename(headPath),
      sha256: hashContent(publicationRaw),
      ...snapshotRecord(headRaw)
    }
  }, null, 2));
  return { journalPath, stages };
}

test('CLI can allow alerts without failing workflow runs', () => {
  assert.equal(parseCliArgs([]).allowAlerts, false);
  assert.equal(parseCliArgs(['--allow-alerts']).allowAlerts, true);
  assert.equal(parseCliArgs([]).allowLegacyBaseline, false);
  assert.equal(parseCliArgs(['--allow-legacy-baseline']).allowLegacyBaseline, true);
  assert.equal(parseCliArgs(['--scope-tag', 'tenant-alpha']).scopeTag, 'tenant-alpha');
});

test('only semantic supersession suppresses critical monitor exit status', () => {
  const criticalReport = {
    summary: { critical: 1 },
    semanticSuperseded: false
  };
  assert.equal(shouldFailMonitorRun(criticalReport), true);
  assert.equal(shouldFailMonitorRun(criticalReport, { allowAlerts: true }), false);
  assert.equal(shouldFailMonitorRun({ ...criticalReport, semanticSuperseded: true }), false);
  assert.equal(shouldFailMonitorRun({ ...criticalReport, publicationSuperseded: true }), true);
  assert.equal(shouldFailMonitorRun({ summary: { critical: 1 }, superseded: true }), false);
});

test('monitor baseline location has a durable host default and explicit CLI override', () => {
  assert.equal(
    defaultMonitorBaselineDir({ env: {}, homeDir: '/home/example' }),
    path.join('/home/example', '.local', 'state', 'the-situation-room-ai', 'monitor')
  );
  assert.equal(
    defaultMonitorBaselineDir({ env: { XDG_STATE_HOME: '/state' }, homeDir: '/ignored' }),
    path.join('/state', 'the-situation-room-ai', 'monitor')
  );
  assert.equal(
    defaultMonitorBaselineDir({ env: { SR_MONITOR_BASELINE_DIR: '/custom/state' }, homeDir: '/ignored' }),
    '/custom/state'
  );
  assert.equal(parseCliArgs(['--baseline-dir', '/tmp/monitor-state']).baselineDir, '/tmp/monitor-state');
});

test('monitor publication lock enforces mutual exclusion across real child processes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-workers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const insidePath = path.join(root, 'inside');
  const logPath = path.join(root, 'order.log');
  const workers = Array.from({ length: 4 }, () => spawnLockWorker({
    lockPath,
    insidePath,
    logPath,
    holdMs: 40
  }));
  t.after(() => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
  });

  await Promise.all(workers.map((worker) => worker.completed));

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  let active = 0;
  let maximumActive = 0;
  for (const line of lines) {
    if (line.startsWith('enter ')) active += 1;
    if (line.startsWith('exit ')) active -= 1;
    maximumActive = Math.max(maximumActive, active);
    assert.ok(active >= 0, line);
  }
  assert.equal(lines.length, workers.length * 2);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  assert.equal(fs.existsSync(insidePath), false);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.includes('.candidate-') || name.includes('.release-')),
    []
  );
});

test('same-host live lock owners are never reclaimed solely because they are stale', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const releasePath = path.join(root, 'release-holder');
  const holder = spawnLockWorker({ lockPath, releasePath });
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill('SIGKILL');
    }
  });
  await holder.entered;
  const owner = readLockOwner(lockPath);

  assert.throws(
    () => withMonitorPublicationLock(lockPath, () => {}, {
      timeoutMs: 75,
      staleLockMs: 0
    }),
    /Timed out waiting for monitor baseline lock/
  );
  assert.equal(readLockOwner(lockPath).token, owner.token);

  fs.writeFileSync(releasePath, 'release');
  await holder.completed;
  assert.equal(fs.existsSync(lockPath), false);
});

test('fresh dead same-host lock owners are reclaimed before the stale-age threshold', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-dead-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const holder = spawnLockWorker({
    lockPath,
    releasePath: path.join(root, 'never-release')
  });
  await holder.entered;
  const deadOwner = readLockOwner(lockPath);
  holder.child.kill('SIGKILL');
  await assert.rejects(holder.completed, /Lock worker exited/);

  let acquired = false;
  withMonitorPublicationLock(lockPath, () => {
    acquired = true;
  }, { timeoutMs: 500 });

  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(retiredLockPath(lockPath, deadOwner.token)), true);
});

test('an old lock holder cannot release a successor generation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const releaseOldPath = path.join(root, 'release-old');
  const releaseNewPath = path.join(root, 'release-new');
  const oldHolder = spawnLockWorker({ lockPath, releasePath: releaseOldPath });
  let newHolder = null;
  t.after(() => {
    for (const worker of [oldHolder, newHolder]) {
      if (worker?.child.exitCode === null && worker?.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
  });
  await oldHolder.entered;
  const oldOwner = readLockOwner(lockPath);
  fs.writeFileSync(lockOwnerPath(lockPath), `${JSON.stringify({
    ...oldOwner,
    pid: 99999999,
    processStartIdentityVerified: true,
    acquiredAt: '2000-01-01T00:00:00.000Z'
  }, null, 2)}\n`);

  newHolder = spawnLockWorker({
    lockPath,
    releasePath: releaseNewPath,
    staleLockMs: 0
  });
  await newHolder.entered;
  const newOwner = readLockOwner(lockPath);
  assert.notEqual(newOwner.token, oldOwner.token);

  fs.writeFileSync(releaseOldPath, 'release');
  await oldHolder.completed;
  assert.equal(readLockOwner(lockPath).token, newOwner.token);
  assert.throws(
    () => withMonitorPublicationLock(lockPath, () => {}, { timeoutMs: 75 }),
    /Timed out waiting for monitor baseline lock/
  );

  fs.writeFileSync(releaseNewPath, 'release');
  await newHolder.completed;
  assert.equal(fs.existsSync(lockPath), false);
});

test('foreign-host lock evidence requires staleness before reclamation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-foreign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const foreignOwner = {
    schemaVersion: 1,
    token: '11111111-1111-4111-8111-111111111111',
    pid: 12345,
    hostname: `${os.hostname()}-other`,
    processStartIdentity: 'foreign-process-start',
    processStartIdentityVerified: true,
    acquiredAt: new Date().toISOString()
  };
  writeLockOwner(lockPath, foreignOwner);

  assert.throws(
    () => withMonitorPublicationLock(lockPath, () => {}, {
      timeoutMs: 50,
      staleLockMs: 60000
    }),
    /Timed out waiting for monitor baseline lock/
  );
  foreignOwner.acquiredAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(lockOwnerPath(lockPath), `${JSON.stringify(foreignOwner, null, 2)}\n`);

  let acquired = false;
  withMonitorPublicationLock(lockPath, () => {
    acquired = true;
  }, { timeoutMs: 500, staleLockMs: 0 });
  assert.equal(acquired, true);
  assert.equal(fs.existsSync(retiredLockPath(lockPath, foreignOwner.token)), true);
});

test('fresh same-host PID reuse evidence reclaims the prior owner immediately', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-pid-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const reusedPidOwner = {
    schemaVersion: 1,
    token: '22222222-2222-4222-8222-222222222222',
    pid: process.pid,
    hostname: os.hostname(),
    processStartIdentity: 'different-process-start-generation',
    processStartIdentityVerified: true,
    acquiredAt: new Date().toISOString()
  };
  writeLockOwner(lockPath, reusedPidOwner);

  let acquired = false;
  withMonitorPublicationLock(lockPath, () => {
    acquired = true;
  }, { timeoutMs: 500 });

  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(retiredLockPath(lockPath, reusedPidOwner.token)), true);
});

test('unverified process-start evidence never reclaims a live same-host owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-unverified-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const unverifiedOwner = {
    schemaVersion: 1,
    token: '33333333-3333-4333-8333-333333333333',
    pid: process.pid,
    hostname: os.hostname(),
    processStartIdentity: `unverified:${process.pid}:unknown`,
    processStartIdentityVerified: false,
    acquiredAt: '2000-01-01T00:00:00.000Z'
  };
  writeLockOwner(lockPath, unverifiedOwner);

  assert.throws(
    () => withMonitorPublicationLock(lockPath, () => {}, {
      timeoutMs: 75,
      staleLockMs: 0
    }),
    /Timed out waiting for monitor baseline lock/
  );
  assert.equal(readLockOwner(lockPath).token, unverifiedOwner.token);
});

test('simultaneous stale reclaimers retain multiprocess mutual exclusion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-reclaimers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const insidePath = path.join(root, 'inside');
  const logPath = path.join(root, 'order.log');
  const deadOwner = {
    schemaVersion: 1,
    token: '44444444-4444-4444-8444-444444444444',
    pid: 99999999,
    hostname: os.hostname(),
    processStartIdentity: 'unverified:99999999:unknown',
    processStartIdentityVerified: false,
    acquiredAt: new Date().toISOString()
  };
  writeLockOwner(lockPath, deadOwner);
  const workers = Array.from({ length: 4 }, () => spawnLockWorker({
    lockPath,
    insidePath,
    logPath,
    holdMs: 40
  }));
  t.after(() => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
  });

  await Promise.all(workers.map((worker) => worker.completed));

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  let active = 0;
  let maximumActive = 0;
  for (const line of lines) {
    if (line.startsWith('enter ')) active += 1;
    if (line.startsWith('exit ')) active -= 1;
    maximumActive = Math.max(maximumActive, active);
    assert.ok(active >= 0, line);
  }
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(retiredLockPath(lockPath, deadOwner.token)), true);
});

test('a delayed stale reclaimer cannot retire a successor generation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-lock-aba-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'publication.lock');
  const observedPath = path.join(root, 'observed');
  const resumePath = path.join(root, 'resume-delayed');
  const releaseSuccessorPath = path.join(root, 'release-successor');
  const insidePath = path.join(root, 'inside');
  const logPath = path.join(root, 'order.log');
  const deadOwner = {
    schemaVersion: 1,
    token: '55555555-5555-4555-8555-555555555555',
    pid: 99999999,
    hostname: os.hostname(),
    processStartIdentity: 'unverified:99999999:unknown',
    processStartIdentityVerified: false,
    acquiredAt: new Date().toISOString()
  };
  writeLockOwner(lockPath, deadOwner);
  const delayed = spawnDelayedReclaimer({
    lockPath,
    observedPath,
    resumePath,
    insidePath,
    logPath
  });
  let successor = null;
  t.after(() => {
    if (fs.existsSync(root) && !fs.existsSync(resumePath)) {
      fs.writeFileSync(resumePath, 'resume');
    }
    for (const worker of [delayed, successor]) {
      if (worker?.child.exitCode === null && worker?.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
  });
  await delayed.observed;

  successor = spawnLockWorker({
    lockPath,
    releasePath: releaseSuccessorPath,
    insidePath,
    logPath
  });
  await successor.entered;
  const successorOwner = readLockOwner(lockPath);
  fs.writeFileSync(resumePath, 'resume');
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(readLockOwner(lockPath).token, successorOwner.token);
  assert.equal(delayed.output().stdout.includes('entered '), false);
  assert.equal(fs.readFileSync(insidePath, 'utf8'), String(successor.child.pid));

  fs.writeFileSync(releaseSuccessorPath, 'release');
  await successor.completed;
  await delayed.entered;
  await delayed.completed;

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  let active = 0;
  let maximumActive = 0;
  for (const line of lines) {
    if (line.startsWith('enter ')) active += 1;
    if (line.startsWith('exit ')) active -= 1;
    maximumActive = Math.max(maximumActive, active);
  }
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  assert.equal(fs.existsSync(retiredLockPath(lockPath, deadOwner.token)), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('monitor baselines persist across output directories and isolate core from full', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp', staticBase: 'https://static' });
  const coreReport = {
    mode: 'core',
    generatedAt: '2026-07-10T12:00:00.000Z',
    alerts: [{ dedupeKey: 'feed-a:stale', severity: 'warning' }],
    docResults: [{ key: 'docs:https://example.com', hash: 'hash-a', normalizedText: 'large content' }]
  };

  writeMonitorBaselineAtomic(coreReport, { baselineDir, scope });

  const fromFreshOutput = loadMonitorBaseline('core', {
    baselineDir,
    legacyLatestPath: path.join(root, 'fresh-worktree', 'analysis', 'monitor', 'latest.json'),
    scope
  });
  assert.equal(fromFreshOutput.source, 'durable');
  assert.deepEqual(fromFreshOutput.report.alerts, coreReport.alerts);
  assert.deepEqual(fromFreshOutput.report.docResults, [{ key: 'docs:https://example.com', hash: 'hash-a' }]);

  const fullBaseline = loadMonitorBaseline('full', { baselineDir, scope });
  assert.equal(fullBaseline.source, 'empty');
  assert.equal(fullBaseline.report, null);
  assert.notEqual(
    monitorBaselinePath('core', baselineDir, scope.id),
    monitorBaselinePath('full', baselineDir, scope.id)
  );
  assert.deepEqual(nonLockStateEntries(baselineDir), [`core.${scope.id}.json`]);
});

test('monitor baseline scopes isolate diagnostic options from production comparisons', () => {
  const production = buildMonitorBaselineScope({
    base: 'https://feed',
    mcp: 'https://mcp',
    staticBase: 'https://static',
    includeDocs: true,
    includeStatic: true,
    timeoutMs: 30000
  });
  const withoutDocs = buildMonitorBaselineScope({
    base: 'https://feed',
    mcp: 'https://mcp',
    staticBase: 'https://static',
    includeDocs: false,
    includeStatic: true,
    timeoutMs: 30000
  });
  const localFeed = buildMonitorBaselineScope({
    base: 'http://127.0.0.1:5173',
    mcp: 'https://mcp',
    staticBase: 'https://static',
    includeDocs: true,
    includeStatic: true,
    timeoutMs: 30000
  });
  assert.notEqual(production.id, withoutDocs.id);
  assert.notEqual(production.id, localFeed.id);
});

test('monitor baseline retains the last successful doc hash and replaces files atomically', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousReport = {
    mode: 'full',
    runStartedAt: '2026-07-10T11:55:00.000Z',
    generatedAt: '2026-07-10T12:00:00.000Z',
    alerts: [],
    docResults: [{ key: 'docs:https://example.com', hash: 'last-good' }]
  };
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  writeMonitorBaselineAtomic(previousReport, { baselineDir: root, scope });
  writeMonitorBaselineAtomic({
    ...previousReport,
    runStartedAt: '2026-07-10T12:55:00.000Z',
    generatedAt: '2026-07-10T13:00:00.000Z',
    docResults: [{ key: 'docs:https://example.com', hash: null }]
  }, { baselineDir: root, previousReport, scope });

  const loaded = loadMonitorBaseline('full', { baselineDir: root, scope });
  assert.equal(loaded.report.generatedAt, '2026-07-10T13:00:00.000Z');
  assert.equal(loaded.report.docResults[0].hash, 'last-good');
  assert.deepEqual(nonLockStateEntries(root), [`full.${scope.id}.json`]);
});

test('older-starting monitor run cannot replace a newer-start baseline after finishing later', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-ordering-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const newerStart = {
    mode: 'full',
    runStartedAt: '2026-07-10T12:55:00.000Z',
    generatedAt: '2026-07-10T13:00:00.000Z',
    alerts: [{ dedupeKey: 'newer-observation' }],
    docResults: []
  };
  writeMonitorBaselineAtomic(newerStart, { baselineDir: root, scope });
  let staleRunPublished = false;
  const staleWrite = writeMonitorBaselineAtomic({
    mode: 'full',
    runStartedAt: '2026-07-10T12:30:00.000Z',
    generatedAt: '2026-07-10T14:00:00.000Z',
    alerts: [{ dedupeKey: 'older-observation' }],
    docResults: []
  }, {
    baselineDir: root,
    scope,
    beforeCommit: () => {
      staleRunPublished = true;
    }
  });

  const afterOlderWrite = loadMonitorBaseline('full', { baselineDir: root, scope });
  assert.equal(staleWrite.written, false);
  assert.equal(staleWrite.semanticSupersededReason, 'scope-baseline');
  assert.equal(staleWrite.semanticSupersededBy.runStartedAt, newerStart.runStartedAt);
  assert.equal(staleWrite.publicationSupersededBy, undefined);
  assert.equal(staleRunPublished, false);
  assert.equal(afterOlderWrite.report.generatedAt, '2026-07-10T13:00:00.000Z');
  assert.equal(afterOlderWrite.report.runStartedAt, '2026-07-10T12:55:00.000Z');
  assert.deepEqual(afterOlderWrite.report.alerts, [{ dedupeKey: 'newer-observation' }]);
  assert.deepEqual(nonLockStateEntries(root), [`full.${scope.id}.json`]);
});

test('incomparable publication heads never suppress monitor alert semantics', (t) => {
  const critical = { dedupeKey: 'non-core:critical', feedId: 'non-core', severity: 'critical' };
  const resolved = { dedupeKey: 'docs:resolved', feedId: 'docs', severity: 'warning' };
  const conflicts = [
    { label: 'mode', publishedMode: 'core', publishedScopeId: null },
    { label: 'scope', publishedMode: 'full', publishedScopeId: 'other-production-scope' }
  ];

  for (const conflict of conflicts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `situation-room-monitor-${conflict.label}-ordering-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const baselineDir = path.join(root, 'state');
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const publicationMarkerPath = path.join(outputDir, 'latest-commit.json');
    const publicationHeadPath = monitorPublicationHeadPath(baselineDir);
    const candidateScope = buildMonitorBaselineScope({
      base: 'https://feed',
      mcp: 'https://mcp',
      timeoutMs: 1000
    });
    const newerPublication = {
      schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
      commitState: 'complete',
      mode: conflict.publishedMode,
      runStartedAt: '2026-07-10T13:00:00.000Z',
      generatedAt: '2026-07-10T13:01:00.000Z',
      scopeId: conflict.publishedScopeId || candidateScope.id,
      artifacts: {}
    };
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(publicationHeadPath, JSON.stringify(newerPublication));
    const candidate = {
      mode: 'full',
      runStartedAt: '2026-07-10T12:00:00.000Z',
      generatedAt: '2026-07-10T14:00:00.000Z',
      notify: true,
      summary: { critical: 1, warning: 0, info: 0 },
      alerts: [critical],
      docResults: [],
      deltas: {
        newAlerts: [critical],
        resolvedAlerts: [resolved],
        ongoingAlerts: []
      }
    };
    let reportRebased = false;
    let artifactsPublished = false;
    const result = writeMonitorBaselineAtomic(candidate, {
      baselineDir,
      scope: candidateScope,
      publicationLockPath: monitorPublicationLockPath(baselineDir),
      publicationMarkerPath,
      publicationHeadPath,
      prepareReport: () => {
        reportRebased = true;
        return candidate;
      },
      beforeCommit: () => {
        artifactsPublished = true;
      }
    });
    const disposition = applyMonitorWriteDisposition(candidate, result);

    assert.equal(result.written, false, conflict.label);
    assert.equal(result.semanticSupersededBy, undefined, conflict.label);
    assert.equal(result.publicationSupersededReason, 'shared-publication', conflict.label);
    assert.equal(result.publicationSupersededBy.runStartedAt, newerPublication.runStartedAt, conflict.label);
    assert.equal(reportRebased, true, conflict.label);
    assert.equal(artifactsPublished, false, conflict.label);
    assert.equal(disposition.superseded, false, conflict.label);
    assert.equal(disposition.semanticSuperseded, false, conflict.label);
    assert.equal(disposition.publicationSuperseded, true, conflict.label);
    assert.equal(disposition.notify, true, conflict.label);
    assert.deepEqual(disposition.deltas, candidate.deltas, conflict.label);
    assert.deepEqual(disposition.alerts, candidate.alerts, conflict.label);
    assert.equal(shouldFailMonitorRun(disposition), true, conflict.label);
    assert.equal(
      fs.existsSync(monitorBaselinePath('full', baselineDir, candidateScope.id)),
      false,
      conflict.label
    );
    assert.equal(fs.existsSync(publicationMarkerPath), false, conflict.label);
    assert.deepEqual(JSON.parse(fs.readFileSync(publicationHeadPath, 'utf8')), newerPublication);
  }
});

test('semantic supersession still clears obsolete deltas and failure behavior', () => {
  const critical = { dedupeKey: 'critical:new', feedId: 'critical', severity: 'critical' };
  const candidate = {
    mode: 'full',
    notify: true,
    summary: { critical: 1 },
    alerts: [critical],
    docResults: [],
    deltas: { newAlerts: [critical], resolvedAlerts: [], ongoingAlerts: [] }
  };
  const newerBaseline = {
    mode: 'full',
    scope: { id: 'production' },
    runStartedAt: '2026-07-10T13:00:00.000Z',
    generatedAt: '2026-07-10T13:01:00.000Z'
  };
  const disposition = applyMonitorWriteDisposition(candidate, {
    written: false,
    semanticSupersededBy: newerBaseline,
    semanticSupersededReason: 'scope-baseline',
    report: candidate
  });

  assert.equal(disposition.superseded, true);
  assert.equal(disposition.semanticSuperseded, true);
  assert.equal(disposition.publicationSuperseded, true);
  assert.equal(disposition.notify, false);
  assert.deepEqual(disposition.deltas, { newAlerts: [], resolvedAlerts: [], ongoingAlerts: [] });
  assert.equal(shouldFailMonitorRun(disposition), false);
});

test('baseline transaction recomputes alert deltas against the state committed under its lock', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const alert = { dedupeKey: 'feed-a:stale', feedId: 'feed-a', severity: 'warning' };
  const originallyLoaded = {
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:01:00.000Z',
    alerts: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(originallyLoaded, { baselineDir: root, scope });
  writeMonitorBaselineAtomic({
    ...originallyLoaded,
    runStartedAt: '2026-07-10T12:05:00.000Z',
    generatedAt: '2026-07-10T12:06:00.000Z',
    alerts: [alert]
  }, { baselineDir: root, previousReport: originallyLoaded, scope });

  let publishedReport = null;
  const candidate = {
    ...originallyLoaded,
    runStartedAt: '2026-07-10T12:10:00.000Z',
    generatedAt: '2026-07-10T12:11:00.000Z',
    alerts: [alert],
    notify: true,
    deltas: { newAlerts: [alert], resolvedAlerts: [], ongoingAlerts: [] }
  };
  const result = writeMonitorBaselineAtomic(candidate, {
    baselineDir: root,
    previousReport: originallyLoaded,
    scope,
    prepareReport: (existing) => {
      const deltas = diffAlerts(candidate.alerts, existing?.alerts || []);
      return {
        ...candidate,
        notify: deltas.newAlerts.length > 0 || deltas.resolvedAlerts.length > 0,
        deltas
      };
    },
    beforeCommit: (report) => {
      publishedReport = report;
    }
  });

  assert.equal(result.written, true);
  assert.equal(result.report.notify, false);
  assert.deepEqual(result.report.deltas.newAlerts, []);
  assert.deepEqual(result.report.deltas.ongoingAlerts, [alert]);
  assert.deepEqual(publishedReport, result.report);
});

test('failed final publication marker restores the previous durable baseline and aborts artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const previous = {
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:01:00.000Z',
    alerts: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(previous, { baselineDir: root, scope });

  let artifactsAborted = false;
  assert.throws(
    () => writeMonitorBaselineAtomic({
      ...previous,
      runStartedAt: '2026-07-10T12:10:00.000Z',
      generatedAt: '2026-07-10T12:11:00.000Z'
    }, {
      baselineDir: root,
      previousReport: previous,
      scope,
      afterBaselineCommit: (committedReport, { filePath }) => {
        const committedBaseline = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.equal(committedBaseline.runStartedAt, committedReport.runStartedAt);
        throw new Error('publication pointer failed');
      },
      onAbort: () => {
        artifactsAborted = true;
      }
    }),
    /publication pointer failed/
  );

  const restored = loadMonitorBaseline('full', { baselineDir: root, scope });
  assert.equal(artifactsAborted, true);
  assert.equal(restored.report.runStartedAt, previous.runStartedAt);
  assert.equal(restored.report.generatedAt, previous.generatedAt);
  assert.deepEqual(nonLockStateEntries(root), [`full.${scope.id}.json`]);
});

test('pending publication recovery promotes a baseline committed before an abrupt exit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-recover-committed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'output');
  const historyDir = path.join(outputDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const report = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [{ dedupeKey: 'critical:new', feedId: 'critical', severity: 'critical' }],
    docResults: []
  };
  const baselineWrite = writeMonitorBaselineAtomic(report, { baselineDir, scope });
  const latestRaw = JSON.stringify(report, null, 2);
  const markdownRaw = '# Monitor\n';
  const historyRaw = latestRaw;
  const latestPath = path.join(outputDir, 'latest.json');
  const markdownPath = path.join(outputDir, 'latest.md');
  const historyPath = path.join(historyDir, 'report.json');
  const markerPath = path.join(outputDir, 'latest-commit.json');
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: report.mode,
    runStartedAt: report.runStartedAt,
    generatedAt: report.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(markdownRaw) },
      history: { path: 'history/report.json', sha256: hashContent(historyRaw) },
      baseline: {
        path: path.basename(baselineWrite.filePath),
        sha256: hashContent(fs.readFileSync(baselineWrite.filePath, 'utf8'))
      }
    }
  };
  const baselineRaw = fs.readFileSync(baselineWrite.filePath, 'utf8');
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: report.mode,
    scopeId: scope.id,
    publication,
    baselineRaw,
    previousBaselineRaw: null,
    artifacts: {
      history: { target: 'history/report.json', raw: historyRaw },
      latestMarkdown: { target: 'latest.md', raw: markdownRaw },
      latestJson: { target: 'latest.json', raw: latestRaw }
    }
  });

  assert.equal(fs.existsSync(latestPath), false);
  assert.equal(fs.existsSync(markdownPath), false);
  assert.equal(fs.existsSync(historyPath), false);
  fs.renameSync(path.join(outputDir, stages.history.staged), historyPath);
  const [recovery] = recoverMonitorPublications({ baselineDir });

  assert.equal(recovery.status, 'completed');
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), publication);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    publication
  );
  assert.equal(fs.readFileSync(latestPath, 'utf8'), latestRaw);
  assert.equal(fs.readFileSync(markdownPath, 'utf8'), markdownRaw);
  assert.equal(fs.readFileSync(historyPath, 'utf8'), historyRaw);
  assert.equal(fs.existsSync(journalPath), false);
  for (const stage of Object.values(stages)) {
    assert.equal(fs.existsSync(path.join(outputDir, stage.staged)), false);
  }
  assert.deepEqual(loadMonitorBaseline('full', { baselineDir, scope }).report.alerts, report.alerts);
});

test('pending publication recovery discards a journal when the baseline never committed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-recover-aborted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'output');
  const historyDir = path.join(outputDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const previous = {
    mode: 'full',
    runStartedAt: '2026-07-10T11:00:00.000Z',
    generatedAt: '2026-07-10T11:05:00.000Z',
    alerts: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(previous, { baselineDir, scope });
  const interrupted = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [{ dedupeKey: 'critical:new', feedId: 'critical', severity: 'critical' }],
    docResults: []
  };
  const interruptedBaselineRaw = `${JSON.stringify(
    buildMonitorBaseline(interrupted, previous, scope),
    null,
    2
  )}\n`;
  const latestRaw = JSON.stringify(interrupted, null, 2);
  const markdownRaw = '# Interrupted monitor\n';
  const historyRaw = latestRaw;
  const previousLatestRaw = JSON.stringify(previous, null, 2);
  const previousMarkdownRaw = '# Previous monitor\n';
  fs.writeFileSync(path.join(outputDir, 'latest.json'), previousLatestRaw);
  fs.writeFileSync(path.join(outputDir, 'latest.md'), previousMarkdownRaw);
  const markerPath = path.join(outputDir, 'latest-commit.json');
  const previousPublication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: previous.mode,
    runStartedAt: previous.runStartedAt,
    generatedAt: previous.generatedAt,
    scopeId: scope.id,
    artifacts: {}
  };
  fs.writeFileSync(markerPath, JSON.stringify(previousPublication, null, 2));
  fs.writeFileSync(
    monitorPublicationHeadPath(baselineDir),
    JSON.stringify(previousPublication, null, 2)
  );
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: interrupted.mode,
    runStartedAt: interrupted.runStartedAt,
    generatedAt: interrupted.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(markdownRaw) },
      history: { path: 'history/report.json', sha256: hashContent(historyRaw) },
      baseline: {
        path: `full.${scope.id}.json`,
        sha256: hashContent(interruptedBaselineRaw)
      }
    }
  };
  const previousBaselineRaw = fs.readFileSync(
    monitorBaselinePath('full', baselineDir, scope.id),
    'utf8'
  );
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: interrupted.mode,
    scopeId: scope.id,
    publication,
    baselineRaw: interruptedBaselineRaw,
    previousBaselineRaw,
    artifacts: {
      history: { target: 'history/report.json', raw: historyRaw },
      latestMarkdown: {
        target: 'latest.md',
        raw: markdownRaw,
        previousRaw: previousMarkdownRaw
      },
      latestJson: {
        target: 'latest.json',
        raw: latestRaw,
        previousRaw: previousLatestRaw
      }
    }
  });

  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'), previousLatestRaw);
  fs.renameSync(
    path.join(outputDir, stages.history.staged),
    path.join(historyDir, 'report.json')
  );
  const recovery = recoverMonitorPublicationJournal({ journalPath });
  const retained = loadMonitorBaseline('full', { baselineDir, scope }).report;

  assert.equal(recovery.status, 'aborted-before-baseline');
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), previousPublication);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    previousPublication
  );
  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'), previousLatestRaw);
  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.md'), 'utf8'), previousMarkdownRaw);
  assert.equal(fs.existsSync(path.join(historyDir, 'report.json')), false);
  for (const stage of Object.values(stages)) {
    assert.equal(fs.existsSync(path.join(outputDir, stage.staged)), false);
  }
  assert.deepEqual(retained.alerts, []);
  assert.equal(diffAlerts(interrupted.alerts, retained.alerts).newAlerts.length, 1);
});

test('file-backed rollback keeps large publication journals small and restores prior bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-large-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'output');
  const historyDir = path.join(outputDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const previous = {
    mode: 'full',
    runStartedAt: '2026-07-10T11:00:00.000Z',
    generatedAt: '2026-07-10T11:05:00.000Z',
    alerts: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(previous, { baselineDir, scope });
  const baselinePath = monitorBaselinePath('full', baselineDir, scope.id);
  const previousBaselineRaw = fs.readFileSync(baselinePath, 'utf8');
  const interrupted = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [{ dedupeKey: 'critical:new', feedId: 'critical', severity: 'critical' }],
    docResults: []
  };
  const interruptedBaselineRaw = `${JSON.stringify(
    buildMonitorBaseline(interrupted, previous, scope),
    null,
    2
  )}\n`;
  const latestRaw = JSON.stringify(interrupted, null, 2);
  const markdownRaw = '# Interrupted monitor\n';
  const previousLatestRaw = 'x'.repeat(8 * 1024 * 1024);
  const previousMarkdownRaw = '# Previous monitor\n';
  fs.writeFileSync(path.join(outputDir, 'latest.json'), previousLatestRaw);
  fs.writeFileSync(path.join(outputDir, 'latest.md'), previousMarkdownRaw);
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: interrupted.mode,
    runStartedAt: interrupted.runStartedAt,
    generatedAt: interrupted.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(markdownRaw) },
      history: { path: 'history/report.json', sha256: hashContent(latestRaw) },
      baseline: { path: path.basename(baselinePath), sha256: hashContent(interruptedBaselineRaw) }
    }
  };
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: interrupted.mode,
    scopeId: scope.id,
    publication,
    baselineRaw: interruptedBaselineRaw,
    previousBaselineRaw,
    artifacts: {
      history: { target: 'history/report.json', raw: latestRaw },
      latestMarkdown: {
        target: 'latest.md',
        raw: markdownRaw,
        previousRaw: previousMarkdownRaw
      },
      latestJson: {
        target: 'latest.json',
        raw: latestRaw,
        previousRaw: previousLatestRaw
      }
    }
  });
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.ok(fs.statSync(journalPath).size < 64 * 1024);
  assert.equal(journal.stages.latestJson.previousBase64, undefined);
  assert.match(journal.stages.latestJson.rollback, /\.rollback$/);
  assert.equal(
    fs.statSync(path.join(outputDir, journal.stages.latestJson.rollback)).size,
    previousLatestRaw.length
  );

  for (const stage of Object.values(stages)) {
    const targetPath = path.join(outputDir, stage.target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(path.join(outputDir, stage.staged), targetPath);
  }
  const recovery = recoverMonitorPublicationJournal({ journalPath });

  assert.equal(recovery.status, 'aborted-before-baseline');
  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'), previousLatestRaw);
  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.md'), 'utf8'), previousMarkdownRaw);
  assert.equal(fs.existsSync(path.join(historyDir, 'report.json')), false);
  assert.equal(fs.existsSync(journalPath), false);
  for (const stage of Object.values(stages)) {
    assert.equal(fs.existsSync(path.join(outputDir, stage.staged)), false);
    if (stage.rollback) {
      assert.equal(fs.existsSync(path.join(outputDir, stage.rollback)), false);
    }
  }
});

test('publication cleanup retains its journal until staged rollback files are removed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-cleanup-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(path.join(outputDir, 'history'), { recursive: true });
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const report = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [],
    docResults: []
  };
  const baselineWrite = writeMonitorBaselineAtomic(report, { baselineDir, scope });
  const baselineRaw = fs.readFileSync(baselineWrite.filePath, 'utf8');
  const latestRaw = JSON.stringify(report, null, 2);
  const markdownRaw = '# Monitor\n';
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: report.mode,
    runStartedAt: report.runStartedAt,
    generatedAt: report.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(markdownRaw) },
      history: { path: 'history/report.json', sha256: hashContent(latestRaw) },
      baseline: { path: path.basename(baselineWrite.filePath), sha256: hashContent(baselineRaw) }
    }
  };
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: report.mode,
    scopeId: scope.id,
    state: 'published',
    publication,
    baselineRaw,
    previousBaselineRaw: null,
    artifacts: {
      history: { target: 'history/report.json', raw: latestRaw, previousRaw: 'old history' },
      latestMarkdown: { target: 'latest.md', raw: markdownRaw, previousRaw: 'old markdown' },
      latestJson: { target: 'latest.json', raw: latestRaw, previousRaw: 'old latest' }
    }
  });
  for (const [key, stage] of Object.entries(stages)) {
    const raw = key === 'latestMarkdown' ? markdownRaw : latestRaw;
    const targetPath = path.join(outputDir, stage.target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, raw);
  }
  const publicationRaw = JSON.stringify(publication, null, 2);
  fs.writeFileSync(path.join(outputDir, 'latest-commit.json'), publicationRaw);
  fs.writeFileSync(monitorPublicationHeadPath(baselineDir), publicationRaw);

  const blockedStagePath = path.join(outputDir, stages.history.staged);
  const unlinkSync = fs.unlinkSync;
  fs.unlinkSync = (filePath) => {
    if (path.resolve(filePath) === path.resolve(blockedStagePath)) {
      const error = new Error('simulated cleanup failure');
      error.code = 'EACCES';
      throw error;
    }
    return unlinkSync(filePath);
  };
  let firstRecovery;
  try {
    firstRecovery = recoverMonitorPublicationJournal({ journalPath });
  } finally {
    fs.unlinkSync = unlinkSync;
  }

  assert.equal(firstRecovery.status, 'completed-published-cleanup-incomplete');
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(fs.existsSync(blockedStagePath), true);

  const secondRecovery = recoverMonitorPublicationJournal({ journalPath });
  assert.equal(secondRecovery.status, 'completed-published');
  assert.equal(fs.existsSync(journalPath), false);
  for (const stage of Object.values(stages)) {
    assert.equal(fs.existsSync(path.join(outputDir, stage.staged)), false);
    if (stage.rollback) {
      assert.equal(fs.existsSync(path.join(outputDir, stage.rollback)), false);
    }
  }
});

test('durable recovery rolls back a committed baseline when its old output root vanished', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-missing-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'discarded-worktree', 'analysis', 'monitor');
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const previous = {
    mode: 'full',
    runStartedAt: '2026-07-10T11:00:00.000Z',
    generatedAt: '2026-07-10T11:05:00.000Z',
    alerts: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(previous, { baselineDir, scope });
  const baselinePath = monitorBaselinePath('full', baselineDir, scope.id);
  const previousBaselineRaw = fs.readFileSync(baselinePath, 'utf8');
  const interrupted = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [{ dedupeKey: 'critical:new', feedId: 'critical', severity: 'critical' }],
    docResults: []
  };
  const interruptedBaselineRaw = `${JSON.stringify(
    buildMonitorBaseline(interrupted, previous, scope),
    null,
    2
  )}\n`;
  const latestRaw = JSON.stringify(interrupted, null, 2);
  const markdownRaw = '# Interrupted monitor\n';
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: interrupted.mode,
    runStartedAt: interrupted.runStartedAt,
    generatedAt: interrupted.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(markdownRaw) },
      history: { path: 'history/report.json', sha256: hashContent(latestRaw) },
      baseline: { path: path.basename(baselinePath), sha256: hashContent(interruptedBaselineRaw) }
    }
  };
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: interrupted.mode,
    scopeId: scope.id,
    publication,
    baselineRaw: interruptedBaselineRaw,
    previousBaselineRaw,
    artifacts: {
      history: { target: 'history/report.json', raw: latestRaw },
      latestMarkdown: { target: 'latest.md', raw: markdownRaw },
      latestJson: { target: 'latest.json', raw: latestRaw }
    }
  });
  fs.writeFileSync(baselinePath, interruptedBaselineRaw);
  for (const stage of Object.values(stages)) {
    const stagedPath = path.join(outputDir, stage.staged);
    const targetPath = path.join(outputDir, stage.target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(stagedPath, targetPath);
  }
  const publicationRaw = JSON.stringify(publication, null, 2);
  fs.writeFileSync(path.join(outputDir, 'latest-commit.json'), publicationRaw);
  fs.writeFileSync(monitorPublicationHeadPath(baselineDir), publicationRaw);
  fs.rmSync(path.join(root, 'discarded-worktree'), { recursive: true, force: true });

  const recovery = recoverMonitorPublicationJournal({ journalPath });

  assert.equal(recovery.status, 'rolled-back-missing-output');
  assert.equal(fs.readFileSync(baselinePath, 'utf8'), previousBaselineRaw);
  assert.equal(fs.existsSync(monitorPublicationHeadPath(baselineDir)), false);
  assert.equal(fs.existsSync(outputDir), false);
  assert.equal(fs.existsSync(journalPath), false);
});

test('published retained journal does not wedge a fresh runner without cached output artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-retained-published-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'fresh-checkout', 'analysis', 'monitor');
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const report = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [],
    docResults: []
  };
  const baselineWrite = writeMonitorBaselineAtomic(report, { baselineDir, scope });
  const baselineRaw = fs.readFileSync(baselineWrite.filePath, 'utf8');
  const latestRaw = JSON.stringify(report, null, 2);
  const markdownRaw = '# Monitor\n';
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: report.mode,
    runStartedAt: report.runStartedAt,
    generatedAt: report.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(markdownRaw) },
      history: { path: 'history/report.json', sha256: hashContent(latestRaw) },
      baseline: { path: path.basename(baselineWrite.filePath), sha256: hashContent(baselineRaw) }
    }
  };
  fs.mkdirSync(path.join(outputDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'latest.json'), 'previous latest');
  fs.writeFileSync(path.join(outputDir, 'latest.md'), 'previous markdown');
  fs.writeFileSync(path.join(outputDir, 'history', 'report.json'), 'previous history');
  fs.writeFileSync(path.join(outputDir, 'latest-commit.json'), JSON.stringify({
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: report.mode,
    runStartedAt: '2026-07-10T11:00:00.000Z',
    generatedAt: '2026-07-10T11:05:00.000Z',
    scopeId: scope.id,
    artifacts: {}
  }, null, 2));
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: report.mode,
    scopeId: scope.id,
    state: 'published',
    publication,
    baselineRaw,
    previousBaselineRaw: null,
    artifacts: {
      history: { target: 'history/report.json', raw: latestRaw, previousRaw: 'previous history' },
      latestMarkdown: { target: 'latest.md', raw: markdownRaw, previousRaw: 'previous markdown' },
      latestJson: { target: 'latest.json', raw: latestRaw, previousRaw: 'previous latest' }
    }
  });
  assert.equal(Object.keys(stages).length, 3);
  fs.rmSync(path.join(root, 'fresh-checkout'), { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    monitorPublicationHeadPath(baselineDir),
    JSON.stringify(publication, null, 2)
  );

  const recovery = recoverMonitorPublicationJournal({ journalPath });

  assert.equal(recovery.status, 'completed-published');
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(fs.readFileSync(baselineWrite.filePath, 'utf8'), baselineRaw);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    publication
  );
  assert.equal(fs.existsSync(path.join(outputDir, 'latest.json')), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'latest-commit.json')), false);
});

test('published recovery resumes after head rollback before baseline rollback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-restored-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputDir = path.join(root, 'analysis', 'monitor');
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const previous = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T11:00:00.000Z',
    generatedAt: '2026-07-10T11:05:00.000Z',
    alerts: [],
    docResults: []
  };
  const previousBaselineWrite = writeMonitorBaselineAtomic(previous, { baselineDir, scope });
  const previousBaselineRaw = fs.readFileSync(previousBaselineWrite.filePath, 'utf8');
  const previousLatestRaw = JSON.stringify(previous, null, 2);
  const previousMarkdownRaw = '# Previous monitor\n';
  const previousHistoryPath = 'history/previous.json';
  const previousPublication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: previous.mode,
    runStartedAt: previous.runStartedAt,
    generatedAt: previous.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(previousLatestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(previousMarkdownRaw) },
      history: { path: previousHistoryPath, sha256: hashContent(previousLatestRaw) },
      baseline: {
        path: path.basename(previousBaselineWrite.filePath),
        sha256: hashContent(previousBaselineRaw)
      }
    }
  };
  const previousPublicationRaw = JSON.stringify(previousPublication, null, 2);
  fs.mkdirSync(path.join(outputDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'latest.json'), previousLatestRaw);
  fs.writeFileSync(path.join(outputDir, 'latest.md'), previousMarkdownRaw);
  fs.writeFileSync(path.join(outputDir, previousHistoryPath), previousLatestRaw);
  fs.writeFileSync(path.join(outputDir, 'latest-commit.json'), previousPublicationRaw);
  fs.writeFileSync(monitorPublicationHeadPath(baselineDir), previousPublicationRaw);

  const interrupted = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [{ dedupeKey: 'critical:new', feedId: 'critical', severity: 'critical' }],
    docResults: []
  };
  const interruptedBaselineRaw = `${JSON.stringify(
    buildMonitorBaseline(interrupted, previous, scope),
    null,
    2
  )}\n`;
  const interruptedLatestRaw = JSON.stringify(interrupted, null, 2);
  const interruptedMarkdownRaw = '# Interrupted monitor\n';
  const interruptedHistoryPath = 'history/interrupted.json';
  const publication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: interrupted.mode,
    runStartedAt: interrupted.runStartedAt,
    generatedAt: interrupted.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(interruptedLatestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(interruptedMarkdownRaw) },
      history: { path: interruptedHistoryPath, sha256: hashContent(interruptedLatestRaw) },
      baseline: {
        path: path.basename(previousBaselineWrite.filePath),
        sha256: hashContent(interruptedBaselineRaw)
      }
    }
  };
  const { journalPath, stages } = writePendingMonitorPublication({
    baselineDir,
    outputDir,
    mode: interrupted.mode,
    scopeId: scope.id,
    state: 'published',
    publication,
    baselineRaw: interruptedBaselineRaw,
    previousBaselineRaw,
    artifacts: {
      history: { target: interruptedHistoryPath, raw: interruptedLatestRaw },
      latestMarkdown: {
        target: 'latest.md',
        raw: interruptedMarkdownRaw,
        previousRaw: previousMarkdownRaw
      },
      latestJson: {
        target: 'latest.json',
        raw: interruptedLatestRaw,
        previousRaw: previousLatestRaw
      }
    }
  });
  fs.writeFileSync(previousBaselineWrite.filePath, interruptedBaselineRaw);
  for (const stage of Object.values(stages)) {
    fs.renameSync(path.join(outputDir, stage.staged), path.join(outputDir, stage.target));
  }
  const publicationRaw = JSON.stringify(publication, null, 2);
  fs.writeFileSync(path.join(outputDir, 'latest-commit.json'), publicationRaw);
  fs.writeFileSync(monitorPublicationHeadPath(baselineDir), publicationRaw);

  fs.writeFileSync(path.join(outputDir, 'latest.json'), previousLatestRaw);
  fs.writeFileSync(path.join(outputDir, 'latest.md'), previousMarkdownRaw);
  fs.unlinkSync(path.join(outputDir, interruptedHistoryPath));

  const renameSync = fs.renameSync;
  let interruptedRollback = false;
  fs.renameSync = (source, destination) => {
    if (
      !interruptedRollback
      && path.resolve(destination) === path.resolve(previousBaselineWrite.filePath)
      && String(source).endsWith('.rollback.tmp')
    ) {
      interruptedRollback = true;
      const error = new Error('simulated interruption before baseline rollback');
      error.code = 'EIO';
      throw error;
    }
    return renameSync(source, destination);
  };
  try {
    assert.throws(
      () => recoverMonitorPublicationJournal({ journalPath }),
      /simulated interruption before baseline rollback/
    );
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(interruptedRollback, true);
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(fs.readFileSync(previousBaselineWrite.filePath, 'utf8'), interruptedBaselineRaw);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    previousPublication
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(outputDir, 'latest-commit.json'), 'utf8')),
    previousPublication
  );

  const recovery = recoverMonitorPublicationJournal({ journalPath });

  assert.equal(recovery.status, 'rolled-back-published-output');
  assert.equal(fs.readFileSync(previousBaselineWrite.filePath, 'utf8'), previousBaselineRaw);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    previousPublication
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(outputDir, 'latest-commit.json'), 'utf8')),
    previousPublication
  );
  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'), previousLatestRaw);
  assert.equal(fs.readFileSync(path.join(outputDir, 'latest.md'), 'utf8'), previousMarkdownRaw);
  assert.equal(fs.existsSync(path.join(outputDir, interruptedHistoryPath)), false);
  assert.equal(fs.existsSync(journalPath), false);
  for (const stage of Object.values(stages)) {
    assert.equal(fs.existsSync(path.join(outputDir, stage.staged)), false);
    if (stage.rollback) {
      assert.equal(fs.existsSync(path.join(outputDir, stage.rollback)), false);
    }
  }
  const restoredBaseline = loadMonitorBaseline('full', { baselineDir, scope }).report;
  const deltas = diffAlerts(interrupted.alerts, restoredBaseline.alerts);
  assert.equal(deltas.newAlerts.length, 1);
  assert.equal(deltas.newAlerts[0].dedupeKey, 'critical:new');
});

test('monitor baseline scope excludes credentials from public IDs and persisted endpoints', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-secret-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = buildMonitorBaselineScope({
    base: 'https://operator:password@example.com/feed?x-api-key=feed-secret&region=us',
    mcp: 'https://example.com/mcp?access_token=mcp-secret',
    staticBase: 'https://example.com/static?key=static-secret'
  });
  const rotatedSecretScope = buildMonitorBaselineScope({
    base: 'https://operator:different@example.com/feed?x-api-key=rotated-secret&region=us',
    mcp: 'https://example.com/mcp?access_token=rotated-mcp-secret',
    staticBase: 'https://example.com/static?key=rotated-static-secret'
  });
  const differentRegionScope = buildMonitorBaselineScope({
    base: 'https://operator:different@example.com/feed?x-api-key=rotated-secret&region=eu',
    mcp: 'https://example.com/mcp?access_token=rotated-mcp-secret',
    staticBase: 'https://example.com/static?key=rotated-static-secret'
  });
  assert.equal(scope.id, rotatedSecretScope.id);
  assert.notEqual(scope.id, differentRegionScope.id);
  assert.equal(scope.base, rotatedSecretScope.base);
  assert.equal(scope.mcp, rotatedSecretScope.mcp);
  assert.equal(scope.staticBase, rotatedSecretScope.staticBase);
  const report = {
    mode: 'core',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    alerts: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(report, { baselineDir: root, scope });

  const persisted = fs.readFileSync(monitorBaselinePath('core', root, scope.id), 'utf8');
  assert.doesNotMatch(persisted, /password|feed-secret|mcp-secret|static-secret/);
  assert.match(persisted, /REDACTED/);
  assert.match(persisted, /region=REDACTED/);
  assert.equal(loadMonitorBaseline('core', { baselineDir: root, scope }).source, 'durable');
});

test('monitor baseline descriptors redact every query value and URL fragment', () => {
  const scope = buildMonitorBaselineScope({
    base: 'https://example.com/feed?clientSecret=client-value&accessKeyId=access-value&region=us&appid=weather-secret#private-fragment',
    mcp: 'https://example.com/mcp?sessionId=session-value&subscriptionKey=subscription-value'
  });
  const rotatedSecrets = buildMonitorBaselineScope({
    base: 'https://example.com/feed?clientSecret=rotated-client&accessKeyId=rotated-access&region=us&appid=rotated-weather#different-fragment',
    mcp: 'https://example.com/mcp?sessionId=rotated-session&subscriptionKey=rotated-subscription'
  });
  const persistedDescriptors = JSON.stringify({ base: scope.base, mcp: scope.mcp });
  assert.doesNotMatch(
    persistedDescriptors,
    /client-value|access-value|session-value|subscription-value|weather-secret|private-fragment/
  );
  assert.match(scope.base, /clientSecret=REDACTED/);
  assert.match(scope.base, /accessKeyId=REDACTED/);
  assert.match(scope.mcp, /sessionId=REDACTED/);
  assert.match(scope.mcp, /subscriptionKey=REDACTED/);
  assert.match(scope.base, /region=REDACTED/);
  assert.match(scope.base, /appid=REDACTED/);
  assert.equal(scope.id, rotatedSecrets.id);
});

test('unknown endpoint selectors require an explicit non-secret scope tag', () => {
  assert.throws(
    () => buildMonitorBaselineScope({ base: 'https://example.com/feed?tenant=alpha' }),
    /explicit --scope-tag/
  );
  for (const selector of ['country_code', 'postal_code', 'client']) {
    assert.throws(
      () => buildMonitorBaselineScope({
        base: `https://example.com/feed?${selector}=alpha`
      }),
      /explicit --scope-tag/
    );
  }
  const alpha = buildMonitorBaselineScope({
    base: 'https://example.com/feed?tenant=alpha',
    scopeTag: 'tenant-alpha'
  });
  const beta = buildMonitorBaselineScope({
    base: 'https://example.com/feed?tenant=beta',
    scopeTag: 'tenant-beta'
  });
  assert.notEqual(alpha.id, beta.id);
  assert.equal(alpha.base, beta.base);
  assert.doesNotMatch(alpha.base, /alpha/);
  assert.match(alpha.base, /tenant=REDACTED/);
});

test('observed monitor URLs redact userinfo, every query value, and fragments', () => {
  const sanitized = sanitizeObservedUrl(
    'https://operator:password@example.com/feed?appid=weather-secret&access_token=oauth-secret&region=us#private-fragment'
  );
  assert.doesNotMatch(
    sanitized,
    /operator|password|weather-secret|oauth-secret|region=us|private-fragment/
  );
  assert.match(sanitized, /REDACTED/);
  assert.match(sanitized, /appid=REDACTED/);
  assert.match(sanitized, /access_token=REDACTED/);
  assert.match(sanitized, /region=REDACTED/);
});

test('monitor baseline requires explicit opt-in for unscoped legacy migration and rejects corrupt durable state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyPath = path.join(root, 'latest.json');
  const scope = buildMonitorBaselineScope({
    base: 'https://feed',
    mcp: 'https://mcp',
    staticBase: 'https://static'
  });
  fs.writeFileSync(legacyPath, JSON.stringify({
    mode: 'core',
    generatedAt: '2026-07-10T12:00:00.000Z',
    base: scope.rawIdentity.base,
    mcp: scope.rawIdentity.mcp,
    staticBase: scope.rawIdentity.staticBase,
    alerts: [],
    docResults: [{ key: 'docs:https://example.com', hash: 'hash-a' }]
  }));

  assert.equal(loadMonitorBaseline('core', {
    baselineDir: path.join(root, 'state'),
    legacyLatestPath: legacyPath,
    scope
  }).source, 'empty');
  assert.equal(loadMonitorBaseline('core', {
    baselineDir: path.join(root, 'state'),
    legacyLatestPath: legacyPath,
    allowLegacyMigration: true,
    scope
  }).source, 'legacy-latest');
  assert.equal(loadMonitorBaseline('full', {
    baselineDir: path.join(root, 'state'),
    legacyLatestPath: legacyPath,
    allowLegacyMigration: true,
    scope
  }).source, 'empty');

  fs.writeFileSync(legacyPath, JSON.stringify({
    publicationSchemaVersion: 1,
    mode: 'core',
    generatedAt: '2026-07-10T13:00:00.000Z',
    base: scope.rawIdentity.base,
    mcp: scope.rawIdentity.mcp,
    staticBase: scope.rawIdentity.staticBase,
    alerts: [{ dedupeKey: 'unpublished-alert' }],
    docResults: []
  }));
  assert.equal(loadMonitorBaseline('core', {
    baselineDir: path.join(root, 'modern-state'),
    legacyLatestPath: legacyPath,
    allowLegacyMigration: true,
    scope
  }).source, 'empty');

  const corruptPath = monitorBaselinePath('core', path.join(root, 'state'), scope.id);
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{bad json');
  assert.throws(
    () => loadMonitorBaseline('core', { baselineDir: path.join(root, 'state'), scope }),
    /Invalid monitor baseline JSON/
  );
});

test('report regeneration holds the publication lock and refreshes the Markdown manifest hash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const latestPath = path.join(root, 'latest.json');
  const latestMarkdownPath = path.join(root, 'latest.md');
  const publicationPath = path.join(root, 'latest-commit.json');
  const baselineDir = path.join(root, 'state');
  const baselineName = 'full.test-scope.json';
  const baselinePath = path.join(baselineDir, baselineName);
  const report = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    summary: { totalFeeds: 1, checkedFeeds: 1, critical: 0, warning: 0, info: 0 },
    alerts: [],
    deltas: { newAlerts: [], resolvedAlerts: [], ongoingAlerts: [] },
    feedResults: [],
    docResults: []
  };
  const latestRaw = JSON.stringify(report, null, 2);
  const previousMarkdown = 'stale formatter output\n';
  const baselineRaw = JSON.stringify({
    schemaVersion: 1,
    mode: report.mode,
    scope: { id: 'test-scope' },
    runStartedAt: report.runStartedAt,
    generatedAt: report.generatedAt,
    alerts: [],
    docResults: []
  }, null, 2);
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.writeFileSync(baselinePath, baselineRaw);
  fs.writeFileSync(latestPath, latestRaw);
  fs.writeFileSync(latestMarkdownPath, previousMarkdown);
  fs.writeFileSync(publicationPath, JSON.stringify({
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: report.mode,
    runStartedAt: report.runStartedAt,
    generatedAt: report.generatedAt,
    scopeId: 'test-scope',
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(previousMarkdown) },
      history: { path: 'history/test.json', sha256: 'history-hash' },
      baseline: { path: baselineName, sha256: hashContent(baselineRaw) }
    }
  }, null, 2));

  const child = spawnSync(process.execPath, [
    'analysis/monitor/report_latest.mjs',
    '--output-dir',
    root,
    '--baseline-dir',
    baselineDir
  ], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.equal(child.status, 0, child.stderr);
  const regeneratedMarkdown = fs.readFileSync(latestMarkdownPath, 'utf8');
  const publication = JSON.parse(fs.readFileSync(publicationPath, 'utf8'));
  assert.equal(regeneratedMarkdown, buildMarkdownReport(report));
  assert.equal(publication.artifacts.latestMarkdown.sha256, hashContent(regeneratedMarkdown));
  assert.equal(publication.artifacts.latestJson.sha256, hashContent(latestRaw));
  assert.equal(publication.runStartedAt, report.runStartedAt);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    publication
  );
  assert.equal(fs.existsSync(monitorPublicationLockPath(baselineDir)), false);
});

test('report regeneration recovers another output journal before touching the shared head', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-report-cross-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const outputA = path.join(root, 'output-a');
  const outputB = path.join(root, 'output-b');
  const scope = buildMonitorBaselineScope({ base: 'https://feed', mcp: 'https://mcp' });
  const previous = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T11:00:00.000Z',
    generatedAt: '2026-07-10T11:05:00.000Z',
    summary: { totalFeeds: 1, checkedFeeds: 1, critical: 0, warning: 0, info: 0 },
    alerts: [],
    deltas: { newAlerts: [], resolvedAlerts: [], ongoingAlerts: [] },
    feedResults: [],
    docResults: []
  };
  writeMonitorBaselineAtomic(previous, { baselineDir, scope });
  const baselinePath = monitorBaselinePath('full', baselineDir, scope.id);
  const previousBaselineRaw = fs.readFileSync(baselinePath, 'utf8');
  const previousLatestRaw = JSON.stringify(previous, null, 2);
  const previousMarkdownRaw = buildMarkdownReport(previous);
  fs.mkdirSync(outputB, { recursive: true });
  fs.writeFileSync(path.join(outputB, 'latest.json'), previousLatestRaw);
  fs.writeFileSync(path.join(outputB, 'latest.md'), previousMarkdownRaw);
  const previousPublication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: previous.mode,
    runStartedAt: previous.runStartedAt,
    generatedAt: previous.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(previousLatestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(previousMarkdownRaw) },
      history: { path: 'history/previous.json', sha256: 'previous-history' },
      baseline: { path: path.basename(baselinePath), sha256: hashContent(previousBaselineRaw) }
    }
  };
  const previousPublicationRaw = JSON.stringify(previousPublication, null, 2);
  fs.writeFileSync(path.join(outputB, 'latest-commit.json'), previousPublicationRaw);
  fs.writeFileSync(monitorPublicationHeadPath(baselineDir), previousPublicationRaw);

  const pending = {
    ...previous,
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z'
  };
  const pendingLatestRaw = JSON.stringify(pending, null, 2);
  const pendingMarkdownRaw = buildMarkdownReport(pending);
  const pendingBaselineRaw = `${JSON.stringify(
    buildMonitorBaseline(pending, previous, scope),
    null,
    2
  )}\n`;
  const pendingPublication = {
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: pending.mode,
    runStartedAt: pending.runStartedAt,
    generatedAt: pending.generatedAt,
    scopeId: scope.id,
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(pendingLatestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: hashContent(pendingMarkdownRaw) },
      history: { path: 'history/pending.json', sha256: hashContent(pendingLatestRaw) },
      baseline: { path: path.basename(baselinePath), sha256: hashContent(pendingBaselineRaw) }
    }
  };
  const { journalPath } = writePendingMonitorPublication({
    baselineDir,
    outputDir: outputA,
    mode: pending.mode,
    scopeId: scope.id,
    publication: pendingPublication,
    baselineRaw: pendingBaselineRaw,
    previousBaselineRaw,
    artifacts: {
      history: { target: 'history/pending.json', raw: pendingLatestRaw },
      latestMarkdown: { target: 'latest.md', raw: pendingMarkdownRaw },
      latestJson: { target: 'latest.json', raw: pendingLatestRaw }
    }
  });
  fs.writeFileSync(baselinePath, pendingBaselineRaw);

  const child = spawnSync(process.execPath, [
    'analysis/monitor/report_latest.mjs',
    '--output-dir',
    outputB,
    '--baseline-dir',
    baselineDir
  ], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Publication marker or durable baseline does not match/);
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(monitorPublicationHeadPath(baselineDir), 'utf8')),
    pendingPublication
  );
  assert.equal(fs.readFileSync(path.join(outputA, 'latest.json'), 'utf8'), pendingLatestRaw);
  assert.equal(fs.readFileSync(path.join(outputB, 'latest.md'), 'utf8'), previousMarkdownRaw);
  assert.equal(fs.readFileSync(path.join(outputB, 'latest-commit.json'), 'utf8'), previousPublicationRaw);
});

test('report regeneration rejects an uncommitted modern report without its publication marker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-uncommitted-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const latestPath = path.join(root, 'latest.json');
  const latestMarkdownPath = path.join(root, 'latest.md');
  fs.writeFileSync(latestPath, JSON.stringify({
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    summary: {},
    alerts: [],
    deltas: {},
    feedResults: [],
    docResults: []
  }, null, 2));

  const child = spawnSync(process.execPath, [
    'analysis/monitor/report_latest.mjs',
    '--output-dir',
    root,
    '--baseline-dir',
    baselineDir
  ], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /has no publication marker/);
  assert.equal(fs.existsSync(latestMarkdownPath), false);
  assert.equal(fs.existsSync(monitorPublicationLockPath(baselineDir)), false);
});

test('report regeneration rejects a final marker whose durable baseline is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-room-monitor-missing-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'state');
  const latestPath = path.join(root, 'latest.json');
  const latestMarkdownPath = path.join(root, 'latest.md');
  const report = {
    publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    mode: 'full',
    runStartedAt: '2026-07-10T12:00:00.000Z',
    generatedAt: '2026-07-10T12:05:00.000Z',
    summary: {},
    alerts: [],
    deltas: {},
    feedResults: [],
    docResults: []
  };
  const latestRaw = JSON.stringify(report, null, 2);
  fs.writeFileSync(latestPath, latestRaw);
  fs.writeFileSync(path.join(root, 'latest-commit.json'), JSON.stringify({
    schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
    commitState: 'complete',
    mode: report.mode,
    runStartedAt: report.runStartedAt,
    generatedAt: report.generatedAt,
    scopeId: 'test-scope',
    artifacts: {
      latestJson: { path: 'latest.json', sha256: hashContent(latestRaw) },
      latestMarkdown: { path: 'latest.md', sha256: 'not-yet-used' },
      history: { path: 'history/test.json', sha256: 'history-hash' },
      baseline: { path: 'full.test-scope.json', sha256: 'missing-baseline-hash' }
    }
  }, null, 2));

  const child = spawnSync(process.execPath, [
    'analysis/monitor/report_latest.mjs',
    '--output-dir',
    root,
    '--baseline-dir',
    baselineDir
  ], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /durable baseline does not match/);
  assert.equal(fs.existsSync(latestMarkdownPath), false);
  assert.equal(fs.existsSync(monitorPublicationLockPath(baselineDir)), false);
});

test('monitor fetch text times out while reading a stalled response body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('partial');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const startedAt = Date.now();
    const result = await fetchText(`http://127.0.0.1:${port}/stall`, { timeoutMs: 50 });
    assert.equal(result.error, 'timeout');
    assert.equal(result.text, '');
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('monitor transport failures do not echo credentials from endpoint URLs', async () => {
  const endpoint = 'https://operator:supersecret@example.com/mcp?access_token=querysecret';
  const result = await callMcpTool(endpoint, 'catalog.sources', {}, 10);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'network_error');
  assert.equal(result.message, 'MCP request failed.');
  assert.doesNotMatch(JSON.stringify(result), /operator|supersecret|querysecret/);

  const textResult = await fetchText(endpoint, { timeoutMs: 10 });
  assert.equal(textResult.ok, false);
  assert.equal(textResult.error, 'fetch_failed');
  assert.doesNotMatch(JSON.stringify(textResult), /operator|supersecret|querysecret/);
});

test('monitor MCP error payloads redact credentials echoed from endpoint URLs', async (t) => {
  const server = http.createServer(async (req, res) => {
    const request = await readJsonRequest(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: `Unauthorized credential querysecret in request ${req.url}`
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp?x-api-key=querysecret&region=us-east-1`;
  const result = await callMcpTool(endpoint, 'catalog.sources', {}, 1000);

  assert.equal(result.ok, false);
  assert.match(result.message, /credential REDACTED/);
  assert.match(result.message, /x-api-key=REDACTED/);
  assert.match(result.message, /region=REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /querysecret|us-east-1/);
});

test('monitor MCP tool-level failures redact endpoint credentials from structured results', async (t) => {
  const server = http.createServer(async (req, res) => {
    const request = await readJsonRequest(req);
    const echoedMessage = `Unauthorized request ${req.url}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: echoedMessage }],
        structuredContent: { error: 'fetch_failed', message: echoedMessage }
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp?access_token=querysecret`;
  const result = await callMcpTool(endpoint, 'raw.fetch', {}, 1000);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'fetch_failed');
  assert.match(result.data.message, /access_token=REDACTED/);
  assert.match(result.message, /access_token=REDACTED/);
  assert.match(result.raw.content[0].text, /access_token=REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /querysecret/);
});

test('content-only MCP tool errors propagate a redacted monitor error', async (t) => {
  const server = http.createServer(async (req, res) => {
    const request = await readJsonRequest(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Upstream failed for credential querysecret at ${req.url}`
        }]
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp?access_token=querysecret`;
  const result = await callMcpTool(endpoint, 'signals.list', {}, 1000);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'mcp_tool_error');
  assert.equal(result.data, null);
  assert.match(result.message, /credential REDACTED/);
  assert.match(result.message, /access_token=REDACTED/);
  assert.match(result.raw.content[0].text, /credential REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /querysecret/);
});

test('MCP event streams ignore notifications until the matching response arrives', async (t) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progress: 0.5 }
      })}\n\n`);
      res.end(`data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'matching tool failure' }
      })}\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const result = await callMcpTool(`http://127.0.0.1:${port}/mcp`, 'signals.list', {}, 1000);

  assert.equal(result.ok, false);
  assert.equal(result.message, 'matching tool failure');
  assert.equal(result.error, 'matching tool failure');
});

test('non-SSE MCP responses reject stale ids and notification-shaped results', async (t) => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    const request = await readJsonRequest(req);
    requestCount += 1;
    const response = requestCount === 2
      ? {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          result: { structuredContent: { items: [{ title: 'notification evidence' }] } }
        }
      : {
          jsonrpc: '2.0',
          id: request.id - 1,
          result: { structuredContent: { items: [{ title: 'stale evidence' }] } }
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const result = await callMcpTool(`http://127.0.0.1:${port}/mcp`, 'signals.list', {}, 1000);

  assert.equal(requestCount, 3);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_response');
  assert.equal(result.data, null);
  assert.doesNotMatch(JSON.stringify(result), /stale evidence|notification evidence/);
});

test('shaped non-success MCP responses remain audit-visible failures', async (t) => {
  const server = http.createServer(async (req, res) => {
    const request = await readJsonRequest(req);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        structuredContent: { items: [{ title: 'stale shaped payload' }] }
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const result = await callMcpTool(`http://127.0.0.1:${port}/mcp`, 'signals.list', {}, 1000);

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'http_503');
  assert.match(result.message, /HTTP 503/);
});

test('monitor MCP result redaction does not corrupt ordinary semantic selector text', async (t) => {
  const server = http.createServer(async (req, res) => {
    const request = await readJsonRequest(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        structuredContent: {
          items: [{
            title: 'Russia status',
            source: 'USGS',
            apiKey: 'result-api-secret',
            accessToken: 'result-access-secret',
            authorization: 'Bearer result-auth-secret'
          }],
          request: req.url
        }
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp?region=us&access_token=us&client_secret=status`;
  const result = await callMcpTool(endpoint, 'signals.list', {}, 1000);

  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].title, 'Russia status');
  assert.equal(result.data.items[0].source, 'USGS');
  assert.equal(result.data.items[0].apiKey, 'REDACTED');
  assert.equal(result.data.items[0].accessToken, 'REDACTED');
  assert.equal(result.data.items[0].authorization, 'REDACTED');
  assert.match(result.data.request, /region=REDACTED/);
  assert.match(result.data.request, /access_token=REDACTED/);
  assert.match(result.data.request, /client_secret=REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /result-(?:api|access|auth)-secret/);
});

test('audit raw fetch format requests text for CSV and RSS feeds only', () => {
  assert.equal(getRawFetchFormat('csv'), 'text');
  assert.equal(getRawFetchFormat('rss'), 'text');
  assert.equal(getRawFetchFormat('json'), 'json');
  assert.equal(getRawFetchFormat(undefined), 'json');
});

test('monitoring entry derives defaults for feeds without explicit overrides', () => {
  const feed = {
    id: 'example-feed',
    name: 'Example Feed',
    category: 'news',
    format: 'rss',
    supportsQuery: true,
    defaultQuery: 'alerts',
    ttlMinutes: 30
  };
  const entry = resolveMonitoringEntry(feed, {}, { defaultRefreshMinutes: 60 });
  assert.equal(entry.tier, 'standard');
  assert.equal(entry.auditEnabled, true);
  assert.equal(entry.docsUrl, null);
  assert.equal(entry.freshnessWindowMinutes, 90);
  assert.equal(entry.timeoutMs, 30000);
  assert.deepEqual(buildDefaultSampleParams(feed), { query: 'alerts' });
  assert.ok(entry.invariants.includes('rss-structure'));
});

test('monitoring entry honors audit exclusions and per-feed timeout overrides', () => {
  const feed = {
    id: 'connector-feed',
    name: 'Connector Feed',
    category: 'gov',
    format: 'json',
    ttlMinutes: 60
  };
  const entry = resolveMonitoringEntry(feed, {
    auditEnabled: false,
    timeoutMs: 45000
  }, { defaultRefreshMinutes: 60 });
  assert.equal(entry.auditEnabled, false);
  assert.equal(entry.timeoutMs, 45000);
});

test('monitoring overrides pin widened freshness windows for known slow-cadence feeds', () => {
  const monitoring = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed-monitoring.json'), 'utf8'));
  assert.equal(monitoring['gdelt-doc'].timeoutMs, 60000);
  assert.equal(monitoring['cdc-travel-notices'].freshnessWindowMinutes, 31680);
  assert.equal(monitoring['eonet-events'].freshnessWindowMinutes, 10080);
  assert.equal(monitoring['pbs-headlines'].freshnessWindowMinutes, 1440);
  assert.equal(monitoring['bbc-world'].freshnessWindowMinutes, 480);
  assert.equal(monitoring['state-legislation'].freshnessWindowMinutes, 2880);
  assert.equal(monitoring['state-legislation'].timeoutMs, 60000);
  assert.equal(monitoring['bls-cpi'].timeoutMs, 60000);
  assert.equal(monitoring['congress-api'].freshnessWindowMinutes, 2880);
  assert.equal(monitoring['congress-api'].timeoutMs, 60000);
  assert.equal(monitoring['congress-api'].changelogUrl, 'https://raw.githubusercontent.com/LibraryOfCongress/api.congress.gov/main/ChangeLog.md');
  assert.equal(monitoring['congress-api'].supportUrl, 'https://raw.githubusercontent.com/LibraryOfCongress/api.congress.gov/main/README.md');
  assert.equal(monitoring['congress-reports'].changelogUrl, 'https://raw.githubusercontent.com/LibraryOfCongress/api.congress.gov/main/ChangeLog.md');
  assert.equal(monitoring['congress-reports'].supportUrl, 'https://raw.githubusercontent.com/LibraryOfCongress/api.congress.gov/main/README.md');
  assert.equal(monitoring['congress-reports'].freshnessWindowMinutes, 4320);
  assert.equal(monitoring['congress-treaties'].timeoutMs, 60000);
  assert.equal(monitoring['eia-today'].freshnessWindowMinutes, 10080);
  assert.equal(monitoring['fda-medwatch'].freshnessWindowMinutes, 4320);
  assert.equal(monitoring['fda-medwatch'].timeoutMs, 60000);
  assert.equal(monitoring['nasa-firms'].freshnessWindowMinutes, 240);
  assert.equal(monitoring['nasa-firms'].timeoutMs, 60000);
  assert.equal(monitoring['google-news-us'].staticSnapshotLagWindowMinutes, 240);
  assert.equal(monitoring['usgs-quakes-hour'].staticSnapshotLagWindowMinutes, 180);
  assert.ok(monitoring['treasury-debt'].knownUpstreamQuirks.some((quirk) => quirk.id === 'treasury-debt-feed-stale-transient'));
  assert.ok(monitoring['treasury-debt'].knownUpstreamQuirks.some((quirk) => quirk.id === 'treasury-debt-fallback-engaged-transient'));
  assert.equal(monitoring['stooq-quote'].docsUrl, null);
  assert.equal(monitoring['stooq-quote'].supportUrl, null);
  assert.equal(monitoring['stooq-quote'].sampleParams.query, 'aapl.us');
  assert.ok(monitoring['stooq-quote'].knownUpstreamQuirks.some((quirk) => quirk.id === 'stooq-quote-feed-fetch-transient'));
  assert.ok(monitoring['stooq-quote'].knownUpstreamQuirks.some((quirk) => quirk.id === 'stooq-quote-source-deprecated-http404'));
  assert.ok(monitoring['stooq-quote'].knownUpstreamQuirks.some((quirk) => quirk.id === 'stooq-quote-fallback-engaged-transient'));
  assert.equal(monitoring['state-travel-advisories'].docsUrl, null);
  assert.equal(monitoring['state-travel-advisories'].supportUrl, null);
  assert.ok(monitoring['eonet-events'].knownUpstreamQuirks.some((quirk) => quirk.id === 'eonet-events-feed-stale-transient'));
  assert.ok(monitoring['eonet-events'].knownUpstreamQuirks.some((quirk) => quirk.id === 'eonet-events-fallback-engaged-transient'));
  assert.ok(monitoring['energy-eia'].knownUpstreamQuirks.some((quirk) => quirk.id === 'energy-eia-support-surface-volatility'));
  assert.ok(monitoring['energy-eia'].knownUpstreamQuirks.some((quirk) => quirk.id === 'energy-eia-docs-contract-keyword-noise'));
  assert.ok(monitoring['gdelt-doc'].knownUpstreamQuirks.some((quirk) => quirk.id === 'gdelt-signals-http403-transient'));
  assert.ok(monitoring['gdelt-doc'].knownUpstreamQuirks.some((quirk) => quirk.id === 'gdelt-feed-http500-transient'));
  assert.ok(monitoring['gdelt-doc'].knownUpstreamQuirks.some((quirk) => quirk.id === 'gdelt-feed-html-json-parse-transient'));
  assert.ok(monitoring['gdelt-doc'].knownUpstreamQuirks.some((quirk) => quirk.id === 'gdelt-fallback-engaged-transient'));
  assert.equal(monitoring['blockstream-mempool'].knownUpstreamQuirks[0].id, 'blockstream-fallback-engaged-transient');
  assert.equal(monitoring['transport-opensky'].knownUpstreamQuirks[0].id, 'opensky-signals-timeout-transient');
  assert.ok(monitoring['transport-opensky'].knownUpstreamQuirks.some((quirk) => quirk.id === 'opensky-feed-http502-transient'));
  assert.ok(monitoring['transport-opensky'].knownUpstreamQuirks.some((quirk) => quirk.id === 'opensky-fallback-engaged-transient'));
  assert.equal(monitoring['nws-alerts'].knownUpstreamQuirks[0].id, 'nws-docs-contract-keyword-noise');
  assert.deepEqual(
    monitoring['energy-eia'].acceptedSurfaceHashes.support['https://www.eia.gov/opendata/'],
    [
      '5062524fcefa96b4d9dbff29c6c99469ca704224501a36c7e2ef2035228f9f13',
      '99e7f6ebd194c4723639d07a8b184c92835039cbb602ca746e2fda21db1d4d46',
      '4998fe189750185f982d1b96e65ed006e3603738a02c8e1e13e5a6152d24deb0',
      'b594c1084497aab341e240ad2237b7beb73a98fe0a6590093ae6c154a5cef099',
      'd580c34939a932c392e6c6bb3ec5872827b6a3996ed841c13fbc260918266c31',
      '4f012b4d41bbe2b16ebfbc5ef435b2970c153be448b202e207ff50249238753c'
    ]
  );
});

test('Stooq feed registry carries a default quote for static and fallback builds', () => {
  const feeds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feeds.json'), 'utf8'));
  const feed = feeds.feeds.find((entry) => entry.id === 'stooq-quote');
  assert.ok(feed);
  assert.equal(feed.defaultQuery, 'aapl.us');
});

test('ArcGIS kinetic Europe feed uses the current published feature layer', () => {
  const feeds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feeds.json'), 'utf8'));
  const feed = feeds.feeds.find((entry) => entry.id === 'arcgis-kinetic-europe');
  assert.ok(feed);
  assert.ok(feed.url.includes('Kinetic_Activity_Tracker_Europe/FeatureServer/22/query'));
  assert.equal(feed.url.includes('FeatureServer/1/query'), false);
});

test('monitoring entry carries accepted doc surface hashes into document surfaces', () => {
  const entry = resolveMonitoringEntry({
    id: 'cisa-kev',
    name: 'CISA KEV',
    category: 'cyber',
    format: 'json',
    ttlMinutes: 60
  }, {
    docsUrl: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    acceptedSurfaceHashes: {
      docs: {
        'https://www.cisa.gov/known-exploited-vulnerabilities-catalog': 'abc123'
      }
    }
  }, { defaultRefreshMinutes: 60 });
  const surfaces = collectDocumentSurfaces([entry]);
  assert.deepEqual(surfaces[0].acceptedHashes, ['abc123']);
});

test('document surfaces accept multiple known hashes for nondeterministic docs pages', () => {
  const entry = resolveMonitoringEntry({
    id: 'nws-alerts',
    name: 'NWS Alerts',
    category: 'weather',
    format: 'json',
    ttlMinutes: 60
  }, {
    docsUrl: 'https://www.weather.gov/documentation/services-web-api',
    acceptedSurfaceHashes: {
      docs: {
        'https://www.weather.gov/documentation/services-web-api': ['hash-a', 'hash-b']
      }
    }
  }, { defaultRefreshMinutes: 60 });
  const surfaces = collectDocumentSurfaces([entry]);
  assert.deepEqual(surfaces[0].acceptedHashes, ['hash-a', 'hash-b']);
});

test('documentation watch pins reviewed provider surfaces without accepting unknown contracts', () => {
  const feeds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feeds.json'), 'utf8'));
  const monitoring = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed-monitoring.json'), 'utf8'));
  const ids = [
    'cdc-travel-notices',
    'cisa-kev',
    'congress-api',
    'congress-reports',
    'eonet-events',
    'fda-medwatch',
    'nasa-firms',
    'swpc-json',
    'swpc-kp'
  ];
  const entries = ids.map((id) => resolveMonitoringEntry(
    feeds.feeds.find((feed) => feed.id === id),
    monitoring[id],
    feeds.app
  ));
  const surfaces = new Map(collectDocumentSurfaces(entries).map((surface) => [surface.key, surface]));
  const reviewed = {
    'docs:https://wwwnc.cdc.gov/travel/page/rss': 'e293b5588b81013d510b34e4e81b6c384c20ee97becee4f29545ecce8f6cb6bb',
    'support:https://wwwnc.cdc.gov/travel/page/rss': 'e293b5588b81013d510b34e4e81b6c384c20ee97becee4f29545ecce8f6cb6bb',
    'docs:https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities_schema.json': '6f5524d5e9e88d67c28a328218b8e738d3f39e546cd16de738d4a14467e64428',
    'changelog:https://raw.githubusercontent.com/LibraryOfCongress/api.congress.gov/main/ChangeLog.md': '1422c9786e0dcf4d43ec123a89bf6942a8c025eb2405b20ce5668709b705f45b',
    'changelog:https://eonet.gsfc.nasa.gov/docs/changelog': [
      '49580a5d25f8e5c9572a837a2864e32ac55af8d7d9ae0b0535125bc8f54802cd',
      '25dd249e56e60ef468bb8c2fec5882b5369b7ecbf13204063a826a15e3b736bb'
    ],
    'docs:https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program/medwatch-rss-feed': '2a7da19e9ee0ac8f1604d20fa1ad80fe2201a4a947da1f05514237b5e0e97b2b',
    'support:https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program/medwatch-rss-feed': '2a7da19e9ee0ac8f1604d20fa1ad80fe2201a4a947da1f05514237b5e0e97b2b',
    'docs:https://firms.modaps.eosdis.nasa.gov/api/': '30c7c7b22b2525de16a6478a8c69ea2aeb839f16d642ab6f608474ea85b254da',
    'docs:https://services.swpc.noaa.gov/text/scn/fy26-03/solar-wind-speed.json': 'bdba7f8f67fc652f56a323d73ee2d66a1e833b344532b19e8d3bb721f104c74e',
    'docs:https://services.swpc.noaa.gov/text/scn/fy22-kp/10-102_planetary_k_index_1m_sample.json': '3887f823dbf795a7dd4c02c66a3917172b382ee12cba9b241e32212968a4911a'
  };

  for (const [key, hashes] of Object.entries(reviewed)) {
    const expectedHashes = Array.isArray(hashes) ? hashes : [hashes];
    assert.deepEqual(surfaces.get(key)?.acceptedHashes, expectedHashes, key);
    assert.equal(surfaces.get(key)?.acceptedHashes.includes('unknown-contract-hash'), false, key);
  }

  for (const key of Object.keys(reviewed).filter((key) => (
    key.includes('cdc.gov/travel/page/rss')
    || key.includes('known_exploited_vulnerabilities_schema.json')
    || key.includes('eonet.gsfc.nasa.gov/docs/changelog')
    || key.includes('firms.modaps.eosdis.nasa.gov/api/')
    || key.includes('medwatch-rss-feed')
    || key.includes('services.swpc.noaa.gov/text/scn')
  ))) {
    assert.equal(surfaces.get(key)?.enforceAcceptedHashes, true, key);
  }

  for (const obsoleteKey of [
    'docs:https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    'support:https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    'docs:https://eonet.gsfc.nasa.gov/docs/v3',
    'support:https://eonet.gsfc.nasa.gov/',
    'docs:https://www.spaceweather.gov/products/solar-wind',
    'support:https://www.spaceweather.gov/products/solar-wind',
    'docs:https://www.spaceweather.gov/products/planetary-k-index',
    'support:https://www.spaceweather.gov/products/planetary-k-index'
  ]) {
    assert.equal(surfaces.has(obsoleteKey), false, obsoleteKey);
  }

  assert.ok(monitoring['swpc-json'].invariants.includes('swpc-solar-wind-contract'));
  assert.ok(monitoring['swpc-kp'].invariants.includes('swpc-kp-contract'));

  assert.deepEqual(classifyDocChange({
    previous: null,
    current: {
      hash: 'unknown-contract-hash',
      normalizedText: 'A required schema field was removed.'
    },
    surfaceType: 'docs',
    tier: 'core',
    acceptedHashRequired: true
  }), {
    regressionClass: 'docs-contract-change',
    severity: 'critical',
    message: 'Official docs or changelog includes contract-change keywords.'
  });

  assert.equal(classifyDocChange({
    previous: null,
    current: {
      hash: 'first-unpinned-hash',
      normalizedText: 'A required schema field was removed.'
    },
    surfaceType: 'docs',
    tier: 'core'
  }), null);
});

test('feed proxy deploy workflow injects OpenSky credentials', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'deploy-feed-proxy.yml'), 'utf8');
  assert.match(workflow, /OPENSKY_CLIENTID:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTID\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTSECRET\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTID=opensky-clientid:latest/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET=opensky-clientsecret:latest/);
});

test('mcp proxy deploy workflow injects OpenSky credentials', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'deploy-mcp-proxy.yml'), 'utf8');
  assert.match(workflow, /OPENSKY_CLIENTID:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTID\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET:\s*\$\{\{\s*secrets\.OPENSKY_CLIENTSECRET\s*\}\}/);
  assert.match(workflow, /OPENSKY_CLIENTID=opensky-clientid:latest/);
  assert.match(workflow, /OPENSKY_CLIENTSECRET=opensky-clientsecret:latest/);
});

test('pages deploy workflow validates required static build secrets', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
  assert.match(workflow, /Missing required secret: EIA/);
  assert.match(workflow, /Missing required secret: OPENSTATES/);
});

test('scheduled monitor workflow serializes runs and restores durable baseline state', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'monitor-data-streams.yml'), 'utf8');
  assert.match(workflow, /concurrency:\s*\n\s+group: monitor-data-streams\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /SR_MONITOR_BASELINE_DIR:\s*\$\{\{\s*github\.workspace\s*\}\}\/\.monitor-state/);
  assert.match(workflow, /uses: actions\/cache\/restore@v5/);
  assert.match(workflow, /uses: actions\/cache\/save@v5/);
  assert.doesNotMatch(workflow, /uses: actions\/cache@v5/);
  assert.match(workflow, /path: \.monitor-state/);
  assert.match(workflow, /key: data-monitor-baseline-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(workflow, /restore-keys:\s*\|\s*\n\s+data-monitor-baseline-\$\{\{\s*runner\.os\s*\}\}-/);
  assert.match(workflow, /Save durable monitor baseline\s*\n\s+if: success\(\) && github\.event_name == 'schedule' && github\.run_attempt == 1\s*\n\s+uses: actions\/cache\/save@v5/);
  assert.match(workflow, /Upload monitor artifacts\s*\n\s+if: success\(\)/);
  assert.match(workflow, /analysis\/monitor\/latest-commit\.json/);
  assert.match(workflow, /name: data-monitor-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/);
});

test('doc alerts apply per-feed known upstream quirks', () => {
  const runSource = fs.readFileSync(path.join(process.cwd(), 'analysis', 'monitor', 'lib', 'run.mjs'), 'utf8');
  assert.match(runSource, /applyKnownUpstreamQuirks\(createAlert\(/);
  assert.match(runSource, /const docAlerts = buildDocAlerts\(comparedDocResults, entriesById\)/);
  assert.match(runSource, /base: baselineScope\.base/);
  assert.match(runSource, /publicationJournalPath,/);
  assert.match(runSource, /previousBaselineSnapshot/);
  assert.match(runSource, /recoverMonitorPublicationJournalUnderLock/);
  assert.match(runSource, /recoverMonitorPublications\(\{ baselineDir: cli\.baselineDir \}\)/);
  assert.match(runSource, /monitorPublicationLockPath\(cli\.baselineDir\)/);
  assert.match(runSource, /monitorPublicationHeadPath\(cli\.baselineDir\)/);
  assert.match(runSource, /writeJson\(stageArtifacts\.latestJson\.stagedPath/);
});

test('document helpers normalize content, extract dates, and classify contract changes', () => {
  const html = fixture('docs-contract.html');
  const normalized = normalizeDocText(html, 'text/html');
  assert.match(normalized, /Breaking schema change/i);
  const dated = extractDatedEntries(html);
  assert.equal(dated[0].date, 'April 1, 2026');
  const classification = classifyDocChange({
    previous: { hash: 'old' },
    current: { hash: 'new', normalizedText: normalized },
    surfaceType: 'changelog',
    tier: 'core'
  });
  assert.equal(classification.regressionClass, 'docs-contract-change');
  assert.equal(classification.severity, 'critical');
});

test('document surfaces dedupe shared URLs across feeds', () => {
  const surfaces = collectDocumentSurfaces([
    { id: 'congress-api', tier: 'core', docsUrl: 'https://api.congress.gov/', changelogUrl: null, statusUrl: null, supportUrl: null },
    { id: 'congress-reports', tier: 'core', docsUrl: 'https://api.congress.gov/', changelogUrl: null, statusUrl: null, supportUrl: null }
  ]);
  assert.equal(surfaces.length, 1);
  assert.deepEqual(surfaces[0].feedIds.sort(), ['congress-api', 'congress-reports']);
  assert.equal(surfaces[0].representativeFeedId, 'congress-api');
});

test('known quirks downgrade alerts and alert diffs suppress repeated known issues', () => {
  const alert = createAlert({
    feedId: 'congress-reports',
    regressionClass: 'committee-report-sort-health',
    severity: 'critical',
    message: 'Committee report asc/desc top citations are identical.'
  });
  const downgraded = applyKnownUpstreamQuirks(alert, [{
    id: 'committee-report-sort-degraded',
    regressionClass: 'committee-report-sort-health',
    severity: 'warning',
    suppressNew: true,
    note: 'Known upstream issue.'
  }]);
  assert.equal(downgraded.severity, 'warning');
  const deduped = dedupeAlerts([downgraded, downgraded]);
  assert.equal(deduped.length, 1);
  const deltas = diffAlerts(deduped, [downgraded]);
  assert.equal(deltas.newAlerts.length, 0);
});

test('static snapshot stale severity is bounded by the configured static lag window', () => {
  const entry = {
    id: 'usgs-quakes-hour',
    freshnessWindowMinutes: 60,
    staticSnapshotLagWindowMinutes: 180
  };
  const liveSummary = { newestTimestamp: Date.parse('2026-05-16T13:00:00Z'), rawItemCount: 5 };
  const normalLagSummary = { newestTimestamp: Date.parse('2026-05-16T11:45:00Z'), rawItemCount: 4 };
  const stalledSummary = { newestTimestamp: Date.parse('2026-05-16T09:30:00Z'), rawItemCount: 4 };

  const normalLagAlert = compareStaticSnapshot(entry, liveSummary, normalLagSummary);
  assert.equal(normalLagAlert.regressionClass, 'static-snapshot-stale');
  assert.equal(normalLagAlert.severity, 'info');
  assert.equal(normalLagAlert.metadata.staticSnapshotLagWindowMinutes, 180);

  const stalledAlert = compareStaticSnapshot(entry, liveSummary, stalledSummary);
  assert.equal(stalledAlert.regressionClass, 'static-snapshot-stale');
  assert.equal(stalledAlert.severity, 'warning');
});

test('Google News static snapshot lag uses the resolved monitoring override', () => {
  const feeds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feeds.json'), 'utf8'));
  const monitoring = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed-monitoring.json'), 'utf8'));
  const feed = feeds.feeds.find((entry) => entry.id === 'google-news-us');
  const entry = resolveMonitoringEntry(feed, monitoring['google-news-us'], { defaultRefreshMinutes: feeds.defaultRefreshMinutes });
  const liveSummary = { newestTimestamp: Date.parse('2026-05-27T13:00:00Z'), rawItemCount: 5 };
  const expectedLagSummary = { newestTimestamp: Date.parse('2026-05-27T09:30:00Z'), rawItemCount: 5 };
  const staleSummary = { newestTimestamp: Date.parse('2026-05-27T08:00:00Z'), rawItemCount: 5 };

  assert.equal(entry.staticSnapshotLagWindowMinutes, 240);

  const expectedLagAlert = compareStaticSnapshot(entry, liveSummary, expectedLagSummary);
  assert.equal(expectedLagAlert.regressionClass, 'static-snapshot-stale');
  assert.equal(expectedLagAlert.severity, 'info');
  assert.equal(expectedLagAlert.metadata.staticSnapshotLagWindowMinutes, 240);

  const staleAlert = compareStaticSnapshot(entry, liveSummary, staleSummary);
  assert.equal(staleAlert.regressionClass, 'static-snapshot-stale');
  assert.equal(staleAlert.severity, 'warning');
});

test('monitoring config quirks downgrade recent Google News and Congress doc noise', () => {
  const monitoring = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed-monitoring.json'), 'utf8'));

  const googleNewsAlert = createAlert({
    feedId: 'google-news-us',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Published live-cache snapshot satisfied the request.'
  });
  const downgradedGoogleNewsAlert = applyKnownUpstreamQuirks(
    googleNewsAlert,
    monitoring['google-news-us'].knownUpstreamQuirks
  );
  assert.equal(downgradedGoogleNewsAlert.severity, 'info');
  assert.equal(downgradedGoogleNewsAlert.suppressNew, true);
  assert.match(downgradedGoogleNewsAlert.message, /live-cache snapshot/i);

  const congressDocsAlert = createAlert({
    feedId: 'congress-api',
    regressionClass: 'docs-fetch-failed',
    severity: 'warning',
    message: 'Failed to fetch Congress API support page.'
  });
  const downgradedCongressDocsAlert = applyKnownUpstreamQuirks(
    congressDocsAlert,
    monitoring['congress-api'].knownUpstreamQuirks
  );
  assert.equal(downgradedCongressDocsAlert.severity, 'info');
  assert.equal(downgradedCongressDocsAlert.suppressNew, true);
  assert.match(downgradedCongressDocsAlert.message, /informational unless the primary api\.congress\.gov docs surface also regresses/i);

  const energyEiaSupportAlert = createAlert({
    feedId: 'energy-eia',
    regressionClass: 'support-surface-updated',
    severity: 'warning',
    message: 'Official support surface changed.'
  });
  const downgradedEnergyEiaSupportAlert = applyKnownUpstreamQuirks(
    energyEiaSupportAlert,
    monitoring['energy-eia'].knownUpstreamQuirks
  );
  assert.equal(downgradedEnergyEiaSupportAlert.severity, 'info');
  assert.equal(downgradedEnergyEiaSupportAlert.suppressNew, true);
  assert.equal(downgradedEnergyEiaSupportAlert.knownQuirkId, 'energy-eia-support-surface-volatility');

  const treasuryDebtStaleAlert = createAlert({
    feedId: 'treasury-debt',
    regressionClass: 'feed-stale',
    severity: 'warning',
    message: 'Feed proxy returned stale data.'
  });
  const downgradedTreasuryDebtStaleAlert = applyKnownUpstreamQuirks(
    treasuryDebtStaleAlert,
    monitoring['treasury-debt'].knownUpstreamQuirks
  );
  assert.equal(downgradedTreasuryDebtStaleAlert.severity, 'info');
  assert.equal(downgradedTreasuryDebtStaleAlert.suppressNew, true);
  assert.equal(downgradedTreasuryDebtStaleAlert.knownQuirkId, 'treasury-debt-feed-stale-transient');

  const treasuryDebtFallbackAlert = createAlert({
    feedId: 'treasury-debt',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedTreasuryDebtFallbackAlert = applyKnownUpstreamQuirks(
    treasuryDebtFallbackAlert,
    monitoring['treasury-debt'].knownUpstreamQuirks
  );
  assert.equal(downgradedTreasuryDebtFallbackAlert.severity, 'info');
  assert.equal(downgradedTreasuryDebtFallbackAlert.suppressNew, true);
  assert.equal(downgradedTreasuryDebtFallbackAlert.knownQuirkId, 'treasury-debt-fallback-engaged-transient');

  const openSkyFetchAlert = createAlert({
    feedId: 'transport-opensky',
    regressionClass: 'feed-fetch-failed',
    severity: 'warning',
    message: 'HTTP 502'
  });
  const downgradedOpenSkyFetchAlert = applyKnownUpstreamQuirks(
    openSkyFetchAlert,
    monitoring['transport-opensky'].knownUpstreamQuirks
  );
  assert.equal(downgradedOpenSkyFetchAlert.severity, 'info');
  assert.equal(downgradedOpenSkyFetchAlert.suppressNew, true);
  assert.equal(downgradedOpenSkyFetchAlert.knownQuirkId, 'opensky-feed-http502-transient');
  const openSkyFallbackAlert = createAlert({
    feedId: 'transport-opensky',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedOpenSkyFallbackAlert = applyKnownUpstreamQuirks(
    openSkyFallbackAlert,
    monitoring['transport-opensky'].knownUpstreamQuirks
  );
  assert.equal(downgradedOpenSkyFallbackAlert.severity, 'info');
  assert.equal(downgradedOpenSkyFallbackAlert.suppressNew, true);
  assert.equal(downgradedOpenSkyFallbackAlert.knownQuirkId, 'opensky-fallback-engaged-transient');

  const gdeltFallbackAlert = createAlert({
    feedId: 'gdelt-doc',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedGdeltFallbackAlert = applyKnownUpstreamQuirks(
    gdeltFallbackAlert,
    monitoring['gdelt-doc'].knownUpstreamQuirks
  );
  assert.equal(downgradedGdeltFallbackAlert.severity, 'info');
  assert.equal(downgradedGdeltFallbackAlert.suppressNew, true);
  assert.equal(downgradedGdeltFallbackAlert.knownQuirkId, 'gdelt-fallback-engaged-transient');

  const googleNewsSearchStaleAlert = createAlert({
    feedId: 'google-news-search',
    regressionClass: 'feed-stale',
    severity: 'warning',
    message: 'Feed proxy returned stale data.'
  });
  const downgradedGoogleNewsSearchStaleAlert = applyKnownUpstreamQuirks(
    googleNewsSearchStaleAlert,
    monitoring['google-news-search'].knownUpstreamQuirks
  );
  assert.equal(downgradedGoogleNewsSearchStaleAlert.severity, 'info');
  assert.equal(downgradedGoogleNewsSearchStaleAlert.suppressNew, true);
  assert.equal(downgradedGoogleNewsSearchStaleAlert.knownQuirkId, 'google-news-search-feed-stale-transient');

  const googleNewsUsStaleAlert = createAlert({
    feedId: 'google-news-us',
    regressionClass: 'feed-stale',
    severity: 'warning',
    message: 'Feed proxy returned stale data.'
  });
  const downgradedGoogleNewsUsStaleAlert = applyKnownUpstreamQuirks(
    googleNewsUsStaleAlert,
    monitoring['google-news-us'].knownUpstreamQuirks
  );
  assert.equal(downgradedGoogleNewsUsStaleAlert.severity, 'info');
  assert.equal(downgradedGoogleNewsUsStaleAlert.suppressNew, true);
  assert.equal(downgradedGoogleNewsUsStaleAlert.knownQuirkId, 'google-news-us-feed-stale-transient');

  const arxivAiStaleAlert = createAlert({
    feedId: 'arxiv-ai',
    regressionClass: 'feed-stale',
    severity: 'warning',
    message: 'Feed proxy returned stale data.'
  });
  const downgradedArxivAiStaleAlert = applyKnownUpstreamQuirks(
    arxivAiStaleAlert,
    monitoring['arxiv-ai'].knownUpstreamQuirks
  );
  assert.equal(downgradedArxivAiStaleAlert.severity, 'info');
  assert.equal(downgradedArxivAiStaleAlert.suppressNew, true);
  assert.equal(downgradedArxivAiStaleAlert.knownQuirkId, 'arxiv-ai-feed-stale-transient');

  const arxivAiFallbackAlert = createAlert({
    feedId: 'arxiv-ai',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedArxivAiFallbackAlert = applyKnownUpstreamQuirks(
    arxivAiFallbackAlert,
    monitoring['arxiv-ai'].knownUpstreamQuirks
  );
  assert.equal(downgradedArxivAiFallbackAlert.severity, 'info');
  assert.equal(downgradedArxivAiFallbackAlert.suppressNew, true);
  assert.equal(downgradedArxivAiFallbackAlert.knownQuirkId, 'arxiv-ai-fallback-engaged-transient');

  const arxivAiSignalsAlert = createAlert({
    feedId: 'arxiv-ai',
    regressionClass: 'signal-normalization-failed',
    severity: 'warning',
    message: 'This operation was aborted'
  });
  const downgradedArxivAiSignalsAlert = applyKnownUpstreamQuirks(
    arxivAiSignalsAlert,
    monitoring['arxiv-ai'].knownUpstreamQuirks
  );
  assert.equal(downgradedArxivAiSignalsAlert.severity, 'info');
  assert.equal(downgradedArxivAiSignalsAlert.suppressNew, true);
  assert.equal(downgradedArxivAiSignalsAlert.knownQuirkId, 'arxiv-ai-signals-timeout-transient');

  const energyEiaBrentFallbackAlert = createAlert({
    feedId: 'energy-eia-brent',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedEnergyEiaBrentFallbackAlert = applyKnownUpstreamQuirks(
    energyEiaBrentFallbackAlert,
    monitoring['energy-eia-brent'].knownUpstreamQuirks
  );
  assert.equal(downgradedEnergyEiaBrentFallbackAlert.severity, 'info');
  assert.equal(downgradedEnergyEiaBrentFallbackAlert.suppressNew, true);
  assert.equal(downgradedEnergyEiaBrentFallbackAlert.knownQuirkId, 'energy-eia-brent-fallback-engaged-transient');

  const stooqFetchAlert = createAlert({
    feedId: 'stooq-quote',
    regressionClass: 'feed-fetch-failed',
    severity: 'warning',
    message: 'fetch_failed'
  });
  const downgradedStooqFetchAlert = applyKnownUpstreamQuirks(
    stooqFetchAlert,
    monitoring['stooq-quote'].knownUpstreamQuirks
  );
  assert.equal(downgradedStooqFetchAlert.severity, 'info');
  assert.equal(downgradedStooqFetchAlert.suppressNew, true);
  assert.equal(downgradedStooqFetchAlert.knownQuirkId, 'stooq-quote-feed-fetch-transient');

  const stooqDeprecatedSignalAlert = createAlert({
    feedId: 'stooq-quote',
    regressionClass: 'signal-normalization-failed',
    severity: 'warning',
    message: 'HTTP 404'
  });
  const downgradedStooqDeprecatedSignalAlert = applyKnownUpstreamQuirks(
    stooqDeprecatedSignalAlert,
    monitoring['stooq-quote'].knownUpstreamQuirks
  );
  assert.equal(downgradedStooqDeprecatedSignalAlert.severity, 'info');
  assert.equal(downgradedStooqDeprecatedSignalAlert.suppressNew, true);
  assert.equal(downgradedStooqDeprecatedSignalAlert.knownQuirkId, 'stooq-quote-source-deprecated-http404');

  const stooqParserSignalAlert = createAlert({
    feedId: 'stooq-quote',
    regressionClass: 'signal-normalization-failed',
    severity: 'warning',
    message: 'CSV headers missing Symbol and Close'
  });
  const retainedStooqParserSignalAlert = applyKnownUpstreamQuirks(
    stooqParserSignalAlert,
    monitoring['stooq-quote'].knownUpstreamQuirks
  );
  assert.equal(retainedStooqParserSignalAlert.severity, 'warning');
  assert.equal(retainedStooqParserSignalAlert.knownQuirkId, undefined);

  const stooqFallbackAlert = createAlert({
    feedId: 'stooq-quote',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedStooqFallbackAlert = applyKnownUpstreamQuirks(
    stooqFallbackAlert,
    monitoring['stooq-quote'].knownUpstreamQuirks
  );
  assert.equal(downgradedStooqFallbackAlert.severity, 'info');
  assert.equal(downgradedStooqFallbackAlert.suppressNew, true);
  assert.equal(downgradedStooqFallbackAlert.knownQuirkId, 'stooq-quote-fallback-engaged-transient');

  const eonetStaleAlert = createAlert({
    feedId: 'eonet-events',
    regressionClass: 'feed-stale',
    severity: 'warning',
    message: 'Feed proxy returned stale data.'
  });
  const downgradedEonetStaleAlert = applyKnownUpstreamQuirks(
    eonetStaleAlert,
    monitoring['eonet-events'].knownUpstreamQuirks
  );
  assert.equal(downgradedEonetStaleAlert.severity, 'info');
  assert.equal(downgradedEonetStaleAlert.suppressNew, true);
  assert.equal(downgradedEonetStaleAlert.knownQuirkId, 'eonet-events-feed-stale-transient');

  const eonetFallbackAlert = createAlert({
    feedId: 'eonet-events',
    regressionClass: 'fallback-engaged',
    severity: 'warning',
    message: 'Fallback data path was used for this feed.'
  });
  const downgradedEonetFallbackAlert = applyKnownUpstreamQuirks(
    eonetFallbackAlert,
    monitoring['eonet-events'].knownUpstreamQuirks
  );
  assert.equal(downgradedEonetFallbackAlert.severity, 'info');
  assert.equal(downgradedEonetFallbackAlert.suppressNew, true);
  assert.equal(downgradedEonetFallbackAlert.knownQuirkId, 'eonet-events-fallback-engaged-transient');

  assert.equal(monitoring['guardian-world'].freshnessWindowMinutes, 480);
});

test('markdown report shows quirk-adjusted severity for changed official surfaces', () => {
  const markdown = buildMarkdownReport({
    mode: 'full',
    generatedAt: '2026-04-18T15:02:10.844Z',
    summary: { checkedFeeds: 91, totalFeeds: 91, critical: 0, warning: 0, info: 1 },
    deltas: { newAlerts: [], resolvedAlerts: [], ongoingAlerts: [] },
    alerts: [
      {
        feedId: 'nws-alerts',
        regressionClass: 'docs-contract-change',
        severity: 'info',
        message: 'Official docs or changelog includes contract-change keywords. https://www.weather.gov/documentation/services-web-api',
        metadata: {
          surfaceKey: 'changelog:https://www.weather.gov/documentation/services-web-api',
          url: 'https://www.weather.gov/documentation/services-web-api'
        }
      }
    ],
    feedResults: [],
    docResults: [
      {
        key: 'changelog:https://www.weather.gov/documentation/services-web-api',
        changed: true,
        surfaceType: 'changelog',
        url: 'https://www.weather.gov/documentation/services-web-api',
        classification: {
          severity: 'critical'
        }
      },
      {
        key: 'docs:https://www.weather.gov/documentation/services-web-api',
        changed: true,
        surfaceType: 'docs',
        url: 'https://www.weather.gov/documentation/services-web-api',
        classification: {
          severity: 'critical'
        }
      }
    ]
  });

  assert.match(markdown, /changelog https:\/\/www\.weather\.gov\/documentation\/services-web-api \(info\)/);
  assert.match(markdown, /docs https:\/\/www\.weather\.gov\/documentation\/services-web-api \(info\)/);
  assert.doesNotMatch(markdown, /changelog https:\/\/www\.weather\.gov\/documentation\/services-web-api \(critical\)/);
  assert.doesNotMatch(markdown, /docs https:\/\/www\.weather\.gov\/documentation\/services-web-api \(critical\)/);
});

test('RSS fixture is summarized correctly', () => {
  const feed = { id: 'google-news-us', format: 'rss' };
  const summary = summarizeProxyPayload(feed, {
    body: fixture('rss.xml'),
    contentType: 'application/rss+xml',
    httpStatus: 200
  }, {});
  assert.equal(summary.rawItemCount, 2);
  assert.equal(summary.error, null);
  assert.ok(summary.newestTimestamp);
});

test('GovInfo package arrays are summarized as raw items', () => {
  const feed = { id: 'govinfo-api', format: 'json' };
  const summary = summarizeProxyPayload(feed, {
    body: JSON.stringify({
      packages: [
        {
          packageId: 'CMR-1',
          title: 'Mandated report',
          lastModified: '2026-03-16T14:22:40Z'
        }
      ]
    }),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(summary.rawItemCount, 1);
  assert.equal(summary.parseError, null);
  assert.ok(summary.newestTimestamp);
});

test('monitor summaries honor snake_case update timestamps', () => {
  const feed = { id: 'state-legislation', format: 'json' };
  const updatedAt = '2026-04-10T06:13:39.839413+00:00';
  const latestActionDate = '2026-04-01';
  const summary = summarizeProxyPayload(feed, {
    body: JSON.stringify({
      results: [
        {
          title: 'State bill with newer update timestamp',
          updated_at: updatedAt,
          latest_action_date: latestActionDate
        }
      ]
    }),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(summary.newestTimestamp, Date.parse(updatedAt));
});

test('monitor summaries inspect Stooq CSV quote fields', () => {
  const feed = { id: 'stooq-quote', format: 'csv' };
  const summary = summarizeProxyPayload(feed, {
    body: 'Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-05-13,16:30:22,293.5,297.51,293.5,295.5,6106704\n',
    contentType: 'text/csv; charset=utf-8',
    httpStatus: 200
  }, {});
  assert.equal(summary.rawItemCount, 1);
  assert.equal(summary.parseError, null);
  assert.equal(summary.identifiers[0], 'AAPL.US');
  assert.equal(summary.newestTimestamp, Date.parse('2026-05-13T16:30:22Z'));

  const missingSummary = summarizeProxyPayload(feed, {
    body: 'Symbol,Date,Time,Open,High,Low,Close,Volume\nMONITORING,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n',
    contentType: 'text/csv; charset=utf-8',
    httpStatus: 200
  }, {});
  assert.equal(missingSummary.rawItemCount, 0);
});

test('monitor summaries inspect GeoJSON feature timestamps', () => {
  const feed = { id: 'usgs-quakes-hour', format: 'json' };
  const summary = summarizeProxyPayload(feed, {
    body: JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        id: 'nc75360036',
        properties: {
          title: 'M 1.2 - 7 km NW of The Geysers, CA',
          time: 1778683419930,
          updated: 1778683514046
        },
        geometry: {
          type: 'Point',
          coordinates: [-122.803833007812, 38.8283348083496, 1.8]
        }
      }]
    }),
    contentType: 'application/geo+json',
    httpStatus: 200
  }, {});
  assert.equal(summary.rawItemCount, 1);
  assert.equal(summary.newestTimestamp, 1778683419930);
  assert.equal(summary.identifiers[0], 'nc75360036');
});

test('deep-core invariants pass on valid fixtures and fail on state mismatch', () => {
  const openaqFeed = { id: 'openaq-api', format: 'json' };
  const openaqEntry = {
    id: 'openaq-api',
    tier: 'core',
    sampleParams: {}
  };
  const openaqSummary = summarizeProxyPayload(openaqFeed, {
    body: fixture('openaq.json'),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('openaq-meta-results', buildContext(openaqEntry, openaqSummary)), null);

  const eiaFeed = { id: 'energy-eia', format: 'json' };
  const eiaEntry = { id: 'energy-eia', tier: 'core', sampleParams: {} };
  const eiaSummary = summarizeProxyPayload(eiaFeed, {
    body: fixture('eia.json'),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('eia-response-data', buildContext(eiaEntry, eiaSummary)), null);

  const nwsFeed = { id: 'nws-alerts', format: 'json' };
  const nwsEntry = { id: 'nws-alerts', tier: 'core', sampleParams: {} };
  const nwsSummary = summarizeProxyPayload(nwsFeed, {
    body: fixture('nws.geojson'),
    contentType: 'application/geo+json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('nws-alert-geometry', buildContext(nwsEntry, nwsSummary)), null);

  const nasaFeed = { id: 'nasa-firms', format: 'json' };
  const nasaEntry = { id: 'nasa-firms', tier: 'core', sampleParams: {} };
  const nasaSummary = summarizeProxyPayload(nasaFeed, {
    body: JSON.stringify({
      items: [
        {
          title: 'Fire detection',
          geo: { lat: 34.1, lon: -118.2 },
          publishedAt: '2026-03-15T12:00:00Z'
        }
      ]
    }),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('geo-coordinates', buildContext(nasaEntry, nasaSummary, {
    error: null,
    count: 1,
    items: [{ geo: { lat: 34.1, lon: -118.2 }, publishedAt: '2026-03-15T12:00:00Z' }],
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  })), null);

  const stateSignals = parseFixture('state-legislation-signals.json').items;
  const stateEntry = {
    id: 'state-legislation',
    tier: 'core',
    sampleParams: {
      jurisdiction: 'ocd-jurisdiction/country:us/state:ny/government'
    }
  };
  assert.equal(evaluateInvariant('state-param-roundtrip', buildContext(stateEntry, eiaSummary, {
    error: null,
    count: stateSignals.length,
    items: stateSignals,
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  })), null);

  const mismatchAlert = evaluateInvariant('state-param-roundtrip', buildContext(stateEntry, eiaSummary, {
    error: null,
    count: 1,
    items: [{ jurisdictionCode: 'CA', publishedAt: '2026-03-15T12:00:00Z' }],
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  }));
  assert.equal(mismatchAlert.regressionClass, 'state-param-roundtrip');

  const sortAlert = evaluateInvariant('descending-update-sort', buildContext({
    id: 'congress-api',
    tier: 'core',
    sampleParams: {}
  }, eiaSummary, {
    error: null,
    count: 2,
    items: [
      { id: 'older', publishedAt: '2026-03-14T12:00:00Z' },
      { id: 'newer', publishedAt: '2026-03-15T12:00:00Z' }
    ],
    newestTimestamp: Date.parse('2026-03-15T12:00:00Z')
  }));
  assert.equal(sortAlert.regressionClass, 'descending-sort-broken');
});

test('SWPC product invariants preserve warnings for live wire-format failures', () => {
  const windEntry = { id: 'swpc-json', tier: 'standard', sampleParams: {} };
  const windSummary = summarizeProxyPayload(windEntry, {
    body: JSON.stringify([{
      time_tag: '2026-07-22T15:40:00',
      proton_speed: 435
    }]),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant(
    'swpc-solar-wind-contract',
    buildContext(windEntry, windSummary)
  ), null);

  const missingWindField = evaluateInvariant(
    'swpc-solar-wind-contract',
    buildContext(windEntry, summarizeProxyPayload(windEntry, {
      body: JSON.stringify([{ time_tag: '2026-07-22T15:40:00' }]),
      contentType: 'application/json',
      httpStatus: 200
    }, {}))
  );
  assert.equal(missingWindField.regressionClass, 'swpc-solar-wind-contract');
  assert.equal(missingWindField.severity, 'warning');

  const kpEntry = { id: 'swpc-kp', tier: 'standard', sampleParams: {} };
  const kpSummary = summarizeProxyPayload(kpEntry, {
    body: JSON.stringify([{
      time_tag: '2026-07-22T15:40:00',
      kp_index: 2,
      estimated_kp: 2.33,
      kp: '2P'
    }]),
    contentType: 'application/json',
    httpStatus: 200
  }, {});
  assert.equal(evaluateInvariant('swpc-kp-contract', buildContext(kpEntry, kpSummary)), null);

  const missingKpField = evaluateInvariant(
    'swpc-kp-contract',
    buildContext(kpEntry, summarizeProxyPayload(kpEntry, {
      body: JSON.stringify([{
        time_tag: '2026-07-22T15:40:00',
        kp_index: 2,
        estimated_kp: 2.33
      }]),
      contentType: 'application/json',
      httpStatus: 200
    }, {}))
  );
  assert.equal(missingKpField.regressionClass, 'swpc-kp-contract');
  assert.equal(missingKpField.severity, 'warning');
});
