import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpenSkyServer } from '../../gcp/opensky-proxy/server.js';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('OpenSky proxy uses bounded anonymous states request before broader fallbacks', async (t) => {
  const calls = [];
  const server = createOpenSkyServer({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ states: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    logger: { log() {} }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/api/opensky/states?time=1700000000`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-opensky-upstream-attempt'), 'bounded-anonymous');
  assert.deepEqual(body, { states: [] });
  assert.equal(calls.length, 1);

  const firstCall = new URL(calls[0].url);
  assert.equal(firstCall.pathname, '/api/states/all');
  assert.equal(firstCall.searchParams.get('time'), '1700000000');
  assert.equal(firstCall.searchParams.get('lamin'), '46.5');
  assert.equal(firstCall.searchParams.get('lamax'), '49.9');
  assert.equal(firstCall.searchParams.get('lomin'), '-1.4');
  assert.equal(firstCall.searchParams.get('lomax'), '6.8');
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('OpenSky proxy falls back to requested anonymous fetch when token lookup fails', async (t) => {
  const calls = [];
  const logs = [];
  let upstreamAttempt = 0;
  const server = createOpenSkyServer({
    env: {
      OPENSKY_CLIENTID: 'client-id',
      OPENSKY_CLIENTSECRET: 'client-secret'
    },
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, options });
      if (requestUrl === TOKEN_URL) {
        const error = new Error('This operation was aborted');
        error.code = 'ABORT_ERR';
        throw error;
      }
      upstreamAttempt += 1;
      if (upstreamAttempt === 1) {
        return new Response('bounded failed', { status: 504 });
      }
      return new Response(JSON.stringify({ flights: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    logger: {
      log(message) {
        logs.push(String(message));
      }
    }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/api/opensky/tracks?icao24=abc123`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-opensky-upstream-attempt'), 'requested-anonymous');
  assert.deepEqual(body, { flights: [] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.match(logs.join('\n'), /opensky_token_fetch_failed/);
  assert.ok(calls.slice(1).every((call) => !call.options.headers.Authorization));
});

test('OpenSky proxy returns attempt diagnostics after all fallback paths fail', async (t) => {
  const server = createOpenSkyServer({
    env: {
      OPENSKY_CLIENTID: 'client-id',
      OPENSKY_CLIENTSECRET: 'client-secret'
    },
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl === TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'secret-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      const status = options.headers.Authorization ? 503 : 504;
      return new Response(`failed with ${status}`, { status });
    },
    logger: { log() {} }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/api/opensky/tracks?icao24=abc123`);
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error, 'proxy_error');
  assert.equal(body.attempts.length, 3);
  assert.deepEqual(body.attempts.map((attempt) => attempt.label), [
    'bounded-anonymous',
    'requested-anonymous',
    'requested-authenticated'
  ]);
  assert.equal(body.attempts[2].authenticated, true);
});
