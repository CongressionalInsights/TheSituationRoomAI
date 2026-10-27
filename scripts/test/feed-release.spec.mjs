import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFeedManifest } from '../build_feed_manifest.mjs';
import { readBuildIdentity } from '../../gcp/feed-proxy/build-identity.js';
import { assertCandidate, assertReleaseState, buildProvenance } from '../verify_feed_release.mjs';
import { verifyFeedContent } from '../verify_feed_candidate.mjs';

const sha = 'c'.repeat(40);
const digest = 'sha256:' + 'a'.repeat(64);
const image = 'us-central1-docker.pkg.dev/fixture/feed@' + digest;
const service = 'situation-room-feed';
const old = service + '-old';
const tag = 'gha-123-1';
const candidate = service + '-' + tag;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const native = JSON.parse(fs.readFileSync(new URL('./fixtures/feed-release/native-metadata.json', import.meta.url)));

function fixtures() {
  // Model the actual captured v1 shape; change only simulated release identities.
  const beforeRevision = structuredClone(native.revision);
  beforeRevision.metadata.name = old;
  beforeRevision.metadata.annotations['run.googleapis.com/build-id'] = '{"situation-room-feed-1":"build-1"}';
  beforeRevision.metadata.annotations['run.googleapis.com/build-source-location'] = '{"situation-room-feed-1":"gs://bucket/source.zip#123"}';
  beforeRevision.spec.containers[0].image = beforeRevision.status.imageDigest = image;
  const revision = structuredClone(beforeRevision);
  revision.metadata.name = candidate;
  const before = structuredClone(native.service);
  before.metadata.generation = before.status.observedGeneration = 1;
  before.metadata.annotations['run.googleapis.com/build-id'] = 'build-1';
  before.metadata.annotations['run.googleapis.com/build-source-location'] = 'gs://bucket/source.zip#123';
  before.spec.template.spec.containers[0].image = image;
  before.spec.traffic = [{ revisionName: old, percent: 100 }];
  before.status.traffic = structuredClone(before.spec.traffic);
  before.status.latestCreatedRevisionName = before.status.latestReadyRevisionName = old;
  const current = structuredClone(before);
  current.metadata.generation = current.status.observedGeneration = 2;
  current.status.latestCreatedRevisionName = current.status.latestReadyRevisionName = candidate;
  const tagged = { revisionName: candidate, tag, percent: 0, url: 'https://candidate.invalid' };
  current.status.traffic.push(tagged);
  current.spec.traffic.push(tagged);
  const manifest = { sourceSha: sha, contentSha256: 'd'.repeat(64) };
  const identity = { available: true, ...manifest, revision: candidate, service };
  const build = { id: 'build-1', status: 'SUCCESS', sourceProvenance: { resolvedStorageSource: { bucket: 'bucket', object: 'source.zip', generation: '123' } }, results: { images: [{ name: image.split('@')[0], digest }] } };
  return { before, current, beforeRevision, revision, manifest, identity, build, candidate, tag, service, candidateService: current };
}

test('Feed runtime identity hashes actual packaged source bytes and keeps plain health compatible', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-build-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'server.js'), 'actual server bytes');
  fs.writeFileSync(path.join(dir, 'feeds.json'), '{"feeds":[]}');
  const manifest = buildFeedManifest(dir, sha);
  json(path.join(dir, 'build-manifest.json'), manifest);
  assert.equal(readBuildIdentity(dir, { K_REVISION: candidate, K_SERVICE: service }).contentSha256, manifest.contentSha256);
  fs.appendFileSync(path.join(dir, 'server.js'), 'changed');
  assert.equal(readBuildIdentity(dir).available, false, 'same source SHA label cannot hide changed bytes');
  const source = fs.readFileSync(new URL('../../gcp/feed-proxy/server.js', import.meta.url), 'utf8');
  assert.match(source, /url.pathname === '\/health'[\s\S]*?sendJson\(res, 200, \{ ok: true \}/);
});

test('Feed candidate acceptance requires source bytes, built image, exact revision and preserved configuration', () => {
  const f = fixtures();
  assert.doesNotThrow(() => assertCandidate(f));
  const cases = [
    value => { value.identity.revision = old; }, value => { value.identity.sourceSha = 'e'.repeat(40); },
    value => { value.identity.contentSha256 = 'f'.repeat(64); }, value => { value.identity.available = false; },
    value => { value.build.results.images[0].digest = 'sha256:' + 'b'.repeat(64); },
    value => { value.build.sourceProvenance.resolvedStorageSource.generation = '456'; },
    value => { value.revision.spec.containers[0].env.find(env => env.name === 'SAMGOV_API_KEY').valueFrom.secretKeyRef.key = 'latest'; },
    value => { value.revision.spec.containers[0].env.find(env => env.name === 'ALLOWED_ORIGINS').value = 'changed'; },
    value => { value.revision.spec.timeoutSeconds = 100; }
  ];
  for (const mutate of cases) {
    const value = structuredClone(f);
    mutate(value);
    assert.throws(() => assertCandidate(value));
  }
});

