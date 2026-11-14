import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const feedBuild = Object.freeze({
  project: 'situationroom-ai-20260112', projectNumber: '382918878290', region: 'us-central1',
  service: 'situation-room-feed', bucket: 'run-sources-situationroom-ai-20260112-us-central1',
  repository: 'cloud-run-source-deploy',
  principal: 'gh-actions-deployer@situationroom-ai-20260112.iam.gserviceaccount.com',
  buildAccount: '382918878290-compute@developer.gserviceaccount.com',
  builder: 'us-central1-docker.pkg.dev/serverless-runtimes/google-24-full/builder/universal@sha256:eed34031fd9ba4ecce8d844f7ef0b97ab06811649b64f4312853de8c82f3b981'
});
const hash = (algorithm, value, encoding = 'hex') => createHash(algorithm).update(value).digest(encoding);
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`)));
const write = (dir, name, value) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2));
const requiredApis = ['cloudbuild.googleapis.com', 'run.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com',
  'containeranalysis.googleapis.com'];
export function digestBytes(value, length) {
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value), 'Malformed native digest');
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Buffer.from(standard, 'base64');
  assert.equal(bytes.length, length, 'Native digest has the wrong byte length');
  const canonical = bytes.toString('base64');
  assert.ok(standard === canonical || standard === canonical.replace(/=+$/, ''), 'Noncanonical native digest');
  return bytes;
}

export function effectiveReleaseIdentity({ getProperty, env = process.env, readFile = fs.readFileSync }) {
  assert.equal(getProperty('core/should_prompt_to_enable_api').toLowerCase(), 'false', 'Native API enablement must be disabled');
  assert.ok(!env.CLOUDSDK_AUTH_ACCESS_TOKEN, 'Token overrides are not admitted for a release');
  assert.ok(!getProperty('auth/impersonate_service_account'), 'Release impersonation is not admitted');
  assert.ok(!getProperty('auth/access_token_file'), 'Token-file overrides are not admitted');
  assert.ok(['', 'false', '0'].includes(getProperty('auth/disable_credentials').toLowerCase()), 'Credentials must not be disabled');
  const override = getProperty('auth/credential_file_override');
  assert.ok(override && env.GOOGLE_GHA_CREDS_PATH, 'Existing workflow credential-file binding is required');
  assert.equal(path.resolve(override), path.resolve(env.GOOGLE_GHA_CREDS_PATH), 'Credential override is not the workflow binding');
  for (const name of ['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    if (env[name]) assert.equal(path.resolve(env[name]), path.resolve(override), 'Conflicting credential-file bindings');
  }
  let metadata;
  try { metadata = JSON.parse(readFile(override, 'utf8')); }
  catch { throw Error('Unable to read release credential metadata'); }
  assert.ok(metadata.type === 'service_account' && metadata.client_email === feedBuild.principal,
    'Effective release credential identity differs');
  return { principal: feedBuild.principal, credentialType: 'service_account_override', workflowBindingMatched: true };
}
export function releaseImage(tag) {
  assert.match(tag, /^gha-[0-9]+-[0-9]+$/);
  return `${feedBuild.region}-docker.pkg.dev/${feedBuild.project}/${feedBuild.repository}/${feedBuild.service}:${tag}`;
}

export function verifyNativePreconditions({ identity, bucket, repository, account, services }) {
  assert.deepEqual(identity, { principal: feedBuild.principal, credentialType: 'service_account_override', workflowBindingMatched: true },
    'Effective release identity was not verified');
  assert.equal(bucket.name, feedBuild.bucket, 'Wrong existing source bucket');
  assert.equal(String(bucket.projectNumber), feedBuild.projectNumber, 'Source bucket belongs to another project');
  assert.equal(bucket.location?.toLowerCase(), feedBuild.region, 'Source bucket location differs or is unknown');
  const names = [feedBuild.project, feedBuild.projectNumber].map(project =>
    `projects/${project}/locations/${feedBuild.region}/repositories/${feedBuild.repository}`);
  assert.ok(names.includes(repository.name), 'Wrong existing artifact repository');
  assert.equal(repository.format, 'DOCKER', 'Artifact repository is not Docker');
  assert.equal(account.email, feedBuild.buildAccount, 'Unexpected build service account');
  assert.ok(!account.disabled, 'Existing build service account is disabled');
  const selected = services.filter(service => requiredApis.includes(service.config?.name));
  const missing = requiredApis.filter(api => !selected.some(service => service.config.name === api));
  assert.equal(missing.length, 0, `Required enabled APIs are missing: ${missing.join(', ')}`);
  assert.equal(selected.length, requiredApis.length, 'Required enabled APIs are missing or ambiguous');
  assert.equal(new Set(selected.map(service => service.config.name)).size, requiredApis.length);
  for (const api of requiredApis) {
    const service = selected.find(service => service.config.name === api);
    assert.equal(service.state, 'ENABLED', `${api} must already be enabled`);
    assert.ok([`projects/${feedBuild.project}`, `projects/${feedBuild.projectNumber}`].some(parent =>
      service.name === `${parent}/services/${api}`), 'API precondition belongs to another project');
  }
}

export function createSourceArchive(sourceDir, outputDir, sourceSha, tag, { git = execFileSync } = {}) {
  const manifestBytes = fs.readFileSync(path.join(sourceDir, 'build-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(manifest.sourceSha, sourceSha, 'Manifest is not the exact reviewed source');
  assert.equal(manifest.contentSha256, hash('sha256', JSON.stringify(manifest.files)), 'Invalid packaged manifest');
  const names = manifest.files.map(file => file.path);
  assert.equal(new Set(names).size, names.length, 'Duplicate packaged path');
  const reviewedNames = git('git', ['ls-tree', '-r', '--name-only', `${sourceSha}:gcp/feed-proxy`]).toString().trim().split('\n');
  assert.deepEqual([...names].sort(), reviewedNames.sort(), 'Packaged manifest omits or adds reviewed source files');
  assert.ok(names.includes('server.js') && names.includes('package.json') && names.includes('feeds.json'));
  const verified = [];
  for (const file of manifest.files) {
    assert.match(file.path, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Only reviewed top-level source files may be archived');
    const local = path.join(sourceDir, file.path);
    assert.ok(fs.lstatSync(local).isFile() && !fs.lstatSync(local).isSymbolicLink(), 'Packaged source is not a regular file');
    const bytes = fs.readFileSync(local);
    assert.equal(hash('sha256', bytes), file.sha256, 'Packaged bytes changed after manifest');
    assert.equal(hash('sha256', git('git', ['show', `${sourceSha}:gcp/feed-proxy/${file.path}`])), file.sha256,
      'Packaged bytes differ from the reviewed Git source');
    verified.push({ name: file.path, bytes });
  }
  assert.equal(JSON.parse(verified.find(file => file.name === 'package.json').bytes).engines?.node, '24.x');
  const archivePath = path.join(outputDir, 'source.tgz');
  // Archive verified buffers, not a second read of a potentially changing checkout.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-feed-source-'));
  try {
    for (const file of verified) fs.writeFileSync(path.join(staging, file.name), file.bytes, { mode: 0o644, flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'build-manifest.json'), manifestBytes, { mode: 0o644, flag: 'wx' });
    execFileSync('tar', ['-czf', archivePath, '-C', staging, '--', ...names.sort(), 'build-manifest.json']);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const bytes = fs.readFileSync(archivePath);
  const object = `services/${feedBuild.service}/releases/${tag}/source.tgz`;
  return { sourceSha, contentSha256: manifest.contentSha256, bucket: feedBuild.bucket, object,
    uri: `gs://${feedBuild.bucket}/${object}`, image: releaseImage(tag), bytes: bytes.length,
    md5: hash('md5', bytes, 'base64'), sha256: hash('sha256', bytes, 'base64') };
}

