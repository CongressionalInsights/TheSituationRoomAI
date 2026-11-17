import test from 'node:test';
import { nativeBuildFixture } from './helpers/feed-native.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildFeedManifest } from '../build_feed_manifest.mjs';
import { feedBuild, releaseImage, createSourceArchive, nativeBuildConfig, verifyNativeBuild, verifyNativePreconditions,
  effectiveReleaseIdentity, digestBytes } from '../feed_native_build.mjs';

const sha = 'c'.repeat(40);
const digest = 'sha256:' + 'a'.repeat(64);

test('Native Feed build requires independently pinned generation, archive hash and exact immutable output', () => {
  const fixture = nativeBuildFixture();
  assert.equal(verifyNativeBuild(fixture), fixture.archive.image.replace(/:[^:]+$/, '@' + digest));
  for (const mutate of [
    f => delete f.build.source, f => delete f.build.sourceProvenance,
    f => { f.build.sourceProvenance.resolvedStorageSource = { ...f.build.source.storageSource, generation: '456' }; },
    f => { f.build.sourceProvenance.fileHashes = {}; },
    f => { f.build.sourceProvenance.fileHashes[`${f.archive.uri}#123`].fileHash[0].value = 'wrong'; },
    f => { f.object.generation = '456'; }, f => { f.object.md5Hash = 'wrong'; },
    f => { f.object.size = '41'; }, f => { f.object.bucket = 'other'; },
    f => { f.submitted.id = 'other'; }, f => { f.build.projectId = 'other'; },
    f => { f.build.name = f.build.name.replace('/us-central1/', '/other/'); },
    f => { f.build.serviceAccount = 'other'; }, f => { f.build.status = 'FAILURE'; },
    f => { f.build.options.requestedVerifyOption = 'BEST_EFFORT'; },
    f => { f.build.steps[0].args = ['unreviewed']; },
    f => { f.build.results.images[0].name = 'mutable:other'; },
    f => { f.build.results.images.push(f.build.results.images[0]); },
    f => { f.build.results.images[0].digest = 'latest'; }, f => { f.tag = 'gha-456-1'; },
    f => { f.archive.uri = 'gs://unrelated/object'; }, f => { f.archive.object = '../unowned'; },
    f => { f.build.images.push('gcr.io/other/unreviewed'); },
    f => { f.build.artifacts = { images: ['gcr.io/other/unreviewed'] }; },
    f => { f.build.results.images.push({ name: 'gcr.io/other/unreviewed', digest }); }
  ]) {
    const bad = structuredClone(fixture);
    mutate(bad);
    assert.throws(() => verifyNativeBuild(bad));
  }
  assert.throws(() => releaseImage('unowned-tag'));
  const missing = structuredClone(fixture.object);
  delete missing.generation;
  assert.throws(() => nativeBuildConfig(fixture.archive, missing), /generation/);
  assert.ok(fixture.config.steps[0].args.includes(feedBuild.builder));
  assert.match(feedBuild.builder, /@sha256:[a-f0-9]{64}$/);
});