test('Feed traffic verification rejects healthy old, unobserved, partial and unrelated promotion states', () => {
  const f = fixtures();
  assert.doesNotThrow(() => assertReleaseState(f.before, f.current, candidate, tag, 'candidate'));
  const wrongTemplateImage = structuredClone(f.current);
  wrongTemplateImage.spec.template.spec.containers[0].image = 'mutable:latest';
  assert.throws(() => assertReleaseState(f.before, wrongTemplateImage, candidate, tag, 'candidate', f.revision));
  assert.throws(() => assertReleaseState(f.before, f.current, candidate, tag, 'promoted'));
  const promoted = structuredClone(f.current);
  promoted.status.traffic[0] = { revisionName: candidate, percent: 100 };
  promoted.spec.traffic[0] = { revisionName: candidate, percent: 100 };
  assert.doesNotThrow(() => assertReleaseState(f.before, promoted, candidate, tag, 'promoted'));
  const partial = structuredClone(promoted);
  partial.status.traffic[0].percent = partial.spec.traffic[0].percent = 50;
  partial.status.traffic.push({ revisionName: old, percent: 50 });
  partial.spec.traffic.push({ revisionName: old, percent: 50 });
  assert.throws(() => assertReleaseState(f.before, partial, candidate, tag, 'promoted'));
  assert.doesNotThrow(() => assertReleaseState(f.before, partial, candidate, tag, 'recover'));
  const alien = structuredClone(promoted);
  alien.status.traffic[0].revisionName = service + '-unrelated';
  assert.throws(() => assertReleaseState(f.before, alien, candidate, tag, 'recover'));
  const configChanged = structuredClone(promoted);
  configChanged.spec.template.spec.containers[0].env[1].value = 'unrelated';
  assert.throws(() => assertReleaseState(f.before, configChanged, candidate, tag, 'recover'));
  promoted.status.observedGeneration = 0;
  assert.throws(() => assertReleaseState(f.before, promoted, candidate, tag, 'promoted'));
});

test('Feed native metadata retains absent template/container names and scalar Service plus mapped Revision provenance', () => {
  const before = structuredClone(native.service);
  const current = structuredClone(before);
  assert.equal(Object.hasOwn(before.spec.template.metadata, 'name'), false);
  assert.equal(Object.hasOwn(before.spec.template.spec.containers[0], 'name'), false);
  assert.equal(native.revision.spec.containers[0].name, 'situation-room-feed-1');
  const provenance = buildProvenance(before, native.revision);
  assert.equal(provenance.id, before.metadata.annotations['run.googleapis.com/build-id']);
  assert.equal(provenance.sourceLocation, before.metadata.annotations['run.googleapis.com/build-source-location']);
  const noRevisionAnnotations = structuredClone(native.revision);
  delete noRevisionAnnotations.metadata.annotations['run.googleapis.com/build-id'];
  delete noRevisionAnnotations.metadata.annotations['run.googleapis.com/build-source-location'];
  assert.deepEqual(buildProvenance(before, noRevisionAnnotations), provenance);
  assert.deepEqual(buildProvenance(null, native.revision), provenance);
  noRevisionAnnotations.metadata.annotations['run.googleapis.com/build-id'] = '{"container":"wrong"}';
  assert.throws(() => buildProvenance(before, noRevisionAnnotations));
  current.status.latestCreatedRevisionName = current.status.latestReadyRevisionName = candidate;
  current.status.traffic.push({ revisionName: candidate, tag, url: 'https://candidate.invalid' });
  current.spec.traffic.push({ revisionName: candidate, tag });
  assert.doesNotThrow(() => assertReleaseState(before, current, candidate, tag, 'candidate', native.revision));
  current.spec.template.metadata.name = 'wrong';
  assert.throws(() => assertReleaseState(before, current, candidate, tag, 'candidate', native.revision));
  delete current.spec.template.metadata.name;
  current.spec.template.metadata.annotations['run.googleapis.com/client-version'] = 'future';
  assert.doesNotThrow(() => assertReleaseState(before, current, candidate, tag, 'candidate', native.revision));
  current.metadata.annotations['run.googleapis.com/minScale'] = '1';
  assert.throws(() => assertReleaseState(before, current, candidate, tag, 'candidate', native.revision));
  delete current.metadata.annotations['run.googleapis.com/minScale'];
  current.metadata.annotations['run.googleapis.com/build-enable-automatic-updates'] = 'true';
  assert.throws(() => assertReleaseState(before, current, candidate, tag, 'candidate', native.revision));
});

