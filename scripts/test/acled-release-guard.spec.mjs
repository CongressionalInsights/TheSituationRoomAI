import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy-acled-proxy.yml', import.meta.url), 'utf8');
const jobCondition = workflow.match(/^  deploy:\n    if: (.+)$/m)?.[1];
const guardStep = workflow.split('      - name: Bind manual release to reviewed main commit\n')[1]?.split('      - uses: google-github-actions/auth@v3')[0];
const guard = guardStep?.split('        run: |\n')[1]?.replace(/^          /gm, '');
const sha = '1234567890abcdef1234567890abcdef12345678';
const otherSha = 'abcdef1234567890abcdef1234567890abcdef12';

test('ACLED activation fence precedes auth and preserves a single deploy job', () => {
  assert.equal(jobCondition, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  assert.match(workflow, /expected_sha:\n\s+description: Exact reviewed main commit to deploy\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /actions\/checkout@v6\n\s+with:\n\s+ref: \$\{\{ github.sha \}\}/);
  assert.deepEqual([...workflow.matchAll(/^  ([\w-]+):\n    (?:if|runs-on):/gm)].map((match) => match[1]), ['deploy']);
  assert.ok(guard);
  assert.match(guardStep, /EXPECTED_SHA: \$\{\{ inputs.expected_sha \}\}/);
  assert.match(guardStep, /ACTUAL_SHA: \$\{\{ github.sha \}\}/);
  assert.match(guardStep, /ACTUAL_REF: \$\{\{ github.ref \}\}/);
  assert.ok(workflow.indexOf('actions/checkout@v6') < workflow.indexOf('name: Bind manual release'));
  assert.ok(workflow.indexOf('name: Bind manual release') < workflow.indexOf('google-github-actions/auth@v3'));
  assert.ok(workflow.indexOf('google-github-actions/auth@v3') < workflow.indexOf('name: Deploy ACLED proxy service'));
});

for (const [event, ref, allowed] of [
  ['push', 'refs/heads/main', false],
  ['pull_request', 'refs/heads/main', false],
  ['schedule', 'refs/heads/main', false],
  ['workflow_dispatch', 'refs/heads/topic', false],
  ['workflow_dispatch', 'refs/tags/main', false],
  ['workflow_dispatch', 'refs/heads/main', true]
]) {
  test(`ACLED deploy job condition: ${event} on ${ref}`, () => {
    assert.ok(jobCondition);
    assert.equal(vm.runInNewContext(jobCondition, { github: { event_name: event, ref } }), allowed);
  });
}

function runGuard(overrides = {}) {
  assert.ok(guard);
  assert.doesNotMatch(guard, /\$\{\{|gcloud|curl|wget/);
  // Execute the workflow's actual shell guard; git and downstream effects are inert stubs.
  return spawnSync('/bin/bash', ['-c', `
git() {
  test "$#" = 2 && test "$1" = rev-parse && test "$2" = HEAD || return 90
  test "$GIT_FAILURE" = false || return 91
  printf '%s\\n' "$CHECKOUT_SHA"
}
${guard}
printf 'fixture-auth-and-deploy-reached\\n'
`], {
    encoding: 'utf8',
    env: {
      EXPECTED_SHA: sha, ACTUAL_SHA: sha, ACTUAL_REF: 'refs/heads/main',
      CHECKOUT_SHA: sha, GIT_FAILURE: 'false', ...overrides
    }
  });
}

test('ACLED extracted guard allows only matching reviewed main and checkout SHA', () => {
  const result = runGuard();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fixture-auth-and-deploy-reached\n');
});

for (const [name, overrides] of [
  ['missing expected SHA', { EXPECTED_SHA: '' }],
  ['abbreviated SHA', { EXPECTED_SHA: '1234567', ACTUAL_SHA: '1234567', CHECKOUT_SHA: '1234567' }],
  ['mismatched expected SHA', { EXPECTED_SHA: otherSha }],
  ['non-main ref', { ACTUAL_REF: 'refs/heads/topic' }],
  ['different checkout SHA', { CHECKOUT_SHA: otherSha }],
  ['unavailable checkout SHA', { GIT_FAILURE: 'true' }]
]) {
  test(`ACLED extracted guard blocks ${name} before auth/deploy`, () => {
    const result = runGuard(overrides);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
}
