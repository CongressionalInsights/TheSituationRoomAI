// MCP adapter over the verified Feed native build and read-only state primitives.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { feedBuild, effectiveReleaseIdentity, verifyNativePreconditions, createSourceArchive, nativeBuildConfig, verifyNativeBuild } from './feed_native_build.mjs';
import { buildFeedManifest } from './build_feed_manifest.mjs';
import { revisionConfig, servicePolicy, traffic } from './verify_feed_release.mjs';
export const mcpBuild = Object.freeze({ ...feedBuild, service: 'situation-room-mcp', sourcePath: 'gcp/mcp-proxy', nodeVersion: '24.22.1' });
export const archiveMcp = (root, dir, sha, tag, options = {}) => createSourceArchive(root, dir, sha, tag, { ...options, contract: mcpBuild });
export const configMcp = (archive, object) => nativeBuildConfig(archive, object, mcpBuild);
export const imageMcp = data => verifyNativeBuild({ ...data, contract: mcpBuild });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const equal = (a, b, message) => assert.deepEqual(stable(a), stable(b), message);
const tags = s => (s.status?.traffic || []).filter(x => x.tag).map(({ tag, revisionName }) => ({ tag, revisionName })).sort((a,b) => a.tag.localeCompare(b.tag));
const template = s => revisionConfig({ spec: s.spec.template.spec, metadata: s.spec.template.metadata });
export function assertMcpState({ before, current, iamBefore, iamCurrent, candidate, tag, oldTag = '', phase, beforeRevision, revision, image }) {
  assert.equal(before.metadata.name, mcpBuild.service);
  assert.equal(current.metadata.name, before.metadata.name);
  const oldTraffic = traffic(before), rollback = Object.keys(oldTraffic)[0];
  assert.equal(Object.keys(oldTraffic).length, 1);
  assert.equal(before.metadata.annotations['run.googleapis.com/minScale'], '1', 'Existing service minimum must be one');
  assert.equal(before.spec.template.metadata.annotations['autoscaling.knative.dev/minScale'] || '0', '0', 'Existing revision minimum must be zero');
  const max = before.spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'] ?? before.metadata.annotations['run.googleapis.com/maxScale'];
  assert.equal(String(max), '20', 'Captured maximum must be twenty');
  equal(tags(before), oldTag ? [{ tag: oldTag, revisionName: rollback }] : [], 'Unexpected captured tags');
  equal(servicePolicy(current), servicePolicy(before), 'Service configuration/policy changed');
  equal(current.metadata.labels, before.metadata.labels, 'Service labels changed');
  equal(current.spec.template.metadata.labels, before.spec.template.metadata.labels, 'Template labels changed');
  equal(template(current), template(before), 'Non-image template configuration changed');
  assert.ok(iamBefore.bindings?.some(row => row.role === 'roles/run.invoker' && row.members?.includes('allUsers')), 'Existing public invocation must already be granted');
  equal(iamCurrent, iamBefore, 'Invocation IAM policy changed');
  assert.equal(String(current.metadata.generation), String(current.status.observedGeneration), 'Unobserved service state');
  if (phase === 'untouched') {
    equal(traffic(current), oldTraffic, 'Traffic changed before image deploy'); equal(tags(current), tags(before), 'Tags changed before image deploy');
    equal(current.spec, before.spec, 'Desired service changed before image deploy');
    for (const k of ['latestCreatedRevisionName','latestReadyRevisionName']) assert.equal(current.status[k], before.status[k]);
    return { phase, rollback };
  }
  if (phase === 'failed-cleanup' || phase === 'failed-cleaned') {
    // A failed native command may still have created an unready revision/tag.
    // Only unchanged rollback traffic plus exact owned metadata permits removal.
    equal(traffic(current), oldTraffic, 'Failed deploy changed serving traffic');
    equal(traffic({ status: { traffic: current.spec.traffic } }), oldTraffic, 'Failed deploy changed desired traffic');
    for (const key of ['latestCreatedRevisionName','latestReadyRevisionName']) {
      assert.ok([before.status[key], candidate].includes(current.status[key]), 'Unowned failed-deploy revision');
    }
    const name = current.spec.template.metadata.name;
    if (name) assert.ok([before.spec.template.metadata.name, candidate].includes(name));
    assert.equal(current.spec.template.spec.containers.length, 1);
    const actualImage = current.spec.template.spec.containers[0].image;
    assert.ok([before.spec.template.spec.containers[0].image, image].includes(actualImage), 'Unowned failed-deploy image');
    const own = tags(current).filter(row => row.tag === tag);
    assert.ok(own.length <= 1 && own.every(row => row.revisionName === candidate), 'Unowned failed-deploy tag');
    if (phase === 'failed-cleaned') assert.equal(own.length, 0, 'Failed-deploy smoke tag remains');
    equal(tags(current).filter(row => row.tag !== tag), tags(before), 'Other failed-deploy tags changed');
    equal(tags({ status: { traffic: current.spec.traffic } }), tags(current), 'Failed-deploy desired tags differ');
    assert.ok(current.spec.traffic.every(row => !row.latestRevision && [rollback,candidate].includes(row.revisionName)), 'Unresolved failed-deploy desired traffic');
    return { phase, rollback, candidate, failedDeploymentOwned: true };
  }
  assert.ok(['candidate','promoted','recover','restored','cleaned','cleaned-restored'].includes(phase));
  assert.equal(current.status.latestCreatedRevisionName, candidate, 'Unrelated revision created');
  assert.equal(current.status.latestReadyRevisionName, candidate, 'Candidate is not ready');
  if (current.spec.template.metadata.name) assert.equal(current.spec.template.metadata.name, candidate);
  const expectedTags = phase === 'cleaned' ? [] : phase === 'cleaned-restored' ? tags(before) : [...tags(before), { tag, revisionName: candidate }].sort((a,b)=>a.tag.localeCompare(b.tag));
  equal(tags(current), expectedTags, 'Unowned tags');
  if (phase === 'candidate' || phase === 'restored' || phase === 'cleaned-restored') equal(traffic(current), oldTraffic);
  else if (phase === 'promoted' || phase === 'cleaned') equal(traffic(current), { [candidate]: 100 });
  else assert.ok(Object.keys(traffic(current)).every(x => [candidate,rollback].includes(x)), 'Unowned recovery traffic');
  const desired = current.spec.traffic || [];
  equal(tags({ status: { traffic: desired } }), expectedTags, 'Desired tags differ from observed ownership');
  const desiredTraffic = traffic({ status: { traffic: desired } });
  if (phase !== 'recover') equal(desiredTraffic, traffic(current), 'Desired traffic differs from verified serving state');
  else assert.ok(Object.keys(desiredTraffic).every(x => [candidate,rollback].includes(x)), 'Unowned desired recovery traffic');
  assert.ok(desired.every(x => !x.latestRevision && [candidate,rollback].includes(x.revisionName)), 'Unowned desired traffic');
  if (revision) {
    equal(revisionConfig(revision), revisionConfig(beforeRevision), 'Non-image revision configuration changed');
    assert.equal(revision.metadata.name, candidate);
    assert.ok(revision.status.conditions.some(x=>x.type==='Ready' && x.status==='True'));
    equal(current.spec.template.spec.containers.map(x=>x.image), revision.spec.containers.map(x=>x.image));
  }
  return { phase, rollback, candidate, configurationAndPolicyPreserved: true };
}
export function assertMcpIdentity({ identity, manifest, candidate, image, revision }) {
  assert.equal(identity.available, true); assert.equal(identity.schema, 'tsr-mcp-build/v1');
  assert.equal(identity.sourceSha, manifest.sourceSha); assert.equal(identity.contentSha256, manifest.contentSha256);
  assert.equal(identity.service, mcpBuild.service); assert.equal(identity.revision, candidate);
  assert.equal(revision.spec.containers.length, 1);
  assert.equal(revision.spec.containers[0].image, image);
  assert.ok(image.endsWith('@' + revision.status.imageDigest.match(/sha256:[a-f0-9]{64}$/)?.[0]), 'Revision digest differs');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dir, phase] = process.argv.slice(2);
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json')));
  const write = (name,value) => fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value,null,2));
  if (mode === 'manifest') {
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), process.env.GITHUB_SHA);
    const root = path.resolve(mcpBuild.sourcePath), manifest = { ...buildFeedManifest(root, process.env.GITHUB_SHA), schema: 'tsr-mcp-build/v1' };
    fs.writeFileSync(path.join(root,'build-manifest.json'),JSON.stringify(manifest,null,2)); write('manifest',manifest);
  } else if (mode === 'identity') {
    write('identity', effectiveReleaseIdentity({ getProperty: property => execFileSync('gcloud',['config','get',property],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim() }));
  } else if (mode === 'preconditions') verifyNativePreconditions({identity:read('identity'),bucket:read('bucket'),repository:read('repository'),account:read('build-account'),services:read('apis')});
  else if (mode === 'archive') write('archive',archiveMcp(path.resolve(mcpBuild.sourcePath),dir,process.env.GITHUB_SHA,read('release').tag));
  else if (mode === 'config') write('build-config',configMcp(read('archive'),read('source-object')));
  else if (mode === 'image') console.log(imageMcp({build:read('build'),submitted:read('build-submitted'),archive:read('archive'),object:read('source-object'),config:read('build-config'),tag:read('release').tag}));
  else if (mode === 'state') {
    console.log(JSON.stringify(assertMcpState({before:read('service-before'),current:read('service-current'),iamBefore:read('iam-before'),iamCurrent:read('iam-current'),...read('release'),phase,beforeRevision:read('revision-before'),revision:phase==='untouched'||phase.startsWith('failed-')?undefined:read('revision-candidate'),image:phase.startsWith('failed-')?imageMcp({build:read('build'),submitted:read('build-submitted'),archive:read('archive'),object:read('source-object'),config:read('build-config'),tag:read('release').tag}):undefined})));
  } else if (mode === 'runtime') {
    const image = imageMcp({build:read('build'),submitted:read('build-submitted'),archive:read('archive'),object:read('source-object'),config:read('build-config'),tag:read('release').tag});
    assertMcpIdentity({identity:read('runtime-identity'),manifest:read('manifest'),candidate:read('release').candidate,image,revision:read('revision-candidate')});
    console.log('Exact MCP native source/image/runtime identity verified');
  } else throw Error('Unknown MCP release operation');
}
