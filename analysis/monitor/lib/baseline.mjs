import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MONITOR_BASELINE_SCHEMA_VERSION = 1;
export const MONITOR_PUBLICATION_SCHEMA_VERSION = 2;
export const MONITOR_PENDING_PUBLICATION_SCHEMA_VERSION = 1;

const MODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 60000;
const LOCK_OWNER_SCHEMA_VERSION = 1;
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR']);
const SEMANTIC_SCOPE_QUERY_KEYS = new Set([
  'bbox',
  'country',
  'dataset',
  'env',
  'environment',
  'feed',
  'format',
  'jurisdiction',
  'lang',
  'language',
  'lat',
  'latitude',
  'locale',
  'lon',
  'longitude',
  'mode',
  'region',
  'source',
  'state',
  'version'
]);
const CREDENTIAL_SCOPE_QUERY_KEY_PATTERNS = [
  /^(?:api_?key|apikey|key|x_api_key)$/,
  /^(?:app_?id|appid)$/,
  /^(?:access_?token|refresh_?token|id_?token|token)$/,
  /^(?:access_?key(?:_?id)?|accesskeyid)$/,
  /^(?:client_?secret|clientsecret)$/,
  /^(?:session_?(?:id|token|key)|sessionid)$/,
  /^(?:subscription_?(?:key|token)|subscriptionkey)$/,
  /^(?:auth_?(?:token|key|code)|authorization|bearer|jwt)$/,
  /^(?:secret(?:_?key)?|private_?key|credentials?|signature|sig|password|passwd|pwd)$/,
  /^x_(?:amz|goog)_(?:credential|signature|security_token|api_key)$/
];

export function defaultMonitorBaselineDir({
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  if (env.SR_MONITOR_BASELINE_DIR) {
    return path.resolve(env.SR_MONITOR_BASELINE_DIR);
  }
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(homeDir, '.local', 'state');
  return path.join(stateHome, 'the-situation-room-ai', 'monitor');
}

export function buildMonitorBaselineScope({
  base = '',
  mcp = '',
  staticBase = '',
  includeStatic = true,
  includeDocs = true,
  timeoutMs = 30000,
  scopeTag = ''
} = {}) {
  const identity = {
    base: String(base || ''),
    mcp: String(mcp || ''),
    staticBase: includeStatic ? String(staticBase || '') : null,
    includeStatic: Boolean(includeStatic),
    includeDocs: Boolean(includeDocs),
    timeoutMs: Number(timeoutMs),
    scopeTag: String(scopeTag || '')
  };
  const publicIdentity = {
    base: sanitizeEndpointDescriptor(identity.base),
    mcp: sanitizeEndpointDescriptor(identity.mcp),
    staticBase: sanitizeEndpointDescriptor(identity.staticBase),
    includeStatic: identity.includeStatic,
    includeDocs: identity.includeDocs,
    timeoutMs: identity.timeoutMs
  };
  const scopeIdentity = {
    ...publicIdentity,
    base: buildEndpointScopeDescriptor(identity.base, identity.scopeTag),
    mcp: buildEndpointScopeDescriptor(identity.mcp, identity.scopeTag),
    staticBase: buildEndpointScopeDescriptor(identity.staticBase, identity.scopeTag),
    scopeTag: identity.scopeTag || null
  };
  const id = crypto
    .createHash('sha256')
    .update(JSON.stringify(scopeIdentity))
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    base: publicIdentity.base,
    mcp: publicIdentity.mcp,
    staticBase: publicIdentity.staticBase,
    includeStatic: identity.includeStatic,
    includeDocs: identity.includeDocs,
    timeoutMs: identity.timeoutMs,
    rawIdentity: identity
  };
}