test('Feed provenance verification executes the actual retained Cloud Build resolved-source and image-list shape', () => {
  const f = fixtures();
  const build = native.build;
  const source = build.sourceProvenance.resolvedStorageSource;
  const sourceLocation = `gs://${source.bucket}/${source.object}#${source.generation}`;
  const idMap = JSON.stringify({ container: build.id });
  const sourceMap = JSON.stringify({ container: sourceLocation });
  for (const revision of [f.revision, f.beforeRevision]) {
    revision.metadata.annotations['run.googleapis.com/build-id'] = idMap;
    revision.metadata.annotations['run.googleapis.com/build-source-location'] = sourceMap;
    revision.spec.containers[0].image = build.results.images[0].name + '@' + build.results.images[0].digest;
    revision.status.imageDigest = revision.spec.containers[0].image;
  }
  const candidateService = { metadata: { annotations: { 'run.googleapis.com/build-id': build.id,
    'run.googleapis.com/build-source-location': sourceLocation } } };
  assert.doesNotThrow(() => assertCandidate({ ...f, build, candidateService }));
  candidateService.metadata.annotations['run.googleapis.com/build-source-location'] += '-wrong';
  assert.throws(() => assertCandidate({ ...f, build, candidateService }));
});

test('Feed content verification holds quota, missing numeric current period and degraded lineage after catalog identity', async () => {
  let mode = 'valid';
  let acquisitions = 0;
  const fetchImpl = async (url, options) => {
    const catalog = JSON.parse(fs.readFileSync(new URL('../../data/feeds.json', import.meta.url)));
    if (url.endsWith('/api/feeds')) return new Response(JSON.stringify(mode === 'wrong-catalog' ? { feeds: [] } : catalog));
    const { id } = JSON.parse(options.body);
    if (id === 'stooq-quote') return new Response('{"error":"source_retired"}', { status: 410 });
    acquisitions++;
    let body = id === 'federal-register' ? { items: [{ id: 'fixture' }] } : { fixture: true };
    if (id === 'bls-cpi') body = mode === 'quota' ? { status: 'REQUEST_NOT_PROCESSED', Results: {} }
      : { status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'CUUR0000SA0', data: [{ year: '2026', period: 'M09', value: mode === 'missing' ? '-' : '100' }] }] } };
    return new Response(JSON.stringify({ body: JSON.stringify(body), httpStatus: 200, fallbackUsed: mode === 'fallback' }));
  };
  const options = { fetchImpl, now: Date.parse('2026-10-27T17:00:00Z') };
  assert.equal((await verifyFeedContent('https://fixture.invalid', options)).catalogCount, 98);
  for (mode of ['quota', 'missing', 'fallback']) await assert.rejects(verifyFeedContent('https://fixture.invalid', options));
  acquisitions = 0;
  mode = 'wrong-catalog';
  await assert.rejects(verifyFeedContent('https://fixture.invalid', options));
  assert.equal(acquisitions, 0, 'No dependent source requests before catalog precondition');
});

function fakeCloud() {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = process.env.FIXTURE_DIR;
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures.json')));
  const stateFile = path.join(dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, 'cloud.log'), JSON.stringify(args) + '\n');
  const output = value => console.log(JSON.stringify(value));
  if (args[0] === 'builds') output(f.build);
  else if (args[1] === 'revisions') output(args[3] === f.candidate ? f.revision : f.beforeRevision);
  else if (args[1] === 'services' && args[2] === 'describe') output(state.current);
  else if (args[1] === 'deploy') { state.current = f.current; }
  else if (args[2] === 'update-traffic') {
    const to = args.indexOf('--to-revisions');
    if (to >= 0) {
      const revisionName = args[to + 1].split('=')[0];
      if (revisionName === f.candidate && process.env.SCENARIO === 'partial') {
        state.current.status.traffic[0] = { revisionName, percent: 50 };
        state.current.status.traffic.push({ revisionName: f.beforeRevision.metadata.name, percent: 50 });
        state.current.spec.traffic = structuredClone(state.current.status.traffic);
        process.exitCode = 9;
      } else {
        state.current.status.traffic = [{ revisionName, percent: 100 }, ...state.current.status.traffic.filter(row => row.tag)];
        state.current.spec.traffic = structuredClone(state.current.status.traffic);
      }
      if (revisionName === f.candidate && process.env.SCENARIO === 'alien') {
        state.current.status.latestCreatedRevisionName = 'unrelated';
        state.current.status.traffic[0].revisionName = 'unrelated';
      }
    } else if (args.includes('--remove-tags')) {
      state.current.status.traffic = state.current.status.traffic.filter(row => !row.tag);
      state.current.spec.traffic = state.current.spec.traffic.filter(row => !row.tag);
    } else throw Error('Unknown traffic mutation');
    state.current.metadata.generation++;
    state.current.status.observedGeneration = state.current.metadata.generation;
  } else throw Error('Unadmitted fake cloud command');
  fs.writeFileSync(stateFile, JSON.stringify(state));
}