export function nativeBuildConfig(archive, object) {
  const tag = archive.object.match(/^services\/situation-room-feed\/releases\/(gha-[0-9]+-[0-9]+)\/source\.tgz$/)?.[1];
  assert.ok(tag, 'Source archive is not release-owned');
  assert.equal(archive.image, releaseImage(tag), 'Archive image is not release-owned');
  assert.equal(archive.uri, `gs://${feedBuild.bucket}/${archive.object}`, 'Invalid archive URI');
  assert.match(archive.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(archive.contentSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0);
  assert.match(archive.sha256, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(object.bucket, feedBuild.bucket, 'Wrong uploaded bucket');
  assert.equal(object.bucket, archive.bucket);
  assert.equal(object.name, archive.object, 'Wrong uploaded object');
  assert.match(object.generation, /^[1-9][0-9]*$/, 'Missing native object generation');
  assert.equal(String(object.size), String(archive.bytes), 'Uploaded archive size differs');
  assert.deepEqual(digestBytes(object.md5Hash, 16), digestBytes(archive.md5, 16), 'Uploaded archive checksum differs');
  return {
    source: { storageSource: { bucket: object.bucket, object: object.name, generation: object.generation } },
    steps: [{ name: 'gcr.io/k8s-skaffold/pack', entrypoint: 'pack', args: ['build', archive.image,
      '--network', 'cloudbuild', '--builder', feedBuild.builder, '--env', 'GOOGLE_NODEJS_VERSION=24.x',
      '--env', 'GOOGLE_ENTRYPOINT=node server.js'] }],
    images: [archive.image], serviceAccount: `projects/${feedBuild.project}/serviceAccounts/${feedBuild.buildAccount}`,
    options: { logging: 'CLOUD_LOGGING_ONLY', sourceProvenanceHash: ['SHA256'], requestedVerifyOption: 'VERIFIED' }
  };
}

export function verifyNativeBuild({ build, submitted, archive, object, config, tag }) {
  assert.equal(archive.image, releaseImage(tag), 'Archive belongs to another release');
  assert.deepEqual(config, nativeBuildConfig(archive, object), 'Build configuration differs from native-source contract');
  assert.equal(build.id, submitted.id, 'Build readback differs from submitted build');
  assert.match(build.id, /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/);
  assert.equal(build.projectId, feedBuild.project, 'Build belongs to another project');
  assert.ok([feedBuild.project, feedBuild.projectNumber].some(project =>
    build.name === `projects/${project}/locations/${feedBuild.region}/builds/${build.id}`), 'Build region/name mismatch');
  assert.equal(build.status, 'SUCCESS', 'Native source build did not succeed');
  assert.deepEqual(Object.keys(build.source || {}), ['storageSource'], 'Native build does not have the exact storage source variant');
  for (const field of ['bucket', 'object', 'generation']) {
    assert.equal(build.source.storageSource[field], config.source.storageSource[field], `Native source ${field} differs`);
    assert.equal(build.sourceProvenance?.resolvedStorageSource?.[field], config.source.storageSource[field],
      `Native resolved source ${field} differs or is unavailable`);
  }
  for (const key of ['steps', 'serviceAccount', 'options']) {
    if (key === 'steps') {
      assert.equal(build.steps.length, 1);
      for (const field of ['name', 'entrypoint', 'args']) assert.deepEqual(build.steps[0][field], config.steps[0][field]);
    } else if (key === 'options') {
      for (const field of Object.keys(config.options)) assert.deepEqual(build.options?.[field], config.options[field]);
    } else assert.deepEqual(build[key], config[key], `Native build ${key} differs`);
  }
  assert.ok(build.images || build.artifacts?.images, 'Native build image destinations are missing');
  for (const images of [build.images, build.artifacts?.images]) {
    if (images !== undefined) assert.deepEqual(images, config.images, 'Native build requests other image destinations');
  }
  const uri = `${archive.uri}#${object.generation}`;
  const hashes = build.sourceProvenance?.fileHashes?.[uri]?.fileHash?.filter(row => row.type === 'SHA256');
  assert.equal(hashes?.length, 1, 'Native archive SHA256 is missing or ambiguous');
  assert.deepEqual(digestBytes(hashes[0].value, 32), digestBytes(archive.sha256, 32), 'Native archive SHA256 differs');
  const images = build.results?.images;
  assert.ok(Array.isArray(images) && images.length >= 1 && images.length <= 2, 'Built image results are missing or ambiguous');
  const expected = images.filter(image => image.name === archive.image);
  assert.equal(expected.length, 1, 'Built image identity is missing or ambiguous');
  assert.match(expected[0].digest, /^sha256:[a-f0-9]{64}$/);
  const repositoryImage = archive.image.slice(0, archive.image.lastIndexOf(':'));
  assert.ok(images.every(image => [archive.image, repositoryImage].includes(image.name) && image.digest === expected[0].digest),
    'Build pushed another image destination or digest');
  return `${repositoryImage}@${expected[0].digest}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dir, sourceSha, tag] = process.argv.slice(2);
  if (mode === 'identity') {
    const getProperty = property => {
      try { return execFileSync('gcloud', ['config', 'get', property], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
      catch { throw Error('Unable to inspect effective release credential settings'); }
    };
    write(dir, 'identity', effectiveReleaseIdentity({ getProperty }));
  } else if (mode === 'preconditions') {
    verifyNativePreconditions({ identity: read(dir, 'identity'), bucket: read(dir, 'bucket'),
      repository: read(dir, 'repository'), account: read(dir, 'build-account'),
      services: read(dir, 'apis') });
  } else if (mode === 'archive') write(dir, 'archive', createSourceArchive(path.resolve('gcp/feed-proxy'), dir, sourceSha, tag));
  else if (mode === 'config') write(dir, 'build-config', nativeBuildConfig(read(dir, 'archive'), read(dir, 'source-object')));
  else if (mode === 'image') console.log(verifyNativeBuild({ build: read(dir, 'build'), submitted: read(dir, 'build-submitted'),
    archive: read(dir, 'archive'), object: read(dir, 'source-object'), config: read(dir, 'build-config'), tag: read(dir, 'release').tag }));
  else throw Error('Unknown native Feed build operation');
}
