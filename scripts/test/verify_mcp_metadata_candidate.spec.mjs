import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { httpServer } from '../../gcp/mcp-proxy/server.js';
import { verifyMcpMetadataCandidate } from '../verify_mcp_metadata_candidate.mjs';

globalThis.fetch = async () => { throw new Error('Upstream fetch blocked in metadata fixtures'); };

async function metadataFixture(t, transform = value => value) {
  const previous = { base: process.env.STATE_CONNECTOR_BASE_URL, key: process.env.STATE_CONNECTOR_API_KEY };
  process.env.STATE_CONNECTOR_BASE_URL = 'https://connector.fixture.invalid';
  process.env.STATE_CONNECTOR_API_KEY = 'inert-fixture';
  const server = http.createServer(httpServer.listeners('request')[0]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of [['STATE_CONNECTOR_BASE_URL', previous.base], ['STATE_CONNECTOR_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const calls = [];
  const fetchImpl = async (target, options) => {
    const url = new URL(target);
    assert.ok(['/health', '/.well-known/mcp.json', '/mcp'].includes(url.pathname));
    assert.equal(options.redirect, 'error');
    const envelope = options.body ? JSON.parse(options.body) : null;
    if (envelope?.method === 'tools/call') assert.equal(envelope.params.name, 'catalog.sources');
    calls.push({ path: url.pathname, envelope });
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url.pathname,
        method: options.method || 'GET', agent: false, headers: { ...options.headers, Host: url.host, 'X-Forwarded-Proto': url.protocol.slice(0, -1) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString();
            const sse = res.headers['content-type']?.includes('text/event-stream');
            const data = sse ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(text);
            const result = transform(data, envelope, url);
            resolve(new Response(sse ? `event: message\ndata: ${JSON.stringify(result)}\n\n` : JSON.stringify(result), { status: res.statusCode, headers: res.headers }));
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(options.body);
    });
  };
  return { fetchImpl, calls };
}

test('metadata-only verifier exercises production raw entry and fingerprints candidate/canonical without providers', async (t) => {
  const fixture = await metadataFixture(t, (data, envelope, url) => {
    if (envelope?.method === 'initialize') data.result.serverInfo = { name: url.host, version: String(Date.now()) };
    return data;
  });
  const candidate = await verifyMcpMetadataCandidate('https://candidate.fixture.invalid/mcp', fixture);
  const canonical = await verifyMcpMetadataCandidate('https://canonical.fixture.invalid/mcp', fixture);
  assert.deepEqual(candidate, canonical);
  assert.equal(candidate.toolCount, 7);
  assert.equal(candidate.catalogSourceCount, 98);
  assert.equal(candidate.providerToolsCalled, 0);
  assert.deepEqual(fixture.calls.slice(0, 5).map(({ path, envelope }) => [path, envelope?.method || 'GET', envelope?.params?.name]), [
    ['/health', 'GET', undefined], ['/.well-known/mcp.json', 'GET', undefined], ['/mcp', 'initialize', undefined],
    ['/mcp', 'tools/list', undefined], ['/mcp', 'tools/call', 'catalog.sources']
  ]);
});

test('metadata-only verifier rejects schema/annotation, envelope, catalogue/config/NC drift and detects parity loss', async (t) => {
  const cases = [
    ['health', data => { if (data.ok) data.ok = false; }],
    ['discovery', data => { if (data.endpoint) data.tools.pop(); }],
    ['schema', data => { if (data.result?.tools) data.result.tools[0].inputSchema.properties.state.type = 'number'; }],
    ['annotations', data => { if (data.result?.tools) data.result.tools[0].annotations.readOnlyHint = false; }],
    ['RPC error', data => { if (data.result?.tools) data.error = { code: -32603 }; }],
    ['RPC id', data => { if (data.result?.tools) data.id = 500; }],
    ['tool error', data => { if (data.result?.structuredContent) data.result.isError = true; }],
    ['empty catalogue', data => { if (data.result?.structuredContent) data.result.structuredContent.sources = []; }],
    ['config', data => { if (data.result?.structuredContent) delete data.result.structuredContent.sources[0].configuration; }],
    ['NC coverage', data => { if (data.result?.structuredContent) data.result.structuredContent.sources.find(source => source.id === 'state-rulemaking').coverageStatus = 'UNSUPPORTED'; }],
    ['NC unconfigured', data => { if (data.result?.structuredContent) data.result.structuredContent.sources.find(source => source.id === 'state-executive-orders').configured = false; }]
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const fixture = await metadataFixture(t, data => { mutate(data); return data; });
      await assert.rejects(verifyMcpMetadataCandidate('https://candidate.fixture.invalid/mcp', fixture));
    });
  }
  await t.test('catalogue parity fingerprint', async (t) => {
    const fixture = await metadataFixture(t, (data, envelope, url) => {
      if (url.host.startsWith('canonical') && envelope?.method === 'tools/call') data.result.structuredContent.sources[0].name += ' changed';
      return data;
    });
    const a = await verifyMcpMetadataCandidate('https://candidate.fixture.invalid/mcp', fixture);
    const b = await verifyMcpMetadataCandidate('https://canonical.fixture.invalid/mcp', fixture);
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
});

const workflow = readFileSync(new URL('../../.github/workflows/deploy-mcp-proxy.yml', import.meta.url), 'utf8');
const step = name => workflow.split(`      - name: ${name}\n`)[1].split('      - name: ')[0];
const runScript = block => block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const substitute = (script, { metadata = false, cisa = false, sync = false } = {}) => script
  .replaceAll('${{ inputs.metadata_only }}', String(metadata)).replaceAll('${{ inputs.cisa_only }}', String(cisa))
  .replaceAll('${{ inputs.sync_secret_versions }}', String(sync)).replaceAll('${{ steps.deploy.outputs.candidate_revision }}', 'candidate')
  .replaceAll('${{ steps.deploy.outputs.candidate_tag }}', 'candidate-tag').replaceAll('${{ steps.current.outputs.service_url }}', 'https://canonical.fixture.invalid');

test('metadata-only workflow input guard rejects mixed modes and secret synchronization', () => {
  assert.match(workflow, /metadata_only:\n\s*description:.*\n\s*required: true\n\s*default: false\n\s*type: boolean/);
  const guard = runScript(step('Bind manual release to reviewed main commit'));
  for (const [metadata, cisa, sync, succeeds] of [[true, false, false, true], [true, true, false, false], [true, false, true, false], [false, true, false, true], [false, true, true, false], [false, false, true, true]]) {
    const sha = metadata ? '6dd6a85383a394f9d622a1aacfc3e319c1ef5250' : 'fixture';
    const result = spawnSync('bash', ['-c', `git(){ printf '%s' "$ACTUAL_SHA"; }; ${substitute(guard, { metadata, cisa, sync })}`], {
      encoding: 'utf8', env: { ...process.env, ACTUAL_REF: 'refs/heads/main', ACTUAL_SHA: sha, EXPECTED_SHA: sha }
    });
    assert.equal(result.status === 0, succeeds, JSON.stringify({ metadata, cisa, sync }));
  }
});

test('metadata-only workflow input guard pins the provider-independent bypass to its approved release', () => {
  const guard = runScript(step('Bind manual release to reviewed main commit'));
  // This is the merge commit that introduced the one-time, provider-independent maintenance exception.
  // Any later release must retain the normal provider and typed-series candidate gates.
  assert.match(guard, /if \[ "\$\{\{ inputs\.metadata_only \}\}" = true \]; then[\s\S]*?test "\$EXPECTED_SHA" = "6dd6a85383a394f9d622a1aacfc3e319c1ef5250"/);
});

test('metadata-only release pin is conditional and retains reviewed-main binding in every mode', () => {
  const guard = runScript(step('Bind manual release to reviewed main commit'));
  const approved = '6dd6a85383a394f9d622a1aacfc3e319c1ef5250';
  const future = 'f'.repeat(40);
  const other = 'e'.repeat(40);
  for (const [label, metadata, cisa, expected, actual, checkout, ref, succeeds] of [
    ['approved metadata release', true, false, approved, approved, approved, 'refs/heads/main', true],
    ['future metadata release', true, false, future, future, future, 'refs/heads/main', false],
    ['wrong metadata pin', true, false, other, other, other, 'refs/heads/main', false],
    ['metadata reviewed SHA mismatch', true, false, approved, future, future, 'refs/heads/main', false],
    ['metadata checkout mismatch', true, false, approved, approved, future, 'refs/heads/main', false],
    ['metadata non-main ref', true, false, approved, approved, approved, 'refs/heads/other', false],
    ['ordinary future release', false, false, future, future, future, 'refs/heads/main', true],
    ['CISA future release', false, true, future, future, future, 'refs/heads/main', true],
    ['ordinary reviewed SHA mismatch', false, false, future, other, other, 'refs/heads/main', false],
    ['CISA checkout mismatch', false, true, future, future, other, 'refs/heads/main', false],
    ['ordinary non-main ref', false, false, future, future, future, 'refs/heads/other', false],
    ['CISA non-main ref', false, true, future, future, future, 'refs/heads/other', false]
  ]) {
    const result = spawnSync('bash', ['-c', `git(){ printf '%s' "$FIXTURE_CHECKOUT_SHA"; }; ${substitute(guard, { metadata, cisa })}`], {
      encoding: 'utf8', env: { ...process.env, ACTUAL_REF: ref, ACTUAL_SHA: actual, EXPECTED_SHA: expected, FIXTURE_CHECKOUT_SHA: checkout }
    });
    assert.equal(result.status === 0, succeeds, `${label}: ${result.stderr}`);
  }
});

test('metadata-only workflow routes only metadata smokes and parity while retaining normal/CISA paths', () => {
  const smoke = runScript(step('Smoke test isolated MCP candidate'));
  const canonical = runScript(step('Verify canonical MCP release'));
  // Execute the actual shell branches with inert commands; no cloud, curl, Node or file writes.
  const stubs = `SERVICE_NAME=fixture; REGION=fixture; PROJECT_ID=fixture; gcloud(){ printf 'fixture'; }; curl(){ :; }; tee(){ printf 'tee:%s\\n' "$*"; command cat; };\n`;
  for (const [metadata, cisa] of [[true, false], [false, true], [false, false]]) {
    const script = substitute(smoke, { metadata, cisa });
    const result = spawnSync('bash', ['-c', `${stubs} jq(){ printf 'https://candidate.fixture.invalid'; }; node(){ printf 'node:%s\\n' "$*"; }; ${script}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (metadata) {
      assert.match(result.stdout, /node:scripts\/verify_mcp_metadata_candidate\.mjs/);
      assert.doesNotMatch(result.stdout, /verify_cisa_candidate|verify_mcp_candidate\.mjs|run_core_sentinel|verify_typed_series_report/);
      const parity = spawnSync('bash', ['-c', `${stubs} jq(){ if [ "$1" = -er ]; then printf candidate; else printf 'parity:%s\\n' "$*"; fi; }; node(){ printf 'node:%s\\n' "$*"; }; ${substitute(canonical, { metadata })}`], { encoding: 'utf8' });
      assert.equal(parity.status, 0, parity.stderr);
      assert.match(parity.stdout, /fingerprint == \$candidate\[0\]\.fingerprint/);
      assert.doesNotMatch(parity.stdout, /verify_cisa_candidate|verify_mcp_candidate\.mjs/);
    } else if (cisa) {
      assert.match(result.stdout, /node:scripts\/verify_cisa_candidate\.mjs/);
      assert.doesNotMatch(result.stdout, /run_core_sentinel|verify_mcp_metadata_candidate/);
    } else {
      assert.match(result.stdout, /node:scripts\/verify_mcp_candidate\.mjs/);
      assert.match(result.stdout, /node:analysis\/monitor\/run_core_sentinel\.mjs/);
      assert.match(result.stdout, /node:scripts\/verify_typed_series_report\.mjs/);
    }
  }
  assert.match(workflow, /if: always\(\) && !inputs.cisa_only && !inputs.metadata_only && hashFiles/);
  assert.match(step('Upload MCP deploy diagnostics'), /if: always\(\)/);
  assert.match(workflow, /node --test scripts\/test\/verify_mcp_metadata_candidate\.spec\.mjs/);
  const parityExpression = canonical.match(/'(\.mode == "metadata_only"[^']+)'/)[1];
  const candidate = { mode: 'metadata_only', fingerprint: 'fixture-a' };
  for (const [fingerprint, succeeds] of [['fixture-a', true], ['fixture-b', false]]) {
    const parity = spawnSync('jq', ['-e', '--argjson', 'candidate', JSON.stringify([candidate]), parityExpression], {
      input: JSON.stringify({ mode: 'metadata_only', fingerprint }), encoding: 'utf8'
    });
    assert.equal(parity.status === 0, succeeds, parity.stderr);
  }
});
