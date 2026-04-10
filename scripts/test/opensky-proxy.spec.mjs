import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STATES_BBOX,
  buildOpenSkyRequestCandidates
} from '../../gcp/opensky-proxy/request-planning.js';

const TIMEOUTS = {
  bounded: 5000,
  requested: 5000,
  auth: 6000
};

test('state requests prepend a bounded anonymous attempt and add auth last', () => {
  const candidates = buildOpenSkyRequestCandidates({
    pathname: '/api/opensky/states',
    requestedUrl: new URL('https://opensky-network.org/api/states/all?extended=1'),
    token: 'test-token',
    timeouts: TIMEOUTS
  });

  assert.deepEqual(candidates.map((candidate) => candidate.label), [
    'bounded-anonymous',
    'requested-anonymous',
    'bounded-authenticated',
    'requested-authenticated'
  ]);
  assert.equal(candidates[0].timeoutMs, TIMEOUTS.bounded);
  assert.equal(candidates[1].timeoutMs, TIMEOUTS.requested);
  assert.equal(candidates[2].timeoutMs, TIMEOUTS.auth);
  assert.equal(candidates[3].timeoutMs, TIMEOUTS.auth);
  assert.equal(candidates[2].headers.Authorization, 'Bearer test-token');
  assert.equal(candidates[3].headers.Authorization, 'Bearer test-token');

  const boundedUrl = new URL(candidates[0].targetUrl);
  Object.entries(DEFAULT_STATES_BBOX).forEach(([key, value]) => {
    assert.equal(boundedUrl.searchParams.get(key), value, `missing default ${key}`);
  });
  const boundedAuthUrl = new URL(candidates[2].targetUrl);
  Object.entries(DEFAULT_STATES_BBOX).forEach(([key, value]) => {
    assert.equal(boundedAuthUrl.searchParams.get(key), value, `missing auth default ${key}`);
  });
  assert.equal(boundedUrl.searchParams.get('extended'), '1');
  assert.equal(candidates[1].targetUrl, 'https://opensky-network.org/api/states/all?extended=1');
});

test('state requests keep explicit bbox values and omit auth when no token is present', () => {
  const candidates = buildOpenSkyRequestCandidates({
    pathname: '/api/opensky/states',
    requestedUrl: new URL('https://opensky-network.org/api/states/all?extended=1&lamin=10&lamax=20&lomin=-80&lomax=-70'),
    token: null,
    timeouts: TIMEOUTS
  });

  assert.deepEqual(candidates.map((candidate) => candidate.label), [
    'bounded-anonymous',
    'requested-anonymous'
  ]);

  const boundedUrl = new URL(candidates[0].targetUrl);
  assert.equal(boundedUrl.searchParams.get('lamin'), '10');
  assert.equal(boundedUrl.searchParams.get('lamax'), '20');
  assert.equal(boundedUrl.searchParams.get('lomin'), '-80');
  assert.equal(boundedUrl.searchParams.get('lomax'), '-70');
});