export function isCredentialScopeQueryKey(key) {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return CREDENTIAL_SCOPE_QUERY_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildEndpointScopeDescriptor(value, scopeTag = '') {
  if (!value) return value;
  try {
    const parsed = new URL(String(value));
    if (parsed.username) parsed.username = 'REDACTED';
    if (parsed.password) parsed.password = 'REDACTED';
    for (const key of parsed.searchParams.keys()) {
      const normalizedKey = key.toLowerCase();
      if (SEMANTIC_SCOPE_QUERY_KEYS.has(normalizedKey)) continue;
      if (isCredentialScopeQueryKey(key) || scopeTag) {
        parsed.searchParams.set(key, 'REDACTED');
        continue;
      }
      throw new Error(
        `Query parameter "${key}" needs an explicit --scope-tag so monitor baselines cannot collide`
      );
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    if (String(value).includes('?') && !scopeTag) {
      throw new Error(
        'Endpoint query parameters need a valid URL or an explicit --scope-tag'
      );
    }
    return sanitizeEndpointDescriptor(value);
  }
}

function sanitizeEndpointDescriptor(value) {
  if (!value) return value;
  try {
    const parsed = new URL(String(value));
    if (parsed.username) parsed.username = 'REDACTED';
    if (parsed.password) parsed.password = 'REDACTED';
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, 'REDACTED');
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(value)
      .replace(/^([^:/?#]+:\/\/)[^@/\s]+@/i, '$1REDACTED@')
      .replace(/([?&])([^=&#\s]+)=([^&\s]*)/g, '$1$2=REDACTED')
      .replace(/#.*$/, '');
  }
}

function serializableScope(scope = { id: 'default' }) {
  return {
    id: scope.id,
    base: scope.base ?? null,
    mcp: scope.mcp ?? null,
    staticBase: scope.staticBase ?? null,
    includeStatic: scope.includeStatic ?? null,
    includeDocs: scope.includeDocs ?? null,
    timeoutMs: scope.timeoutMs ?? null
  };
}

export function monitorBaselinePath(
  mode,
  baselineDir = defaultMonitorBaselineDir(),
  scopeId = 'default'
) {
  if (!MODE_PATTERN.test(String(mode || ''))) {
    throw new Error(`Invalid monitor mode for baseline path: ${mode}`);
  }
  if (!SCOPE_ID_PATTERN.test(String(scopeId || ''))) {
    throw new Error(`Invalid monitor scope for baseline path: ${scopeId}`);
  }
  return path.join(path.resolve(baselineDir), `${mode}.${scopeId}.json`);
}

export function monitorPublicationJournalPath(
  mode,
  baselineDir = defaultMonitorBaselineDir(),
  scopeId = 'default'
) {
  const baselinePath = monitorBaselinePath(mode, baselineDir, scopeId);
  return `${baselinePath.slice(0, -'.json'.length)}.publication-pending.json`;
}

export function monitorPublicationLockPath(
  baselineDir = defaultMonitorBaselineDir()
) {
  return path.join(path.resolve(baselineDir), '.monitor-publication.lock');
}

export function monitorPublicationHeadPath(
  baselineDir = defaultMonitorBaselineDir()
) {
  return path.join(path.resolve(baselineDir), 'publication-head.json');
}

function parseBaselineFile(filePath, mode, scopeId) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid monitor baseline JSON at ${filePath}: ${error.message}`);
  }

  if (
    parsed?.schemaVersion !== MONITOR_BASELINE_SCHEMA_VERSION
    || parsed?.mode !== mode
    || parsed?.scope?.id !== scopeId
    || !Array.isArray(parsed?.alerts)
    || !Array.isArray(parsed?.docResults)
  ) {
    throw new Error(`Invalid monitor baseline schema at ${filePath}; refusing to overwrite it`);
  }
  return parsed;
}

function readLegacyReport(filePath, mode, scope) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (
      parsed?.publicationSchemaVersion
      || parsed?.mode !== mode
      || !Array.isArray(parsed?.alerts)
      || !Array.isArray(parsed?.docResults)
    ) {
      return null;
    }
    const identity = scope?.rawIdentity || scope;
    if (identity && (
      parsed.base !== identity.base
      || parsed.mcp !== identity.mcp
      || (parsed.staticBase ?? null) !== identity.staticBase
      || !scope.includeDocs
      || parsed.docResults.length === 0
    )) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function loadMonitorBaseline(mode, {
  baselineDir = defaultMonitorBaselineDir(),
  legacyLatestPath = null,
  allowLegacyMigration = false,
  scope = { id: 'default' }
} = {}) {
  const filePath = monitorBaselinePath(mode, baselineDir, scope.id);
  const durable = parseBaselineFile(filePath, mode, scope.id);
  if (durable) {
    return { report: durable, source: 'durable', filePath };
  }

  if (allowLegacyMigration) {
    const legacy = readLegacyReport(legacyLatestPath, mode, scope);
    if (legacy) {
      return { report: legacy, source: 'legacy-latest', filePath };
    }
  }

  return { report: null, source: 'empty', filePath };
}

function compactDocResults(currentResults = [], previousResults = []) {
  const previousByKey = new Map(previousResults.map((result) => [result.key, result]));
  return currentResults.map((result) => ({
    key: result.key,
    hash: result.hash || previousByKey.get(result.key)?.hash || null
  }));
}

function readLockSnapshot(lockPath) {
  let directoryBefore;
  let directoryAfter;
  let ownerBefore;
  let ownerAfter;
  let owner;
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
  try {
    directoryBefore = fs.lstatSync(lockPath);
    ownerBefore = fs.lstatSync(ownerPath);
    owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    ownerAfter = fs.lstatSync(ownerPath);
    directoryAfter = fs.lstatSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
  if (
    !directoryBefore.isDirectory()
    || !directoryAfter.isDirectory()
    || !ownerBefore.isFile()
    || !ownerAfter.isFile()
    || directoryBefore.dev !== directoryAfter.dev
    || directoryBefore.ino !== directoryAfter.ino
    || ownerBefore.dev !== ownerAfter.dev
    || ownerBefore.ino !== ownerAfter.ino
    || owner?.schemaVersion !== LOCK_OWNER_SCHEMA_VERSION
    || typeof owner?.token !== 'string'
    || !LOCK_TOKEN_PATTERN.test(owner.token)
    || !Number.isSafeInteger(owner?.pid)
    || owner.pid <= 0
    || typeof owner?.hostname !== 'string'
    || !owner.hostname
    || typeof owner?.processStartIdentity !== 'string'
    || !owner.processStartIdentity
    || typeof owner?.processStartIdentityVerified !== 'boolean'
    || !Number.isFinite(Date.parse(owner?.acquiredAt || ''))
  ) {
    return null;
  }
  return {
    owner,
    dev: directoryAfter.dev,
    ino: directoryAfter.ino
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function readProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (startTicks && bootId) return `linux:${bootId}:${startTicks}`;
    } catch {}
  }
  try {
    const startedAt = execFileSync(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }
    ).trim();
    return startedAt ? `ps:${startedAt}` : null;
  } catch {
    return null;
  }
}

let cachedCurrentProcessStartEvidence = null;

function currentProcessStartEvidence() {
  if (!cachedCurrentProcessStartEvidence) {
    const identity = readProcessStartIdentity(process.pid);
    cachedCurrentProcessStartEvidence = {
      identity: identity
        || `unverified:${process.pid}:${Date.now() - Math.round(process.uptime() * 1000)}`,
      verified: Boolean(identity)
    };
  }
  return cachedCurrentProcessStartEvidence;
}

function sameLockGeneration(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function lockIsReclaimable(snapshot, staleMs) {
  if (!snapshot) return false;
  const { owner } = snapshot;
  if (owner.hostname === os.hostname()) {
    if (!isProcessAlive(owner.pid)) return true;
    if (!owner.processStartIdentityVerified) return false;
    const observedStartIdentity = readProcessStartIdentity(owner.pid);
    return Boolean(
      observedStartIdentity
      && observedStartIdentity !== owner.processStartIdentity
    );
  }
  return (Date.now() - Date.parse(owner.acquiredAt)) > staleMs;
}

function retiredLockPath(lockPath, token) {
  return `${lockPath}.retired-${token}`;
}

function retireLockGeneration(lockPath, observed) {
  const current = readLockSnapshot(lockPath);
  if (
    current?.owner?.token !== observed.owner.token
    || !sameLockGeneration(current, observed)
  ) {
    return false;
  }

  const retiredPath = retiredLockPath(lockPath, observed.owner.token);
  try {
    fs.renameSync(lockPath, retiredPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !LOCK_CONTENTION_CODES.has(error?.code)) {
      throw error;
    }
    const retired = readLockSnapshot(retiredPath);
    const canonical = readLockSnapshot(lockPath);
    return Boolean(
      retired?.owner?.token === observed.owner.token
      && sameLockGeneration(retired, observed)
      && !canonical
    );
  }

  const retired = readLockSnapshot(retiredPath);
  if (
    retired?.owner?.token !== observed.owner.token
    || !sameLockGeneration(retired, observed)
  ) {
    throw new Error(`Retired monitor lock generation could not be verified at ${retiredPath}`);
  }
  return true;
}

function releaseOwnedLock(lockPath, token) {
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot?.owner?.token !== token) return false;
  return retireLockGeneration(lockPath, snapshot);
}

function normalizeLockDuration(value, fallback, label) {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid monitor lock ${label}: ${normalized}`);
  }
  return normalized;
}

function writeLockCandidate(candidatePath, owner) {
  fs.mkdirSync(candidatePath, { mode: 0o700 });
  const ownerPath = path.join(candidatePath, LOCK_OWNER_FILE);
  const descriptor = fs.openSync(ownerPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function cleanupLockCandidate(candidatePath) {
  try {
    fs.unlinkSync(path.join(candidatePath, LOCK_OWNER_FILE));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    fs.rmdirSync(candidatePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function lockContentionError(lockPath) {
  const error = new Error(`Monitor lock is occupied at ${lockPath}`);
  error.code = 'EEXIST';
  return error;
}

function acquireBaselineLock(lockPath, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleLockMs = STALE_LOCK_MS
} = {}) {
  const normalizedTimeoutMs = normalizeLockDuration(timeoutMs, LOCK_TIMEOUT_MS, 'timeout');
  const normalizedStaleMs = normalizeLockDuration(staleLockMs, STALE_LOCK_MS, 'stale age');
  const deadline = Date.now() + normalizedTimeoutMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    const token = crypto.randomUUID();
    const candidatePath = `${lockPath}.candidate-${token}`;
    const processStart = currentProcessStartEvidence();
    const owner = {
      schemaVersion: LOCK_OWNER_SCHEMA_VERSION,
      token,
      pid: process.pid,
      hostname: os.hostname(),
      processStartIdentity: processStart.identity,
      processStartIdentityVerified: processStart.verified,
      acquiredAt: new Date().toISOString()
    };
    try {
      writeLockCandidate(candidatePath, owner);
      if (fs.existsSync(lockPath)) throw lockContentionError(lockPath);
      fs.renameSync(candidatePath, lockPath);
      return () => {
        try {
          releaseOwnedLock(lockPath, token);
        } catch {}
      };
    } catch (error) {
      try {
        cleanupLockCandidate(candidatePath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to clean monitor lock candidate at ${candidatePath}`
        );
      }
      if (!LOCK_CONTENTION_CODES.has(error?.code)) throw error;
      try {
        const observedOwner = readLockSnapshot(lockPath);
        if (
          lockIsReclaimable(observedOwner, normalizedStaleMs)
          && retireLockGeneration(lockPath, observedOwner)
        ) {
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for monitor baseline lock at ${lockPath}`);
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

export function withMonitorPublicationLock(lockPath, callback, lockOptions = {}) {
  const releaseLock = acquireBaselineLock(lockPath, lockOptions);
  try {
    return callback();
  } finally {
    releaseLock();
  }
}

function comparisonOrderTime(report) {
  return Date.parse(report?.runStartedAt || report?.generatedAt || '');
}

function isNewerBaseline(existing, report) {
  const existingTime = comparisonOrderTime(existing);
  const reportTime = comparisonOrderTime(report);
  return Number.isFinite(existingTime) && Number.isFinite(reportTime) && existingTime > reportTime;
}

function newestPublication(...publications) {
  return publications.filter(Boolean).reduce((newest, candidate) => (
    !newest || isNewerBaseline(candidate, newest) ? candidate : newest
  ), null);
}

function readPublicationMarker(filePath) {
  if (!filePath) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Invalid monitor publication marker at ${filePath}: ${error.message}`);
  }
  if (
    parsed?.schemaVersion !== MONITOR_PUBLICATION_SCHEMA_VERSION
    || parsed?.commitState !== 'complete'
    || !Number.isFinite(Date.parse(parsed?.runStartedAt || ''))
  ) {
    throw new Error(`Invalid monitor publication marker schema at ${filePath}; refusing to overwrite it`);
  }
  return parsed;
}

function readOptionalBuffer(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function hashBuffer(value) {
  if (value === null) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const file = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(file);
  }
  return hash.digest('hex');
}

function hashOptionalFile(filePath) {
  try {
    return hashFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveArtifactPath(rootDir, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function decodeSnapshot(record, label) {
  if (
    !record
    || !(
      typeof record.previousBase64 === 'string'
      || record.previousBase64 === null
    )
  ) {
    throw new Error(`Invalid ${label} snapshot`);
  }
  const snapshot = record.previousBase64 === null
    ? null
    : Buffer.from(record.previousBase64, 'base64');
  if (hashBuffer(snapshot) !== (record.previousSha256 ?? null)) {
    throw new Error(`Invalid ${label} snapshot hash`);
  }
  return snapshot;
}

function decodeRollbackPath(record, label, outputDir, targetPath, stagedPath) {
  if (!record || !(typeof record.rollback === 'string' || record.rollback === null)) {
    throw new Error(`Invalid ${label} rollback snapshot`);
  }
  if (record.rollback === null) {
    if ((record.previousSha256 ?? null) !== null) {
      throw new Error(`Invalid ${label} rollback snapshot hash`);
    }
    return null;
  }
  const rollbackPath = resolveArtifactPath(outputDir, record.rollback);
  if (
    !rollbackPath
    || rollbackPath === targetPath
    || rollbackPath === stagedPath
    || !/^[a-f0-9]{64}$/.test(record.previousSha256 || '')
  ) {
    throw new Error(`Invalid ${label} rollback snapshot`);
  }
  return rollbackPath;
}

function writeBufferAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function readPublicationJournal(journalPath) {
  try {
    return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Invalid pending monitor publication at ${journalPath}: ${error.message}`);
  }
}

function validatePublicationJournal(journalPath, journal) {
  if (!journal) return null;
  const publication = journal?.publication;
  const baselineDir = path.dirname(path.resolve(journalPath));
  const expectedJournalPath = monitorPublicationJournalPath(
    journal?.mode,
    baselineDir,
    journal?.scopeId
  );
  const expectedBaselineName = `${journal?.mode}.${journal?.scopeId}.json`;
  const baselineName = journal?.baseline?.path;
  const outputDir = path.resolve(String(journal?.outputDir || ''));
  const publicationRaw = Buffer.from(JSON.stringify(publication ?? null, null, 2));
  if (
    journal?.schemaVersion !== MONITOR_PENDING_PUBLICATION_SCHEMA_VERSION
    || !['pending', 'published'].includes(journal?.state)
    || path.resolve(journalPath) !== expectedJournalPath
    || !path.isAbsolute(journal?.outputDir || '')
    || publication?.schemaVersion !== MONITOR_PUBLICATION_SCHEMA_VERSION
    || publication?.commitState !== 'complete'
    || publication?.mode !== journal.mode
    || publication?.scopeId !== journal.scopeId
    || baselineName !== expectedBaselineName
    || publication?.artifacts?.baseline?.path !== baselineName
    || publication?.artifacts?.baseline?.sha256 !== journal?.baseline?.sha256
    || journal?.marker?.target !== 'latest-commit.json'
    || journal?.marker?.sha256 !== hashBuffer(publicationRaw)
    || journal?.head?.path !== path.basename(monitorPublicationHeadPath(baselineDir))
    || journal?.head?.sha256 !== hashBuffer(publicationRaw)
  ) {
    throw new Error(`Invalid pending monitor publication schema at ${journalPath}`);
  }
  const newBaseline = typeof journal?.baseline?.newBase64 === 'string'
    ? Buffer.from(journal.baseline.newBase64, 'base64')
    : null;
  if (hashBuffer(newBaseline) !== journal.baseline.sha256) {
    throw new Error(`Invalid new baseline snapshot in ${journalPath}`);
  }
  const previousBaseline = decodeSnapshot(journal.baseline, 'previous baseline');
  const previousMarker = decodeSnapshot(journal.marker, 'previous publication marker');
  const previousHead = decodeSnapshot(journal.head, 'previous publication head');

  const artifacts = [];
  for (const key of ['history', 'latestMarkdown', 'latestJson']) {
    const published = publication?.artifacts?.[key];
    const staged = journal?.stages?.[key];
    const targetPath = resolveArtifactPath(outputDir, staged?.target);
    const stagedPath = resolveArtifactPath(outputDir, staged?.staged);
    if (
      !targetPath
      || !stagedPath
      || targetPath === stagedPath
      || staged.target !== published?.path
      || staged.sha256 !== published?.sha256
    ) {
      throw new Error(`Invalid pending monitor publication artifact ${key} at ${journalPath}`);
    }
    let previous = null;
    let rollbackPath = null;
    try {
      if (Object.prototype.hasOwnProperty.call(staged || {}, 'rollback')) {
        rollbackPath = decodeRollbackPath(
          staged,
          `previous ${key}`,
          outputDir,
          targetPath,
          stagedPath
        );
      } else {
        previous = decodeSnapshot(staged, `previous ${key}`);
      }
    } catch (error) {
      throw new Error(`${error.message} in ${journalPath}`);
    }
    artifacts.push({
      key,
      targetPath,
      stagedPath,
      sha256: staged.sha256,
      previous,
      rollbackPath,
      previousSha256: staged.previousSha256 ?? null
    });
  }
  const artifactPaths = new Set();
  for (const artifact of artifacts) {
    for (const artifactPath of [
      artifact.targetPath,
      artifact.stagedPath,
      artifact.rollbackPath
    ].filter(Boolean)) {
      if (artifactPaths.has(artifactPath)) {
        throw new Error(`Invalid duplicate monitor publication path in ${journalPath}`);
      }
      artifactPaths.add(artifactPath);
    }
  }
  return {
    journal,
    publication,
    publicationRaw,
    outputDir,
    markerPath: path.join(outputDir, 'latest-commit.json'),
    markerSha256: journal.marker.sha256,
    previousMarker,
    previousMarkerSha256: journal.marker.previousSha256 ?? null,
    headPath: monitorPublicationHeadPath(baselineDir),
    headSha256: journal.head.sha256,
    previousHead,
    previousHeadSha256: journal.head.previousSha256 ?? null,
    publicationLockPath: monitorPublicationLockPath(baselineDir),
    baselinePath: path.join(baselineDir, baselineName),
    newBaseline,
    previousBaseline,
    previousBaselineSha256: journal.baseline.previousSha256 ?? null,
    artifacts
  };
}

function cleanupJournalStages(state) {
  for (const artifact of state.artifacts) {
    unlinkIfExists(artifact.stagedPath);
    if (artifact.rollbackPath) unlinkIfExists(artifact.rollbackPath);
  }
}

function fileState(filePath, newSha256, previousSha256) {
  const currentSha256 = hashOptionalFile(filePath);
  if (currentSha256 === newSha256) return 'new';
  if (currentSha256 === previousSha256) return 'previous';
  return 'unknown';
}

function assertArtifactRollbackReady(artifact, journalPath = '') {
  if (artifact.previousSha256 === null) return;
  if (artifact.rollbackPath) {
    if (hashOptionalFile(artifact.rollbackPath) !== artifact.previousSha256) {
      throw new Error(
        `Invalid previous ${artifact.key} rollback snapshot hash${journalPath ? ` in ${journalPath}` : ''}`
      );
    }
    return;
  }
  if (hashBuffer(artifact.previous) !== artifact.previousSha256) {
    throw new Error(
      `Invalid previous ${artifact.key} snapshot hash${journalPath ? ` in ${journalPath}` : ''}`
    );
  }
}

function restoreSnapshot(filePath, snapshot) {
  if (snapshot === null) {
    unlinkIfExists(filePath);
    return;
  }
  writeBufferAtomic(filePath, snapshot);
}

function restoreFileSnapshot(filePath, snapshotPath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.rollback.tmp`;
  try {
    try {
      fs.linkSync(snapshotPath, tempPath);
    } catch (error) {
      if (!['EACCES', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error?.code)) {
        throw error;
      }
      fs.copyFileSync(snapshotPath, tempPath, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    unlinkIfExists(tempPath);
    throw error;
  }
}

function restoreArtifactSnapshot(artifact) {
  if (artifact.previousSha256 === null) {
    unlinkIfExists(artifact.targetPath);
    return;
  }
  assertArtifactRollbackReady(artifact);
  if (artifact.rollbackPath) {
    restoreFileSnapshot(artifact.targetPath, artifact.rollbackPath);
    return;
  }
  restoreSnapshot(artifact.targetPath, artifact.previous);
}

function cleanupJournal(journalPath, state, status) {
  try {
    cleanupJournalStages(state);
  } catch {
    return `${status}-cleanup-incomplete`;
  }
  try {
    unlinkIfExists(journalPath);
    return status;
  } catch {
    return `${status}-journal-retained`;
  }
}

function rollbackPublication(journalPath, state, status) {
  const artifactStates = state.artifacts.map((artifact) => ({
    ...artifact,
    currentState: fileState(
      artifact.targetPath,
      artifact.sha256,
      artifact.previousSha256
    )
  }));
  const unknownArtifact = artifactStates.find(
    (artifact) => artifact.currentState === 'unknown'
  );
  if (unknownArtifact) {
    throw new Error(
      `Unknown monitor artifact state at ${unknownArtifact.targetPath}; retaining recovery journal`
    );
  }
  const markerState = fileState(
    state.markerPath,
    state.markerSha256,
    state.previousMarkerSha256
  );
  const headState = fileState(
    state.headPath,
    state.headSha256,
    state.previousHeadSha256
  );
  if (markerState === 'unknown' || headState === 'unknown') {
    throw new Error('Unknown monitor publication pointer state; retaining recovery journal');
  }
  for (const artifact of artifactStates) {
    if (artifact.currentState === 'new') assertArtifactRollbackReady(artifact, journalPath);
  }
  for (const artifact of artifactStates) {
    if (artifact.currentState === 'new') {
      restoreArtifactSnapshot(artifact);
    }
  }

  if (markerState === 'new') restoreSnapshot(state.markerPath, state.previousMarker);
  if (headState === 'new') restoreSnapshot(state.headPath, state.previousHead);
  restoreBaselineSnapshot(state.baselinePath, state.previousBaseline);
  return cleanupJournal(journalPath, state, status);
}

function listPublicationJournals(baselineDir) {
  const resolvedBaselineDir = path.resolve(baselineDir);
  let names;
  try {
    names = fs.readdirSync(resolvedBaselineDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((entry) => entry.endsWith('.publication-pending.json'))
    .sort()
    .map((entry) => path.join(resolvedBaselineDir, entry));
}

function recoverPublicationJournalsUnderGlobalLock(baselineDir, outputDir = null) {
  const resolvedOutputDir = outputDir ? path.resolve(outputDir) : null;
  const results = [];
  for (const journalPath of listPublicationJournals(baselineDir)) {
    const journal = readPublicationJournal(journalPath);
    const state = validatePublicationJournal(journalPath, journal);
    if (resolvedOutputDir && state.outputDir !== resolvedOutputDir) continue;
    const releaseBaselineLock = acquireBaselineLock(`${state.baselinePath}.lock`);
    try {
      results.push(recoverMonitorPublicationJournalUnderLock({ journalPath }));
    } finally {
      releaseBaselineLock();
    }
  }
  return results;
}

export function recoverMonitorPublicationJournalUnderLock({ journalPath } = {}) {
  if (!journalPath) return { status: 'disabled' };
  const journal = readPublicationJournal(journalPath);
  if (!journal) return { status: 'none' };
  const state = validatePublicationJournal(journalPath, journal);
  const baselineState = fileState(
    state.baselinePath,
    state.publication.artifacts.baseline.sha256,
    state.previousBaselineSha256
  );
  const markerState = fileState(
    state.markerPath,
    state.markerSha256,
    state.previousMarkerSha256
  );
  const headState = fileState(
    state.headPath,
    state.headSha256,
    state.previousHeadSha256
  );
  const publiclyCommitted = markerState === 'new' || headState === 'new';
  const outputMissing = !fs.existsSync(state.outputDir);

  if (
    baselineState === 'unknown'
    || headState === 'unknown'
  ) {
    throw new Error('Unknown monitor publication state; retaining recovery journal');
  }

  if (state.journal.state === 'published') {
    // Rollback restores the shared head before the baseline. If interrupted
    // between those writes, the previous head is durable rollback progress.
    if (headState === 'previous') {
      const status = rollbackPublication(
        journalPath,
        state,
        'rolled-back-published-output'
      );
      return { status, publication: state.publication };
    }
    if (baselineState !== 'new' || headState !== 'new') {
      throw new Error('Published monitor journal does not match durable state; retaining recovery journal');
    }
    if (markerState === 'unknown' && readOptionalBuffer(state.markerPath) !== null) {
      throw new Error('Published monitor marker has unknown bytes; retaining recovery journal');
    }
    const extantArtifactStates = state.artifacts
      .filter((artifact) => fs.existsSync(artifact.targetPath))
      .map((artifact) => ({
        ...artifact,
        currentState: fileState(
          artifact.targetPath,
          artifact.sha256,
          artifact.previousSha256
        )
      }));
    const unknownArtifact = extantArtifactStates.find(
      (artifact) => artifact.currentState === 'unknown'
    );
    if (unknownArtifact) {
      throw new Error(
        `Published monitor artifact has unknown bytes at ${unknownArtifact.targetPath}; retaining recovery journal`
      );
    }
    const restoredArtifact = extantArtifactStates.find(
      (artifact) => artifact.currentState === 'previous'
    );
    const restoredMarker = fs.existsSync(state.markerPath) && markerState === 'previous';
    if (restoredArtifact || restoredMarker) {
      const status = rollbackPublication(
        journalPath,
        state,
        'rolled-back-published-output'
      );
      return { status, publication: state.publication };
    }
    const status = cleanupJournal(journalPath, state, 'completed-published');
    return { status, publication: state.publication };
  }

  if (outputMissing) {
    if (headState === 'new') restoreSnapshot(state.headPath, state.previousHead);
    restoreBaselineSnapshot(state.baselinePath, state.previousBaseline);
    const status = cleanupJournal(journalPath, state, 'rolled-back-missing-output');
    return { status, publication: state.publication };
  }

  if (markerState === 'unknown') {
    throw new Error('Unknown monitor publication marker state; retaining recovery journal');
  }

  if (baselineState === 'previous' && !publiclyCommitted) {
    const status = rollbackPublication(
      journalPath,
      state,
      'aborted-before-baseline'
    );
    return { status, publication: state.publication };
  }

  const artifactStates = state.artifacts.map((artifact) => ({
    ...artifact,
    targetState: fileState(
      artifact.targetPath,
      artifact.sha256,
      artifact.previousSha256
    ),
    stagedReady: hashOptionalFile(artifact.stagedPath) === artifact.sha256
  }));
  const unknownArtifact = artifactStates.find(
    (artifact) => artifact.targetState === 'unknown'
  );
  if (unknownArtifact) {
    throw new Error(
      `Unknown monitor artifact state at ${unknownArtifact.targetPath}; retaining recovery journal`
    );
  }
  const missingNewBytes = artifactStates.find(
    (artifact) => artifact.targetState !== 'new' && !artifact.stagedReady
  );
  if (missingNewBytes) {
    if (publiclyCommitted) {
      throw new Error(
        `Committed monitor publication is missing ${missingNewBytes.key}; retaining recovery journal`
      );
    }
    const status = rollbackPublication(
      journalPath,
      state,
      'rolled-back-unrecoverable'
    );
    return { status, publication: state.publication };
  }

  for (const artifact of artifactStates) {
    assertArtifactRollbackReady(artifact, journalPath);
  }

  if (baselineState !== 'new') {
    restoreSnapshot(state.baselinePath, state.newBaseline);
  }
  for (const artifact of artifactStates) {
    if (artifact.targetState !== 'new') {
      fs.mkdirSync(path.dirname(artifact.targetPath), { recursive: true });
      fs.renameSync(artifact.stagedPath, artifact.targetPath);
    } else {
      unlinkIfExists(artifact.stagedPath);
    }
  }
  writeBufferAtomic(state.markerPath, state.publicationRaw);
  writeBufferAtomic(state.headPath, state.publicationRaw);
  writeBufferAtomic(
    journalPath,
    Buffer.from(JSON.stringify({ ...state.journal, state: 'published' }, null, 2))
  );
  const status = cleanupJournal(journalPath, state, 'completed');
  return { status, publication: state.publication };
}

export function recoverMonitorPublicationJournal({ journalPath } = {}) {
  if (!journalPath) return { status: 'disabled' };
  const journal = readPublicationJournal(journalPath);
  if (!journal) return { status: 'none' };
  const state = validatePublicationJournal(journalPath, journal);
  const releasePublicationLock = acquireBaselineLock(state.publicationLockPath);
  let releaseBaselineLock = () => {};
  try {
    releaseBaselineLock = acquireBaselineLock(`${state.baselinePath}.lock`);
    return recoverMonitorPublicationJournalUnderLock({ journalPath });
  } finally {
    releaseBaselineLock();
    releasePublicationLock();
  }
}

export function recoverMonitorPublicationsForOutput({
  baselineDir = defaultMonitorBaselineDir(),
  outputDir
} = {}) {
  const resolvedBaselineDir = path.resolve(baselineDir);
  if (!outputDir) throw new Error('outputDir is required for monitor publication recovery');
  if (!fs.existsSync(resolvedBaselineDir)) return [];
  const releasePublicationLock = acquireBaselineLock(
    monitorPublicationLockPath(resolvedBaselineDir)
  );
  try {
    return recoverPublicationJournalsUnderGlobalLock(resolvedBaselineDir, outputDir);
  } finally {
    releasePublicationLock();
  }
}

export function recoverMonitorPublications({
  baselineDir = defaultMonitorBaselineDir()
} = {}) {
  const resolvedBaselineDir = path.resolve(baselineDir);
  if (!fs.existsSync(resolvedBaselineDir)) return [];
  const releasePublicationLock = acquireBaselineLock(
    monitorPublicationLockPath(resolvedBaselineDir)
  );
  try {
    return recoverPublicationJournalsUnderGlobalLock(resolvedBaselineDir);
  } finally {
    releasePublicationLock();
  }
}

function restoreBaselineSnapshot(filePath, snapshot) {
  if (snapshot === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }

  const restorePath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.rollback.tmp`;
  try {
    fs.writeFileSync(restorePath, snapshot, { flag: 'wx', mode: 0o600 });
    fs.renameSync(restorePath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(restorePath);
    } catch {}
    throw error;
  }
}

export function buildMonitorBaseline(report, previousReport = null, scope = { id: 'default' }) {
  if (!report?.mode || !Array.isArray(report?.alerts) || !Array.isArray(report?.docResults)) {
    throw new Error('Cannot build monitor baseline from an invalid report');
  }
  return {
    schemaVersion: MONITOR_BASELINE_SCHEMA_VERSION,
    mode: report.mode,
    scope: serializableScope(scope),
    runStartedAt: report.runStartedAt || null,
    generatedAt: report.generatedAt,
    alerts: report.alerts,
    docResults: compactDocResults(report.docResults, previousReport?.docResults || [])
  };
}

export function writeMonitorBaselineAtomic(report, {
  baselineDir = defaultMonitorBaselineDir(),
  previousReport = null,
  previousSource = previousReport ? 'provided' : 'empty',
  scope = { id: 'default' },
  publicationLockPath = null,
  publicationMarkerPath = null,
  publicationHeadPath = null,
  publicationJournalPath = null,
  prepareReport = null,
  beforeCommit = null,
  beforeBaselineCommit = null,
  afterBaselineCommit = null,
  onAbort = null
} = {}) {
  const filePath = monitorBaselinePath(report.mode, baselineDir, scope.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let releasePublicationLock = () => {};
  let releaseLock = () => {};
  let previousBaselineSnapshot = null;
  let baselineCommitted = false;

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    if (publicationJournalPath && !publicationLockPath) {
      throw new Error('A monitor publication journal requires a shared publication lock');
    }
    if (publicationLockPath) {
      releasePublicationLock = acquireBaselineLock(publicationLockPath);
      recoverPublicationJournalsUnderGlobalLock(path.dirname(filePath));
    }
    releaseLock = acquireBaselineLock(`${filePath}.lock`);
    if (
      publicationJournalPath
      && path.resolve(publicationJournalPath) !== monitorPublicationJournalPath(
        report.mode,
        baselineDir,
        scope.id
      )
    ) {
      throw new Error('Monitor publication journal does not match its baseline scope');
    }
    const existing = parseBaselineFile(filePath, report.mode, scope.id);
    previousBaselineSnapshot = existing ? fs.readFileSync(filePath) : null;
    if (isNewerBaseline(existing, report)) {
      return {
        filePath,
        written: false,
        baseline: existing,
        semanticSupersededBy: existing,
        semanticSupersededReason: 'scope-baseline',
        report
      };
    }
    const comparisonReport = existing || previousReport;
    const committedReport = prepareReport
      ? prepareReport(comparisonReport, {
        source: existing ? 'durable' : previousSource
      })
      : report;
    const published = newestPublication(
      readPublicationMarker(publicationHeadPath),
      readPublicationMarker(publicationMarkerPath)
    );
    if (isNewerBaseline(published, report)) {
      return {
        filePath,
        written: false,
        baseline: existing,
        publicationSupersededBy: published,
        publicationSupersededReason: 'shared-publication',
        report: committedReport
      };
    }
    const baseline = buildMonitorBaseline(committedReport, comparisonReport, scope);
    fs.writeFileSync(tempPath, `${JSON.stringify(baseline, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    if (beforeCommit) beforeCommit(committedReport);
    if (beforeBaselineCommit) {
      beforeBaselineCommit(committedReport, {
        filePath,
        stagedBaselinePath: tempPath,
        baseline,
        previousBaselineSnapshot
      });
    }
    fs.renameSync(tempPath, filePath);
    baselineCommitted = true;
    if (afterBaselineCommit) {
      afterBaselineCommit(committedReport, {
        filePath,
        baseline
      });
    }
    return { filePath, written: true, baseline, report: committedReport };
  } catch (error) {
    const failures = [error];
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    if (baselineCommitted) {
      try {
        restoreBaselineSnapshot(filePath, previousBaselineSnapshot);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    try {
      if (onAbort) onAbort(error);
    } catch (abortError) {
      failures.push(abortError);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Monitor publication failed and rollback also failed at ${filePath}`
      );
    }
    throw error;
  } finally {
    releaseLock();
    releasePublicationLock();
  }
}
