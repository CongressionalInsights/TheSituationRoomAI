import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpenSkyCandidates,
  executeOpenSkyCandidates
} from '../../gcp/opensky-proxy/server.js';

test('state requests add bounded bbox and skip authenticated retry when token is absent', () => {
  const candidates = buildOpenSkyCandidates('/api/opensky/states?extended=1', null);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.label), [
    'bounded-anonymous',
    'requested-anonymous'
  ]);

  const bounded = new URL(candidates[0].targetUrl);
  assert.equal(bounded.searchParams.get('extended'), '1');
  assert.equal(bounded.searchParams.get('lamin'), '46.5');
  assert.equal(bounded.searchParams.get('lamax'), '49.9');
  assert.equal(bounded.searchParams.get('lomin'), '-1.4');
  assert.equal(bounded.searchParams.get('lomax'), '6.8');

  const requested = new URL(candidates[1].targetUrl);
  assert.equal(requested.searchParams.get('lamin'), null);
});

test('authenticated retry is attempted after anonymous failures and can recover the request', async () => {
  const candidates = buildOpenSkyCandidates('/api/opensky/states?icao24=abc123', 'test-token');
  const seen = [];
  const logs = [];

  const result = await executeOpenSkyCandidates(candidates, {
    fetchUpstream: async (targetUrl, headers) => {
      seen.push({
        targetUrl,
        authorization: headers.Authorization || null
      });
      if (!headers.Authorization) {
        throw Object.assign(new Error('This operation was aborted'), { code: 'ABORT_ERR' });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    now: (() => {
      let current = 0;
      return () => ++current * 10;
    })(),
    logAttempt: (attempt) => logs.push(attempt)
  });

  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((attempt) => attempt.authorization), [null, null, 'Bearer test-token']);
  assert.equal(result.selectedAttempt?.label, 'requested-authenticated');
  assert.equal(result.response?.status, 200);
  assert.deepEqual(result.attempts.map((attempt) => attempt.label), [
    'bounded-anonymous',
    'requested-anonymous',
    'requested-authenticated'
  ]);
  assert.equal(result.attempts[0].timedOut, true);
  assert.equal(result.attempts[1].timedOut, true);
  assert.equal(result.attempts[2].authenticated, true);
  assert.equal(logs.length, 3);
});