test('Native archive digests compare decoded bytes across REST and SDK base64 alphabets', () => {
  const fixture = nativeBuildFixture();
  assert.match(fixture.archive.sha256, /\+/);
  assert.match(fixture.archive.sha256, /\//);
  fixture.build.sourceProvenance.fileHashes[`${fixture.archive.uri}#123`].fileHash[0].value =
    fixture.archive.sha256.replaceAll('+', '-').replaceAll('/', '_');
  fixture.object.md5Hash = fixture.object.md5Hash.replaceAll('+', '-').replaceAll('/', '_');
  assert.doesNotThrow(() => verifyNativeBuild(fixture));
  const alias = { name: fixture.archive.image.replace(/:[^:]+$/, ''), digest };
  fixture.build.results.images.push(alias);
  fixture.build.artifacts = { images: fixture.config.images };
  assert.doesNotThrow(() => verifyNativeBuild(fixture));
  for (const bad of ['not-a-digest', fixture.archive.sha256 + '=', ' '.repeat(44), Buffer.alloc(31).toString('base64')]) {
    assert.throws(() => digestBytes(bad, 32));
  }
});

test('Native Feed prerequisites require existing exact resources, API state and identities without creating access', () => {
  const fixture = { identity: { principal: feedBuild.principal, credentialType: 'service_account_override', workflowBindingMatched: true },
    bucket: { name: feedBuild.bucket, projectNumber: feedBuild.projectNumber, location: 'US-CENTRAL1' },
    repository: { name: `projects/${feedBuild.project}/locations/${feedBuild.region}/repositories/${feedBuild.repository}`, format: 'DOCKER' },
    account: { email: feedBuild.buildAccount }, services:
      ['cloudbuild.googleapis.com', 'run.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com', 'containeranalysis.googleapis.com']
        .map(api => ({ name: `projects/${feedBuild.projectNumber}/services/${api}`, config: { name: api }, state: 'ENABLED' })) };
  assert.doesNotThrow(() => verifyNativePreconditions(fixture));
  const missingVerification = structuredClone(fixture);
  missingVerification.services.pop();
  assert.throws(() => verifyNativePreconditions(missingVerification), /missing: containeranalysis\.googleapis\.com/);
  const disabledVerification = structuredClone(fixture);
  disabledVerification.services.at(-1).state = 'DISABLED';
  assert.throws(() => verifyNativePreconditions(disabledVerification), /containeranalysis\.googleapis\.com must already be enabled/);
  const extra = structuredClone(fixture);
  extra.services.push({ name: 'projects/other/services/bigquerystorage.googleapis.com', config: { name: 'bigquerystorage.googleapis.com' }, state: 'ENABLED' });
  assert.doesNotThrow(() => verifyNativePreconditions(extra));
  for (const mutate of [f => { f.identity.principal = 'other'; }, f => { f.identity.workflowBindingMatched = false; }, f => { f.bucket.projectNumber = 'other'; },
    f => { f.bucket.location = 'EU'; }, f => { delete f.bucket.location; },
    f => { f.repository.name = 'other'; }, f => { f.repository.format = 'MAVEN'; },
    f => { f.account.disabled = true; }, f => { f.account.email = 'other'; },
    f => { f.services[0].state = 'DISABLED'; }, f => { f.services.push(f.services[0]); },
    f => { f.services[3].name = 'projects/other/services/storage.googleapis.com'; }]) {
    const bad = structuredClone(fixture);
    mutate(bad);
    assert.throws(() => verifyNativePreconditions(bad));
  }
});

test('Effective release identity requires the existing workflow override and rejects conflicting credentials without disclosing them', () => {
  const settings = { 'auth/credential_file_override': '/fixture/gha.json', 'core/should_prompt_to_enable_api': 'false' };
  const env = { GOOGLE_GHA_CREDS_PATH: '/fixture/gha.json', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/fixture/gha.json',
    GOOGLE_APPLICATION_CREDENTIALS: '/fixture/gha.json' };
  const metadata = JSON.stringify({ type: 'service_account', client_email: feedBuild.principal, private_key: 'private-fixture-never-print' });
  const run = (properties = settings, environment = env, contents = metadata) => effectiveReleaseIdentity({
    getProperty: name => properties[name] || '', env: environment, readFile: () => contents });
  assert.equal(run().principal, feedBuild.principal);
  for (const properties of [ { ...settings, 'auth/impersonate_service_account': 'other' },
    { ...settings, 'core/should_prompt_to_enable_api': 'true' },
    { ...settings, 'auth/access_token_file': '/fixture/token' }, { ...settings, 'auth/disable_credentials': 'True' },
    { ...settings, 'auth/credential_file_override': '/other/file' }, {} ]) assert.throws(() => run(properties));
  for (const environment of [{ ...env, CLOUDSDK_AUTH_ACCESS_TOKEN: 'private-fixture-never-print' },
    { ...env, GOOGLE_APPLICATION_CREDENTIALS: '/other/file' }, {}]) {
    assert.throws(() => run(settings, environment), error => !String(error).includes('private-fixture-never-print'));
  }
  for (const contents of ['private-fixture-never-print', JSON.stringify({ type: 'external_account', private_key: 'private-fixture-never-print' })]) {
    assert.throws(() => run(settings, env, contents), error => !String(error).includes('private-fixture-never-print'));
  }
});

test('Native Feed archive contains only exact reviewed regular files plus its generated identity manifest', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-native-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  const files = { 'server.js': 'console.log("fixture");', 'package.json': '{"type":"module","engines":{"node":"24.x"}}', 'feeds.json': '{"feeds":[]}' };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(source, name), bytes);
  const manifest = buildFeedManifest(source, sha);
  fs.writeFileSync(path.join(source, 'build-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, '.env'), 'not-reviewed-fixture');
  const git = (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'ls-tree') return Buffer.from(Object.keys(files).sort().join('\n') + '\n');
    assert.equal(args[0], 'show');
    assert.ok(args[1].startsWith(`${sha}:gcp/feed-proxy/`));
    return Buffer.from(files[args[1].split('/').at(-1)]);
  };
  const archive = createSourceArchive(source, dir, sha, 'gha-123-1', { git });
  const archived = execFileSync('tar', ['-tzf', path.join(dir, 'source.tgz')], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(archived, [...Object.keys(files), 'build-manifest.json'].sort());
  const permissions = execFileSync('tar', ['-tvzf', path.join(dir, 'source.tgz')], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(permissions.every(line => line.startsWith('-rw-r--r--')), 'Buildpack user must be able to read every packaged file');
  const bytes = fs.readFileSync(path.join(dir, 'source.tgz'));
  assert.equal(archive.sha256, createHash('sha256').update(bytes).digest('base64'));
  assert.equal(archive.md5, createHash('md5').update(bytes).digest('base64'));
  assert.throws(() => createSourceArchive(source, dir, 'e'.repeat(40), 'gha-123-1', { git }), /reviewed source/);
  const omitted = structuredClone(manifest);
  omitted.files = omitted.files.filter(file => file.path !== 'server.js');
  omitted.contentSha256 = createHash('sha256').update(JSON.stringify(omitted.files)).digest('hex');
  fs.writeFileSync(path.join(source, 'build-manifest.json'), JSON.stringify(omitted));
  assert.throws(() => createSourceArchive(source, dir, sha, 'gha-123-1', { git }), /omits or adds/);
  fs.writeFileSync(path.join(source, 'build-manifest.json'), JSON.stringify(manifest));
  fs.appendFileSync(path.join(source, 'server.js'), 'drift');
  assert.throws(() => createSourceArchive(source, dir, sha, 'gha-123-1', { git }), /bytes changed/);
  fs.unlinkSync(path.join(source, 'server.js'));
  fs.symlinkSync(path.join(source, '.env'), path.join(source, 'server.js'));
  assert.throws(() => createSourceArchive(source, dir, sha, 'gha-123-1', { git }), /regular file/);
});
