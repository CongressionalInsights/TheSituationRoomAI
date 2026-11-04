// Read-only state guard. Never repairs traffic or changes IAM/configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { traffic, revisionConfig, servicePolicy } from './verify_feed_release.mjs';

export function verifyCandidateOnly(before, current, candidate, tag, phase = 'candidate') {
  assert.ok(['candidate', 'cleanup', 'cleaned'].includes(phase));
  assert.match(tag, /^gha-\d+-\d+$/);
  assert.ok(candidate.endsWith(`-${tag}`));
  const captured = traffic(before);
  assert.equal(Object.keys(captured).length, 1);
  assert.notEqual(Object.keys(captured)[0], candidate);
  const desired = service => traffic({ status: { traffic: service.spec.traffic } });
  assert.deepEqual(traffic(current), captured, 'Candidate-only serving traffic changed');
  assert.deepEqual(desired(current), desired(before), 'Candidate-only desired traffic changed');
  assert.ok(current.spec.traffic.every(row => !row.latestRevision), 'Unresolved desired traffic');
  assert.deepEqual(servicePolicy(current), servicePolicy(before), 'Service configuration changed');
  const config = service => revisionConfig({ spec: service.spec.template.spec, metadata: service.spec.template.metadata });
  assert.deepEqual(config(current), config(before), 'Template configuration changed');
  assert.equal(String(current.metadata.generation), String(current.status.observedGeneration), 'Unobserved update');
  const tags = service => service.status.traffic.filter(row => row.tag).map(({ tag, revisionName }) => ({ tag, revisionName })).sort((a, b) => a.tag.localeCompare(b.tag));
  const oldTags = tags(before);
  assert.equal(current.metadata.name, before.metadata.name, 'Service identity changed');
  if (current.spec.template.metadata?.name) assert.ok([before.spec.template.metadata?.name, candidate].includes(current.spec.template.metadata.name), 'Unrelated template revision');
  const desiredTags = service => tags({ status: { traffic: service.spec.traffic } });
  assert.deepEqual(desiredTags(current).filter(row => row.tag !== tag), desiredTags(before), 'Pre-existing desired tags changed');
  const desiredOwn = current.spec.traffic.filter(row => row.tag === tag);
  assert.ok(desiredOwn.length <= 1 && desiredOwn.every(row => row.revisionName === candidate && !row.percent), 'Unowned desired smoke tag');
  const allowed = new Set([...before.status.traffic, ...before.spec.traffic].map(row => row.revisionName).concat(candidate));
  assert.ok([...current.status.traffic, ...current.spec.traffic].every(row => allowed.has(row.revisionName)), 'Unrelated traffic revision');
  assert.ok(oldTags.every(row => row.tag !== tag), 'Smoke tag predates this run');
  const own = current.status.traffic.filter(row => row.tag === tag);
  assert.ok(own.length <= 1);
  assert.equal(own.length, desiredOwn.length, 'Desired/observed smoke tags disagree');
  if (phase === 'candidate') assert.equal(own.length, 1, 'Candidate smoke tag missing');
  if (phase === 'cleaned') assert.equal(own.length, 0, 'Smoke tag remains');
  if (own.length) {
    assert.equal(own[0].revisionName, candidate, 'Smoke tag belongs to another revision');
    assert.equal(own[0].percent || 0, 0);
  }
  assert.deepEqual(tags(current).filter(row => row.tag !== tag), oldTags, 'Pre-existing tags changed');
  for (const key of ['latestCreatedRevisionName', 'latestReadyRevisionName']) {
    assert.ok([before.status[key], candidate].includes(current.status[key]), 'Unrelated revision change');
  }
  return { candidateOnly: true, servingTrafficPreserved: true, phase, candidate, tag };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [before, current, candidate, tag, phase] = process.argv.slice(2);
  console.log(JSON.stringify(verifyCandidateOnly(JSON.parse(fs.readFileSync(before)), JSON.parse(fs.readFileSync(current)), candidate, tag, phase)));
}