for (const scenario of ['success', 'old-healthy', 'partial', 'alien']) {
  test(`Feed actual release helper executes inert ${scenario} promotion/recovery`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-feed-release-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, 'gcp/feed-proxy'), { recursive: true });
    fs.symlinkSync(path.resolve('scripts'), path.join(dir, 'scripts'));
    const f = fixtures();
    json(path.join(dir, 'fixtures.json'), f);
    json(path.join(dir, 'state.json'), { current: f.before });
    json(path.join(dir, 'gcp/feed-proxy/build-manifest.json'), f.manifest);
    const executable = (name, body) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o700 });
    executable('gcloud', `#!${process.execPath}\n(${fakeCloud.toString()})();\n`);
    executable('git', `#!/bin/sh\nprintf '%s\\n' '${sha}'\n`);
    executable('curl', `#!${process.execPath}\nconst f=require(process.env.FIXTURE_DIR+'/fixtures.json');const identity={...f.identity};if(process.env.SCENARIO==='old-healthy'&&process.argv.at(-1).includes('382918878290'))identity.revision='${old}';console.log(JSON.stringify(identity));\n`);
    executable('node', `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='scripts/verify_feed_candidate.mjs')console.log('{}');else{if(!args[0].startsWith('-'))args[0]=fs.realpathSync(args[0]);const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exitCode=r.status??1;}\n`);
    const result = spawnSync('bash', [path.resolve('scripts/deploy_feed_candidate.sh')], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_DIR: dir, SCENARIO: scenario,
        PROJECT_ID: 'fixture', REGION: 'fixture', SERVICE_NAME: service, GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', DIAG_DIR: path.join(dir, 'diagnostics') } });
    const commands = fs.readFileSync(path.join(dir, 'cloud.log'), 'utf8');
    const final = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).current;
    if (scenario === 'success') assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    if (scenario === 'success') assert.equal(final.status.traffic[0].revisionName, candidate);
    else if (scenario === 'alien') {
      assert.equal(final.status.traffic[0].revisionName, 'unrelated');
      assert.doesNotMatch(commands, new RegExp(old + '=100'));
      assert.match(result.stderr, /refusing automatic rollback/);
    } else {
      assert.equal(final.status.traffic[0].revisionName, old);
      assert.match(commands, new RegExp(old + '=100'));
    }
    if (scenario !== 'alien') assert.equal(final.status.traffic.some(row => row.tag), false);
    assert.doesNotMatch(commands, /--update-secrets|--env-vars-file|--allow-unauthenticated/);
  });
}

test('Existing required preflight includes Feed release and BLS fixtures beside unchanged specialized gates', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy-mcp-proxy.yml', import.meta.url), 'utf8').split('\n  deploy:')[0];
  for (const text of ['feed-release.spec.mjs', 'bls-acquisition.spec.mjs', 'verify_mcp_metadata_candidate.spec.mjs',
    'verify_cisa_candidate.spec.mjs', 'PID reuse', 'typed series release report']) assert.ok(workflow.includes(text), text);
  const feedWorkflow = fs.readFileSync(new URL('../../.github/workflows/deploy-feed-proxy.yml', import.meta.url), 'utf8');
  assert.ok(feedWorkflow.indexOf('test "$EXPECTED_SHA" = "$ACTUAL_SHA"') < feedWorkflow.indexOf('google-github-actions/auth'));
  assert.ok(feedWorkflow.indexOf('build_feed_manifest.mjs') < feedWorkflow.indexOf('google-github-actions/auth'));
  assert.match(feedWorkflow, /cancel-in-progress: false/);
});

test('Feed source-preserving release rejects secret synchronization before authentication or mutation', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy-feed-proxy.yml', import.meta.url), 'utf8');
  const block = workflow.slice(workflow.indexOf('      - name: Bind release to reviewed main commit'), workflow.indexOf('      - name: Sync feed registry'));
  const script = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  for (const flag of ['false', 'true', '']) {
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env,
      EXPECTED_SHA: head, ACTUAL_SHA: head, ACTUAL_REF: 'refs/heads/main', SYNC_SECRET_VERSIONS: flag } });
    assert.equal(result.status, flag === 'false' ? 0 : 1, result.stderr);
    if (flag !== 'false') assert.match(result.stdout, /reject secret synchronization before authentication/);
  }
  assert.ok(workflow.indexOf('reject secret synchronization before authentication') < workflow.indexOf('google-github-actions/auth'));
  assert.ok(workflow.indexOf('reject secret synchronization before authentication') < workflow.indexOf('Ensure feed proxy secrets'));
});
