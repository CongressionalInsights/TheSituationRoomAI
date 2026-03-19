import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const helperPath = path.join(root, 'scripts', 'test', 'helpers', 'mock-fetch.mjs');
const serverPath = path.join(root, 'gcp', 'opensky-proxy', 'server.js');

function createTempLogPath(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)), 'fetch-log.json');
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`Timed out waiting for OpenSky proxy on port ${port}`);
}

async function startProxy(t, { port, env = {}, plan }) {
  const logPath = createTempLogPath('opensky-proxy');
  const child = spawn(process.execPath, ['--import', helperPath, serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_FETCH_PLAN: JSON.stringify(plan),
      MOCK_FETCH_LOG: logPath,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  t.after(() => {
    child.kill('SIGTERM');
  });

  await waitForHealth(port);
  return {
    logPath,
    async request(pathname) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      const body = await response.text();
      return { response, body };
    },
    readCalls() {
      return JSON.parse(fs.readFileSync(logPath, 'utf8'));
    },
    getOutput() {
      return { stdout, stderr };
    }
  };
}

test('OpenSky proxy serves states from the bounded anonymous request without credentials', async (t) => {
  const port = 38111;
  const proxy = await startProxy(t, {
    port,
    plan: [
      {
        match: '/states/all',
        status: 200,
        body: JSON.stringify({ time: 1710000000, states: [] })
      }
    ]
  });

  const { response, body } = await proxy.request('/api/opensky/states?extended=1');
  assert.equal(response.status, 200, body);
  assert.equal(response.headers.get('x-opensky-upstream-attempt'), 'bounded-anonymous');

  const calls = proxy.readCalls();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/states\/all\?/);
  assert.match(calls[0].url, /lamin=46\.5/);
  assert.match(calls[0].url, /lamax=49\.9/);
  assert.match(calls[0].url, /lomin=-1\.4/);
  assert.match(calls[0].url, /lomax=6\.8/);
  assert.equal(calls[0].headers.authorization, undefined);
});

test('OpenSky proxy falls through to the authenticated request after anonymous failures', async (t) => {
  const port = 38112;
  const proxy = await startProxy(t, {
    port,
    env: {
      OPENSKY_CLIENTID: 'client-id',
      OPENSKY_CLIENTSECRET: 'client-secret'
    },
    plan: [
      {
        match: '/protocol/openid-connect/token',
        status: 200,
        body: JSON.stringify({ access_token: 'token-123', expires_in: 900 })
      },
      {
        match: '/tracks/all',
        status: 503,
        body: JSON.stringify({ error: 'busy' })
      },
      {
        match: '/tracks/all',
        status: 500,
        body: JSON.stringify({ error: 'still-busy' })
      },
      {
        match: '/tracks/all',
        status: 200,
        body: JSON.stringify({ path: [] })
      }
    ]
  });

  const { response, body } = await proxy.request('/api/opensky/tracks?icao24=abc123&time=1710000000');
  assert.equal(response.status, 200, body);
  assert.equal(response.headers.get('x-opensky-upstream-attempt'), 'requested-authenticated');

  const calls = proxy.readCalls();
  assert.equal(calls.length, 4, JSON.stringify(proxy.getOutput()));
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /protocol\/openid-connect\/token/);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[2].headers.authorization, undefined);
  assert.equal(calls[3].headers.authorization, 'Bearer token-123');
});
