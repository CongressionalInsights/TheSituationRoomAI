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
import { feedBuild, releaseImage } from '../feed_native_build.mjs';
import { nativeBuildFixture } from './fixtures/feed-release/native-build-fixture.mjs';
import { listNodeTests as listOfflineTests } from '../run_node_tests.mjs';
import { fixtureCommand } from './fixtures/command-server.mjs';

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

test('Native image candidate binds independent Build/archive proof and ignores stale source annotations', () => {
  const f = fixtures();
  const native = nativeBuildFixture();
  f.revision.spec.containers[0].image = f.revision.status.imageDigest = releaseImage(tag).replace(/:[^:]+$/, '@' + digest);
  const input = { ...f, ...native, buildMode: 'native-source-v1' };
  assert.doesNotThrow(() => assertCandidate(input));
  assert.throws(() => assertCandidate({ ...input, archive: undefined }));
  assert.throws(() => assertCandidate({ ...input, buildMode: 'unknown' }));
  const wrong = structuredClone(input);
  wrong.revision.spec.containers[0].image = wrong.revision.status.imageDigest = image;
  assert.throws(() => assertCandidate(wrong), /independently built immutable image/);
  for (const field of ['sourceSha', 'contentSha256']) {
    const drift = structuredClone(input);
    drift.archive[field] = 'e'.repeat(field === 'sourceSha' ? 40 : 64);
    assert.throws(() => assertCandidate(drift), /Archive/);
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
  if (process.env.CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API !== 'false') throw Error('API enablement must be disabled');
  fs.appendFileSync(path.join(dir, 'cloud.log'), JSON.stringify(args) + '\n');
  const output = value => console.log(JSON.stringify(value));
  const project = 'situationroom-ai-20260112', number = '382918878290';
  const bucket = 'run-sources-situationroom-ai-20260112-us-central1';
  if (args[0] === 'config' && args[1] === 'get') console.log(args[2] === 'auth/credential_file_override' ? process.env.GOOGLE_GHA_CREDS_PATH :
    args[2] === 'core/should_prompt_to_enable_api' ? process.env.CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API : '');
  else if (args[0] === 'storage' && args[1] === 'buckets') output({ name: bucket, projectNumber: number, location: process.env.SCENARIO === 'wrong-bucket-location' ? 'EU' : 'US-CENTRAL1' });
  else if (args[0] === 'artifacts') output({ name: 'projects/' + project + '/locations/us-central1/repositories/cloud-run-source-deploy', format: process.env.SCENARIO === 'resource-missing' ? 'UNKNOWN' : 'DOCKER' });
  else if (args[0] === 'iam') output({ email: number + '-compute@developer.gserviceaccount.com' });
  else if (args[0] === 'services' && args[1] === 'list') {
    if (!args.some(arg => arg.startsWith('--filter=') && arg.includes('containeranalysis.googleapis.com'))) throw Error('Verification API must be inspected before upload');
    const apis = ['cloudbuild.googleapis.com', 'run.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com'];
    if (process.env.SCENARIO !== 'missing-verification-api') apis.push('containeranalysis.googleapis.com');
    if (process.env.SCENARIO === 'extra-api') apis.push('bigquerystorage.googleapis.com');
    output(apis.map(api => ({ name: 'projects/' + number + '/services/' + api, config: { name: api }, state: 'ENABLED' })));
  }
  else if (args[0] === 'storage' && args[1] === 'cp') {
    if (!args.includes('--if-generation-match=0')) throw Error('Source upload is not create-only');
    const archive = JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics/archive.json')));
    state.object = { bucket, name: archive.object, generation: '123', size: String(archive.bytes), md5Hash: archive.md5 };
  } else if (args[0] === 'storage' && args[1] === 'objects') {
    const object = { ...state.object };
    if (process.env.SCENARIO === 'wrong-upload') object.md5Hash = 'wrong';
    output(object);
  }
  else if (args[0] === 'builds' && args[1] === 'submit') {
    if (!args.includes('--no-source')) throw Error('Source must be explicitly pinned');
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics/build-config.json')));
    const archive = JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics/archive.json')));
    state.build = { ...config, id: 'build-1', projectId: project, name: 'projects/' + number + '/locations/us-central1/builds/build-1', status: 'SUCCESS',
      sourceProvenance: { resolvedStorageSource: config.source.storageSource,
        fileHashes: { [archive.uri + '#123']: { fileHash: [{ type: 'SHA256', value: archive.sha256 }] } } },
      results: { images: [{ name: archive.image, digest: 'sha256:' + 'a'.repeat(64) }] } };
    output(state.build);
    if (process.env.SCENARIO === 'submit-failure') process.exitCode = 9;
  } else if (args[0] === 'builds') {
    const build = structuredClone(state.build);
    if (process.env.SCENARIO === 'missing-proof') build.sourceProvenance = {};
    if (process.env.SCENARIO === 'wrong-generation') build.sourceProvenance.resolvedStorageSource.generation = '456';
    if (process.env.SCENARIO === 'wrong-archive-hash') Object.values(build.sourceProvenance.fileHashes)[0].fileHash[0].value = 'wrong';
    if (process.env.SCENARIO === 'wrong-build-image') build.results.images[0].name = 'wrong';
    if (process.env.SCENARIO === 'extra-build-image') build.results.images.push({ name: 'gcr.io/other/unreviewed', digest: build.results.images[0].digest });
    if (process.env.SCENARIO === 'url-safe-hash') Object.values(build.sourceProvenance.fileHashes)[0].fileHash[0].value =
      Object.values(build.sourceProvenance.fileHashes)[0].fileHash[0].value.replaceAll('+', '-').replaceAll('/', '_');
    output(build);
  }
  else if (args[1] === 'revisions') output(args[3] === f.candidate ? f.revision : f.beforeRevision);
  else if (args[1] === 'services' && args[2] === 'describe') output(state.current);
  else if (args[1] === 'deploy') {
    if (process.env.SCENARIO === 'api-disabled-at-deploy') process.exitCode = 9;
    else state.current = f.current;
  }
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

for (const scenario of ['success', 'old-healthy', 'partial', 'alien', 'candidate-success', 'candidate-content-failure', 'candidate-feature-failure',
  'missing-proof', 'wrong-generation', 'wrong-archive-hash', 'wrong-build-image', 'resource-missing', 'wrong-upload', 'submit-failure',
  'extra-api', 'url-safe-hash', 'extra-build-image', 'wrong-bucket-location', 'bad-credential-override', 'api-disabled-at-deploy', 'missing-verification-api']) {
  test(`Feed actual release helper executes inert ${scenario} promotion/recovery`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-feed-release-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, 'gcp/feed-proxy'), { recursive: true });
    fs.symlinkSync(path.resolve('scripts'), path.join(dir, 'scripts'));
    const f = fixtures();
    const sourceDir = path.join(dir, 'gcp/feed-proxy');
    fs.writeFileSync(path.join(sourceDir, 'server.js'), 'console.log("fixture");');
    fs.writeFileSync(path.join(sourceDir, 'feeds.json'), '{"feeds":[]}');
    fs.writeFileSync(path.join(sourceDir, 'package.json'), '{"type":"module","engines":{"node":"24.x"}}');
    f.manifest = buildFeedManifest(sourceDir, sha);
    f.identity = { available: true, ...f.manifest, revision: candidate, service };
    f.revision.spec.containers[0].image = f.revision.status.imageDigest = releaseImage(tag).replace(/:[^:]+$/, '@' + digest);
    f.current.spec.template.spec.containers[0].image = f.revision.spec.containers[0].image;
    const credentialPath = path.join(dir, 'workflow-credential-metadata.json');
    json(credentialPath, { type: 'service_account', client_email: scenario === 'bad-credential-override' ? 'unreviewed@fixture' : feedBuild.principal,
      private_key: 'inert-fixture-never-print' });
    json(path.join(dir, 'fixtures.json'), f);
    json(path.join(dir, 'state.json'), { current: f.before });
    json(path.join(dir, 'gcp/feed-proxy/build-manifest.json'), f.manifest);
    const executable = (name, body) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o700 });
    await fixtureCommand(t, path.join(bin, 'gcloud'), fakeCloud,
      ['FIXTURE_DIR', 'SCENARIO', 'CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API', 'GOOGLE_GHA_CREDS_PATH']);
    executable('git', `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='show')process.stdout.write(fs.readFileSync(process.env.FIXTURE_DIR+'/gcp/feed-proxy/'+a[1].split('/').at(-1)));else if(a[0]==='ls-tree')console.log(['feeds.json','package.json','server.js'].join('\\n'));else console.log('${sha}');\n`);
    executable('curl', `#!${process.execPath}\nconst f=require(process.env.FIXTURE_DIR+'/fixtures.json');const identity={...f.identity};if(process.env.SCENARIO==='old-healthy'&&process.argv.at(-1).includes('382918878290'))identity.revision='${old}';console.log(JSON.stringify(identity));\n`);
    // Enter each real helper's CLI main in this fresh fixture process. Its argv,
    // environment and exit behavior remain real; avoid a second Node startup.
    executable('node', `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='scripts/verify_feed_candidate.mjs'||args[0]==='scripts/verify_money_candidate.mjs'){fs.appendFileSync(process.env.FIXTURE_DIR+'/verification.log',JSON.stringify(args)+'\\n');if((process.env.SCENARIO==='candidate-content-failure'&&args[0].includes('verify_feed_candidate'))||(process.env.SCENARIO==='candidate-feature-failure'&&args[0].includes('verify_money_candidate')))process.exitCode=9;else console.log('{}');}else if(args[0]&&!args[0].startsWith('-')){const file=fs.realpathSync(args[0]);process.argv=[process.execPath,file,...args.slice(1)];import(require('node:url').pathToFileURL(file).href).catch(error=>{console.error(error);process.exitCode=1;});}else{const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exitCode=r.status??1;}\n`);
    const result = spawnSync('bash', [path.resolve('scripts/deploy_feed_candidate.sh')], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_DIR: dir, SCENARIO: scenario,
        GOOGLE_GHA_CREDS_PATH: credentialPath, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: credentialPath, GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
        PROJECT_ID: feedBuild.project, REGION: feedBuild.region, SERVICE_NAME: service, GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', EXPECTED_SHA: sha, CANDIDATE_ONLY: String(scenario.startsWith('candidate-')), SYNC_SECRET_VERSIONS: 'false', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', DIAG_DIR: path.join(dir, 'diagnostics') } });
    const commands = fs.readFileSync(path.join(dir, 'cloud.log'), 'utf8');
    const final = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).current;
    const fullSuccess = ['success', 'extra-api', 'url-safe-hash'].includes(scenario);
    if (fullSuccess || scenario === 'candidate-success') assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const prebuildStop = ['missing-proof', 'wrong-generation', 'wrong-archive-hash', 'wrong-build-image', 'resource-missing', 'wrong-upload', 'submit-failure',
      'extra-build-image', 'wrong-bucket-location', 'bad-credential-override', 'missing-verification-api'].includes(scenario);
    if (prebuildStop) {
      assert.deepEqual(final, f.before);
      assert.doesNotMatch(commands, /"run","deploy"|update-traffic/);
      assert.equal(fs.existsSync(path.join(dir, 'verification.log')), false);
    } else if (scenario.startsWith('candidate-')) {
      assert.equal(final.status.traffic[0].revisionName, old);
      assert.doesNotMatch(commands, /--to-revisions|delete|secrets|(?:add|set)-iam-policy|--impersonate/);
      const checks = fs.readFileSync(path.join(dir, 'verification.log'), 'utf8');
      assert.doesNotMatch(checks, /382918878290/);
      assert.match(checks, /verify_feed_candidate/);
      if (scenario !== 'candidate-content-failure') assert.match(checks, /verify_money_candidate/);
    } else if (fullSuccess) assert.equal(final.status.traffic[0].revisionName, candidate);
    else if (scenario === 'api-disabled-at-deploy') {
      assert.deepEqual(final, f.before);
      assert.doesNotMatch(commands, /update-traffic|"enable"/);
    }
    else if (scenario === 'alien') {
      assert.equal(final.status.traffic[0].revisionName, 'unrelated');
      assert.doesNotMatch(commands, new RegExp(old + '=100'));
      assert.match(result.stderr, /refusing automatic rollback/);
    } else {
      assert.equal(final.status.traffic[0].revisionName, old);
      assert.match(commands, new RegExp(old + '=100'));
    }
    if (scenario !== 'alien') assert.equal(final.status.traffic.some(row => row.tag), false);
    if (scenario === 'missing-verification-api') {
      assert.match(result.stderr, /containeranalysis\.googleapis\.com/);
      assert.doesNotMatch(commands, /"storage","cp"|"builds"/);
    }
    assert.doesNotMatch(commands, /--update-secrets|--env-vars-file|--allow-unauthenticated/);
    assert.doesNotMatch(commands, /"create"|"enable"|--source/);
    assert.ok(!(result.stdout + result.stderr).includes('inert-fixture-never-print'));
    for (const args of commands.trim().split('\n').map(line => JSON.parse(line)).filter(args => args[0] === 'iam')) {
      assert.deepEqual(args.slice(0, 4), ['iam', 'service-accounts', 'describe', feedBuild.buildAccount]);
    }
    assert.ok(commands.trim().split('\n').map(line => JSON.parse(line)).filter(args => args[0] === 'builds' && args[1] === 'submit').length <= 1);
  });
}

