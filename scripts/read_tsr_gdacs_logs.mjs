// Manual, fixed-resource log read. No provider request or deployed-state mutation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readGdacsPrimaryFailureDiagnostic } from '../gcp/mcp-proxy/firms-diagnostics.js';
import { effectiveReleaseIdentity } from './feed_native_build.mjs';
export const contract = Object.freeze({
  repository: 'CongressionalInsights/TheSituationRoomAI', project: 'situationroom-ai-20260112',
  principal: 'gh-actions-deployer@situationroom-ai-20260112.iam.gserviceaccount.com',
  revisions: Object.freeze({ 'situation-room-feed': 'situation-room-feed-gha-43789760050-1', 'situation-room-mcp': 'situation-room-mcp-gha-43801846565-1' }),
  maxRows: 10, maxWindowMs: 900000, commandTimeoutMs: 30000, maxOutputBytes: 65536
});
const format = 'json(timestamp,resource.labels.service_name,resource.labels.revision_name,jsonPayload.event,jsonPayload.feedId,jsonPayload.errorClass,jsonPayload.upstreamStatus,jsonPayload.transportCode,jsonPayload.bodyCharacterCount,jsonPayload.xmlContentTypeHint,jsonPayload.htmlDocumentHint)';
function utc(value) {
  assert.match(value || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const ms = Date.parse(value); assert.ok(Number.isFinite(ms));
  assert.equal(new Date(ms).toISOString().replace('.000Z','Z'), value); return ms;
}
export function validateInputs(env, actualHead, now = Date.now()) {
  assert.equal(env.GITHUB_REPOSITORY, contract.repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'Reruns are not admitted');
  assert.match(env.GITHUB_RUN_ID || '', /^\d+$/);
  assert.match(env.EXPECTED_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(env.EXPECTED_SHA, env.GITHUB_SHA); assert.equal(actualHead, env.GITHUB_SHA);
  assert.match(env.APPROVAL_REF || '', /^[a-z0-9][a-z0-9-]{7,119}$/);
  const start = utc(env.START_UTC), end = utc(env.END_UTC);
  assert.ok(end > start && end - start <= contract.maxWindowMs && end <= now, 'Invalid completed log window');
  return { sourceSha: actualHead, runId: env.GITHUB_RUN_ID, attempt: 1,
    approvalRef: env.APPROVAL_REF, start: env.START_UTC, end: env.END_UTC };
}
function exclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(file),'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
export function readArgs(request) {
  utc(request.start); utc(request.end);
  const pairs = Object.entries(contract.revisions).map(([service,revision]) => `(resource.labels.service_name="${service}" AND resource.labels.revision_name="${revision}")`).join(' OR ');
  const query = `resource.type="cloud_run_revision" AND (${pairs}) AND timestamp>="${request.start}" AND timestamp<="${request.end}" AND jsonPayload.event="gdacs_primary_failure" AND jsonPayload.feedId="gdacs-alerts"`;
  return ['logging','read',query,'--project='+contract.project,'--limit='+contract.maxRows,'--format='+format,'--quiet'];
}
export function sanitizeEntries(rows, request) {
  assert.ok(Array.isArray(rows) && rows.length <= contract.maxRows);
  const entries = []; let unrecognizedMatchingRecords = 0;
  for (const row of rows) {
    const service = row?.resource?.labels?.service_name, revision = row?.resource?.labels?.revision_name;
    const timestamp = row?.timestamp;
    const diagnostic = readGdacsPrimaryFailureDiagnostic(row?.jsonPayload);
    const time = typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(timestamp) ? Date.parse(timestamp) : NaN;
    if (!Object.hasOwn(contract.revisions, service) || contract.revisions[service] !== revision || !diagnostic || !Number.isFinite(time) || time < Date.parse(request.start) || time > Date.parse(request.end)) {
      unrecognizedMatchingRecords++; continue;
    }
    entries.push({ timestamp, service, revision, diagnostic });
  }
  return { entries, unrecognizedMatchingRecords };
}
export function prepare(dir, env, actualHead, now = Date.now()) {
  const request = validateInputs(env, actualHead, now);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  exclusive(path.join(dir,'request.json'), { ...request, state: 'validated_before_authentication' });
  return request;
}
export function executeRead(dir, env, actualHead, { run = spawnSync, now = Date.now, readFile = fs.readFileSync } = {}) {
  const request = validateInputs(env, actualHead, now());
  const saved = JSON.parse(fs.readFileSync(path.join(dir,'request.json')));
  assert.deepEqual(saved, { ...request, state: 'validated_before_authentication' });
  assert.equal(fs.existsSync(path.join(dir,'result.json')), false, 'Terminal result blocks replay');
  assert.equal(fs.existsSync(path.join(dir,'read-intent.json')), false, 'Prior or uncertain read blocks replay');
  const result = { ...request, project: contract.project, startedAt: new Date(now()).toISOString(),
    logicalReadAttempts: 0, state: 'not_attempted', providerCalls: 0 };
  const command = (args, timeout) => run('gcloud', args, { encoding: 'utf8', timeout,
    killSignal: 'SIGTERM', maxBuffer: contract.maxOutputBytes, env: { ...env,
      CLOUDSDK_CORE_DISABLE_PROMPTS: 'true', CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API: 'false',
      CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true' } });
  try {
    // Reuse the already accepted identity/binding check inside the owning runner.
    result.identity = effectiveReleaseIdentity({ env, readFile, getProperty: property => {
      const response = command(['config','get',property],5000);
      assert.equal(response.status,0);
      const value = response.stdout.trim(); return value === '(unset)' ? '' : value;
    } });
    exclusive(path.join(dir,'read-intent.json'), { ...request, state: 'attempting_or_uncertain', at: new Date(now()).toISOString() });
    result.logicalReadAttempts = 1;
    const response = command(readArgs(request), contract.commandTimeoutMs);
    if (response.error || response.status !== 0) {
      result.state = 'read_failed_or_uncertain';
      result.failureClass = response.error?.code === 'ETIMEDOUT' ? 'command_timeout' : response.error?.code === 'ENOBUFS' ? 'selected_output_cap' : 'native_command_refusal';
    } else {
      assert.ok(Buffer.byteLength(response.stdout) <= contract.maxOutputBytes);
      Object.assign(result, sanitizeEntries(JSON.parse(response.stdout), request));
      result.state = result.unrecognizedMatchingRecords ? 'completed_with_unrecognized_records' : 'completed_sanitized';
    }
  } catch {
    result.state = result.logicalReadAttempts ? 'read_failed_or_uncertain' : 'identity_or_local_validation_refusal';
    result.failureClass = 'validation_or_decode_failed';
  }
  result.finishedAt = new Date(now()).toISOString();
  exclusive(path.join(dir,'result.json'), result);
  return result;
}
export function finalize(dir) {
  const file = path.join(dir,'result.json'); if (fs.existsSync(file)) return;
  const request = JSON.parse(fs.readFileSync(path.join(dir,'request.json')));
  exclusive(file, { ...request, state: fs.existsSync(path.join(dir,'read-intent.json')) ? 'interrupted_uncertain_no_replay' : 'not_read_auth_or_prior_step_failed',
    logicalReadAttempts: fs.existsSync(path.join(dir,'read-intent.json')) ? 1 : 0, providerCalls: 0 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode,dir] = process.argv.slice(2);
  try {
    if (mode === 'prepare') prepare(dir,process.env,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
    else if (mode === 'read') {
      const r = executeRead(dir,process.env,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
      if (r.state !== 'completed_sanitized') process.exitCode = 1;
    } else if (mode === 'finalize') finalize(dir);
    else throw new Error('unknown mode');
  } catch { console.error('Log-only local validation refused; no details or credential values emitted.'); process.exitCode = 1; }
}
