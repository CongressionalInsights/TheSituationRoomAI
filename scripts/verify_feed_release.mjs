import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equal = (actual, expected, message) => assert.deepEqual(stable(actual), stable(expected), message);
const generatedAnnotation = /^(?:run.googleapis.com\/(?:build-(?:id|name|image-uri|source-location)|client-.*|operation-id)|serving.knative.dev\/(?:creator|lastModifier))$/;
export function revisionConfig(revision) {
  const spec = structuredClone(revision.spec);
  for (const container of spec.containers || []) delete container.image;
  return { spec, annotations: Object.fromEntries(Object.entries(revision.metadata?.annotations || {})
    .filter(([key]) => !generatedAnnotation.test(key))) };
}

export function traffic(service) {
  const totals = new Map();
  for (const entry of service.status?.traffic || []) {
    if (!entry.percent) continue;
    assert.ok(entry.revisionName && Number.isInteger(entry.percent) && entry.percent > 0, 'Unresolved traffic');
    totals.set(entry.revisionName, (totals.get(entry.revisionName) || 0) + entry.percent);
  }
  assert.equal([...totals.values()].reduce((sum, n) => sum + n, 0), 100, 'Traffic must total 100');
  return Object.fromEntries([...totals].sort());
}

const tags = service => (service.status?.traffic || []).filter(row => row.tag)
  .map(({ tag, revisionName }) => ({ tag, revisionName })).sort((a, b) => a.tag.localeCompare(b.tag));
const servicePolicy = service => ({ annotations: Object.fromEntries(Object.entries(service.metadata?.annotations || {})
  .filter(([key]) => !generatedAnnotation.test(key) && !['run.googleapis.com/urls', 'run.googleapis.com/ingress-status'].includes(key))),
  spec: Object.fromEntries(Object.entries(service.spec || {}).filter(([key]) => !['template', 'traffic'].includes(key))) });

export function assertReleaseState(before, current, candidate, tag, phase, revision = null) {
  const oldTraffic = traffic(before);
  assert.equal(Object.keys(oldTraffic).length, 1, 'Capture must have a unique serving revision');
  assert.equal(tags(before).length, 0, 'Pre-existing tags require separate ownership reconciliation');
  equal(servicePolicy(current), servicePolicy(before), 'Service policy/minimum changed');
  equal(revisionConfig({ spec: current.spec?.template?.spec, metadata: current.spec?.template?.metadata }),
    revisionConfig({ spec: before.spec?.template?.spec, metadata: before.spec?.template?.metadata }), 'Service template configuration changed');
  const templateName = current.spec?.template?.metadata?.name;
  if (templateName) assert.equal(templateName, candidate, 'Service template belongs to another revision');
  if (revision) equal(current.spec.template.spec.containers.map(container => container.image),
    revision.spec.containers.map(container => container.image), 'Service template image differs from exact candidate');
  const expectedTags = phase === 'cleaned' ? [] : [{ tag, revisionName: candidate }];
  equal(tags(current), expectedTags, 'Unrelated or missing traffic tag');
  assert.equal(current.status?.latestCreatedRevisionName, candidate, 'Another revision was created');
  assert.equal(current.status?.latestReadyRevisionName, candidate, 'Candidate is not latest ready');
  if (phase === 'candidate') equal(traffic(current), oldTraffic, 'Candidate changed canonical traffic');
  else if (phase === 'promoted' || phase === 'cleaned') equal(traffic(current), { [candidate]: 100 }, 'Exact candidate is not serving 100 percent');
  else if (phase === 'restored') equal(traffic(current), oldTraffic, 'Captured traffic was not restored');
  else if (phase === 'recover') {
    const allowed = new Set([...Object.keys(oldTraffic), candidate]);
    assert.ok(Object.keys(traffic(current)).every(revision => allowed.has(revision)), 'Unrelated actor changed traffic; refusing rollback');
    for (const row of current.spec?.traffic || []) {
      assert.ok(!row.latestRevision && allowed.has(row.revisionName), 'Unowned desired traffic; refusing rollback');
    }
  } else throw Error('Unknown release phase');
  if (phase !== 'recover') assert.equal(String(current.status?.observedGeneration), String(current.metadata?.generation), 'Service update is unobserved');
}