test('Existing required preflight includes Feed release and BLS fixtures beside unchanged specialized gates', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy-mcp-proxy.yml', import.meta.url), 'utf8').split('\n  deploy:')[0];
  assert.match(workflow, /run: \/usr\/bin\/time -v npm test/);
  const inventory = listOfflineTests();
  for (const file of ['feed-release', 'feed-native-build', 'bls-acquisition', 'verify_mcp_metadata_candidate',
    'verify_cisa_candidate', 'monitor', 'mcp-native-release', 'mcp-proxy', 'briefing', 'acled-pagination']) {
    assert.ok(inventory.includes(`scripts/test/${file}.spec.mjs`), file);
  }
  const feedWorkflow = fs.readFileSync(new URL('../../.github/workflows/deploy-feed-proxy.yml', import.meta.url), 'utf8');
  assert.match(feedWorkflow, /node --test scripts\/test\/feed-native-build\.spec\.mjs scripts\/test\/feed-release\.spec\.mjs scripts\/test\/candidate-only\.spec\.mjs/);
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
      EXPECTED_SHA: head, ACTUAL_SHA: head, ACTUAL_REF: 'refs/heads/main', CANDIDATE_ONLY: 'false', SYNC_SECRET_VERSIONS: flag } });
    assert.equal(result.status, flag === 'false' ? 0 : 1, result.stderr);
    if (flag !== 'false') assert.match(result.stdout, /reject secret synchronization before authentication/);
  }
  assert.ok(workflow.indexOf('reject secret synchronization before authentication') < workflow.indexOf('google-github-actions/auth'));
  assert.ok(workflow.indexOf('reject secret synchronization before authentication') < workflow.indexOf('Ensure feed proxy secrets'));
  assert.match(workflow, /CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API: 'false'/);
  const helper = fs.readFileSync(new URL('../deploy_feed_candidate.sh', import.meta.url), 'utf8');
  assert.match(helper, /export CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false/);
});