function annotationValues(value) {
  if (!value) return [];
  assert.equal(typeof value, 'string', 'Build annotation is not a string');
  if (!value.startsWith('{')) return [value];
  const map = JSON.parse(value);
  assert.ok(map && !Array.isArray(map) && Object.values(map).every(item => typeof item === 'string'), 'Invalid build annotation map');
  return Object.values(map);
}

export function buildProvenance(service, revision) {
  const values = key => {
    const scalar = annotationValues(service?.metadata?.annotations?.[key]);
    const mapped = annotationValues(revision?.metadata?.annotations?.[key]);
    if (scalar.length && mapped.length) equal(mapped, scalar, 'Service and revision build provenance disagree');
    const result = scalar.length ? scalar : mapped;
    assert.equal(result.length, 1, 'Missing or ambiguous build provenance');
    return result[0];
  };
  const id = values('run.googleapis.com/build-id');
  assert.match(id, /^[a-zA-Z0-9-]{1,128}$/, 'Invalid build ID');
  return { id, sourceLocation: values('run.googleapis.com/build-source-location') };
}

export function assertCandidate({ beforeRevision, revision, build, manifest, identity, candidate, service, candidateService }) {
  assert.equal(revision.metadata?.name, candidate, 'Wrong revision');
  assert.ok(revision.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'), 'Revision not ready');
  equal(revisionConfig(revision), revisionConfig(beforeRevision), 'Revision secret/public/runtime configuration changed');
  const digest = revision.status?.imageDigest?.match(/@?(sha256:[a-f0-9]{64})$/)?.[1];
  assert.ok(digest, 'Revision lacks immutable image digest');
  assert.ok(revision.spec.containers.length === 1, 'Unexpected containers');
  assert.ok(revision.spec.containers[0].image.endsWith(`@${digest}`), 'Revision image is not the immutable built image');
  assert.equal(build.status, 'SUCCESS', 'Build did not succeed');
  const provenance = buildProvenance(candidateService, revision);
  assert.equal(provenance.id, build.id, 'Build ID does not own the revision');
  assert.ok(build.results?.images?.some(image => image.digest === digest), 'Built image digest differs from revision');
  const source = build.sourceProvenance?.resolvedStorageSource || build.source?.storageSource;
  assert.ok(source?.generation, 'Build has no resolved source generation');
  assert.equal(provenance.sourceLocation, `gs://${source.bucket}/${source.object}#${source.generation}`, 'Build source archive differs');
  assert.equal(identity.available, true, 'Runtime source bytes unverified');
  assert.equal(identity.sourceSha, manifest.sourceSha, 'Runtime source SHA mismatch');
  assert.equal(identity.contentSha256, manifest.contentSha256, 'Runtime source bytes mismatch');
  assert.equal(identity.revision, candidate, 'Healthy response came from another revision');
  assert.equal(identity.service, service, 'Healthy response came from another service');
}

export function assertRevisionUnchanged(expected, actual) {
  equal(actual.spec, expected.spec, 'Canonical revision spec/image differs from candidate');
  equal(revisionConfig(actual), revisionConfig(expected), 'Canonical revision configuration differs');
  assert.equal(actual.metadata.name, expected.metadata.name, 'Canonical revision name differs');
  assert.equal(actual.status.imageDigest, expected.status.imageDigest, 'Canonical revision image differs');
  assert.ok(actual.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'), 'Canonical revision not ready');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dir] = process.argv.slice(2);
  const read = name => JSON.parse(fs.readFileSync(`${dir}/${name}.json`));
  const release = read('release');
  if (mode === 'build-id') console.log(buildProvenance(read('service-candidate'), read('revision-candidate')).id);
  else if (mode === 'identity') assertCandidate({ beforeRevision: read('revision-before'), revision: read('revision-candidate'),
    candidateService: read('service-current'), build: read('build'), manifest: read('manifest'), identity: read('identity'), ...release });
  else if (mode === 'revision') assertRevisionUnchanged(read('revision-candidate'), read('revision-canonical'));
  else assertReleaseState(read('service-before'), read('service-current'), release.candidate, release.tag, mode,
    fs.existsSync(`${dir}/revision-candidate.json`) ? read('revision-candidate') : null);
  if (mode !== 'build-id') console.log(`Feed release ${mode} verified`);
}
