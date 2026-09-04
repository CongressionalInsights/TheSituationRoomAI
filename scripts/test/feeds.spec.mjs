import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const feedsPath = path.join(root, 'data', 'feeds.json');

function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

test('feeds.json parses and has feeds', () => {
  const raw = fs.readFileSync(feedsPath, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.feeds), 'feeds.json should have feeds array');
  assert.ok(data.feeds.length > 0, 'feeds array should not be empty');
});

test('feeds have required keys', () => {
  const raw = fs.readFileSync(feedsPath, 'utf8');
  const data = JSON.parse(raw);
  data.feeds.forEach((feed) => {
    assert.ok(feed.id, `feed missing id: ${feed.name || 'unknown'}`);
    assert.ok(feed.name, `feed missing name: ${feed.id || 'unknown'}`);
    assert.ok(feed.url || feed.localPath || feed.requiresConfig, `feed missing url/localPath: ${feed.id}`);
    assert.ok(feed.category, `feed missing category: ${feed.id}`);
    assert.ok(isKebabCase(feed.id), `feed id not kebab-case: ${feed.id}`);
    if (feed.requiresKey) {
      const serverIdOverrides = new Set(['openaq-api', 'nasa-firms']);
      const hasKeyGroup = Boolean(feed.keyGroup);
      const hasServerOverride = feed.keySource === 'server' && serverIdOverrides.has(feed.id);
      assert.ok(hasKeyGroup || hasServerOverride, `feed requiresKey but missing keyGroup: ${feed.id}`);
    }
  });
});

test('EIA feeds carry the extended timeout budget', () => {
  const raw = fs.readFileSync(feedsPath, 'utf8');
  const data = JSON.parse(raw);
  ['energy-eia', 'energy-eia-brent', 'energy-eia-ng'].forEach((feedId) => {
    const feed = data.feeds.find((entry) => entry.id === feedId);
    assert.ok(feed, `missing feed ${feedId}`);
    assert.equal(feed.timeoutMs, 45000, `${feedId} should use the EIA timeout override`);
  });
});

test('EIA public payload sanitizers remove echoed credentials without changing data', async () => {
  const feedSanitizer = await import('../../gcp/feed-proxy/public-payload-safety.js');
  const mcpSanitizer = await import('../../gcp/mcp-proxy/public-payload-safety.js');
  const feed = { id: 'energy-eia', keyGroup: 'eia' };
  const payload = {
    body: JSON.stringify({
      request: { params: { api_key: 'fixture-secret', frequency: 'daily' } },
      response: { data: [{ period: '2026-08-29', value: 64.2 }] }
    }),
    httpStatus: 200
  };

  for (const sanitizer of [feedSanitizer, mcpSanitizer]) {
    const result = sanitizer.sanitizeEiaPayload(feed, payload);
    const body = JSON.parse(result.body);
    assert.equal(body.request.params.api_key, undefined);
    assert.equal(body.request.params.frequency, 'daily');
    assert.deepEqual(body.response.data, [{ period: '2026-08-29', value: 64.2 }]);
  }
});

test('static EIA publication uses only the server-side Feed Proxy and fails closed', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build_static_cache.mjs'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
  assert.match(source, /if \(isEiaFeed\(feed\)\)[\s\S]*await feedProxyFallback\(\)/);
  assert.match(source, /force: !isEiaFeed\(feed\)/);
  assert.match(source, /isEiaFeed\(feed\)[\s\S]*\? 210000/);
  assert.match(source, /server_proxy_unavailable/);
  assert.doesNotMatch(source, /process\.env\.EIA/);
  assert.doesNotMatch(workflow, /secrets\.EIA/);
  assert.doesNotMatch(workflow, /Missing required secret: EIA/);
  const feedProxySource = fs.readFileSync(path.join(root, 'gcp', 'feed-proxy', 'server.js'), 'utf8');
  assert.match(feedProxySource, /const effectiveKey = isEiaFeed\(feed\) \? serverKey : \(key \|\| serverKey\)/);
  assert.doesNotMatch(feedProxySource, /message: text \|\| 'EIA energy map fetch failed\.'/);
});

test('feed proxy deploy preserves existing secret bindings by default', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-feed-proxy.yml'), 'utf8');
  assert.match(workflow, /sync_secret_versions:[\s\S]*default: false/);
  assert.match(workflow, /Ensure feed proxy secrets\s*\n\s*if: github\.event_name == 'workflow_dispatch' && inputs\.sync_secret_versions/);
  assert.match(workflow, /SECRET_ARGS=\(\)/);
  assert.match(workflow, /SECRET_ARGS=\(--update-secrets "\$SECRET_BINDINGS"\)/);
  assert.doesNotMatch(workflow, /--set-secrets/);
});

test('state legislation uses the widened OpenStates timeout budget', () => {
  const raw = fs.readFileSync(feedsPath, 'utf8');
  const data = JSON.parse(raw);
  const feed = data.feeds.find((entry) => entry.id === 'state-legislation');
  assert.ok(feed, 'missing state-legislation feed');
  assert.equal(feed.timeoutMs, 120000, 'state-legislation should allow slow OpenStates query responses');
});

test('scoped state legislation requests return a bounded explicit timeout payload', async () => {
  const {
    buildStateLegislationTimeoutPayload,
    fetchStateLegislationScoped,
    isStateLegislationScopedRequest
  } = await import('../../gcp/feed-proxy/state-legislation-timeout.js');
  const feed = { id: 'state-legislation' };
  const result = await fetchStateLegislationScoped('https://openstates.test/bills', {
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  });

  assert.equal(isStateLegislationScopedRequest(feed, { jurisdiction: 'ocd-jurisdiction/country:us/state:ny/government' }), true);
  assert.equal(isStateLegislationScopedRequest(feed, {}), false);
  assert.equal(result.response, null);
  assert.equal(result.timedOut, true);

  const payload = buildStateLegislationTimeoutPayload(feed, 5);
  assert.equal(payload.httpStatus, 504);
  assert.equal(payload.error, 'upstream_timeout');
  assert.match(payload.body, /upstream_timeout/);
});

test('FDA MedWatch feed keeps both proxy fallbacks', () => {
  const raw = fs.readFileSync(feedsPath, 'utf8');
  const data = JSON.parse(raw);
  const feed = data.feeds.find((entry) => entry.id === 'fda-medwatch');
  assert.ok(feed, 'missing fda-medwatch feed');
  assert.deepEqual(feed.proxy, ['allorigins', 'jina']);
});

test('transport OpenSky feed can use published snapshot fallback', () => {
  const source = fs.readFileSync(path.join(root, 'gcp', 'feed-proxy', 'server.js'), 'utf8');
  assert.match(source, /feed\?\.[\s\S]*id === 'transport-opensky'/);
  assert.match(source, /shouldPromotePublishedSnapshot[\s\S]*transport-opensky/);
});

test('known published snapshots are not classified as stale live-cache failures', () => {
  const source = fs.readFileSync(path.join(root, 'gcp', 'feed-proxy', 'server.js'), 'utf8');
  assert.match(source, /function markSnapshotFallback[\s\S]*shouldPromotePublishedSnapshot/);
  assert.match(source, /function markStaleFeedPayload[\s\S]*shouldPromotePublishedSnapshot/);
  assert.match(source, /shouldPromotePublishedSnapshot[\s\S]*fda-medwatch/);
  assert.match(source, /shouldPromotePublishedSnapshot[\s\S]*gdelt-doc/);
  assert.match(source, /shouldPromotePublishedSnapshot[\s\S]*federal-register[\s\S]*transport-opensky/);
  assert.match(source, /stale: false, fallback: null/);
});

test('static OpenSky build can seed anonymous published snapshots', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build_static_cache.mjs'), 'utf8');
  assert.match(source, /SEEDED_JSON_FALLBACK_IDS[\s\S]*transport-opensky/);
  assert.doesNotMatch(source, /OpenSky OAuth token unavailable/);
});

test('static BLS CPI build rejects API quota error snapshots', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build_static_cache.mjs'), 'utf8');
  assert.match(source, /function getBlsApiError/);
  assert.match(source, /parsed\.status === 'REQUEST_SUCCEEDED'/);
  assert.match(source, /feed\?\.id === 'bls-cpi' && getBlsApiError\(parsed\)/);
  assert.match(source, /payload\.error = 'bls_api_error'/);
  assert.match(source, /payload\.error && feed\.id === 'bls-cpi'[\s\S]*loadBestFallbackPayload/);
});

test('static OpenStates build rejects HTML error bodies from the Feed Proxy fallback', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build_static_cache.mjs'), 'utf8');
  assert.match(source, /feed\.id === 'state-legislation'[\s\S]*isUsableJsonSnapshot\(proxySnapshot, feed\)/);
  assert.match(source, /payload\.error && feed\.id === 'state-legislation'[\s\S]*isUsableJsonSnapshot\(fallback, feed\)/);
});

test('MCP proxy does not flag configured feed proxies as fallback paths', () => {
  const source = fs.readFileSync(path.join(root, 'gcp', 'mcp-proxy', 'server.js'), 'utf8');
  assert.match(source, /const configuredProxies = Array\.isArray\(feed\.proxy\)/);
  assert.match(source, /fallbackUsed: Boolean\(usedProxy[\s\S]*!configuredProxies\.includes\(usedProxy\)\)/);
});

test('committee Congress feeds use default congress params', () => {
  const raw = fs.readFileSync(feedsPath, 'utf8');
  const data = JSON.parse(raw);
  [
    ['congress-ew-bills', '/committee/house/hsed00/bills'],
    ['congress-help-bills', '/committee/senate/sshr00/bills']
  ].forEach(([feedId, urlFragment]) => {
    const feed = data.feeds.find((entry) => entry.id === feedId);
    assert.ok(feed, `missing feed ${feedId}`);
    assert.equal(feed.defaultParams?.congress, 119, `${feedId} should default to the current Congress`);
    assert.equal(feed.congressCommitteeBills, true, `${feedId} should use committee bill normalization`);
    assert.ok(feed.url.includes(urlFragment), `${feedId} should use the committee bills endpoint`);
  });
});

test('feed proxy and local server omit template and runtime-only params from upstream query strings', () => {
  [
    path.join(root, 'gcp', 'feed-proxy', 'server.js'),
    path.join(root, 'server.mjs'),
    path.join(root, 'scripts', 'build_static_cache.mjs')
  ].forEach((sourcePath) => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /function getUrlTemplateParamNames/);
    assert.match(source, /function getRuntimeOnlyParamNames/);
    assert.match(source, /function applyCongressCommitteeDateWindow/);
    assert.match(source, /getUrlTemplateParamNames\((feed\.url|templateUrl)\)/);
    assert.match(source, /excludedUrlParamNames/);
    assert.match(source, /applyUrlParams\([^,]+, (mergedParams|staticRequestParams), excludedUrlParamNames\)/);
    assert.match(source, /applyCongressCommitteeDateWindow/);
  });
});

test('state legislation aggregation sorts with latest passage date fallbacks', () => {
  [
    path.join(root, 'gcp', 'feed-proxy', 'server.js'),
    path.join(root, 'server.mjs')
  ].forEach((sourcePath) => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /function getStateBillSortTimestamp[\s\S]*latest_passage_date[\s\S]*latestPassageDate/);
  });
});

test('committee Congress feeds are filtered before shared feed responses are exposed', () => {
  [
    path.join(root, 'gcp', 'feed-proxy', 'server.js'),
    path.join(root, 'server.mjs'),
    path.join(root, 'scripts', 'build_static_cache.mjs')
  ].forEach((sourcePath) => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /function filterCongressCommitteeBillsBody/);
    assert.match(source, /feed\.congressCommitteeBills[\s\S]*filterCongressCommitteeBillsBody/);
    assert.match(source, /mergedParams\.congress|staticRequestParams\.congress/);
  });
});

test('source highlights use explicit feeds and disclose partial coverage', async (t) => {
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'situation-highlights-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const preload = path.join(temp, 'mock-fetch.mjs');
  fs.writeFileSync(preload, `
    import assert from 'node:assert/strict';
    globalThis.fetch = async (url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.params.name, 'search.smart');
      assert.equal(request.params.arguments.query, undefined);
      assert.deepEqual(request.params.arguments.sources, ['bbc-world', 'federal-register', 'eonet-events', 'arxiv-rss-ai']);
      assert.equal(request.params.arguments.totalLimit, 12);
      return new Response(JSON.stringify({ result: { structuredContent: {
        signals: [{ title: 'Fixture record', source: 'Fixture source', url: 'https://example.org/record', publishedAt: 1788548983402 }],
        sourcesChecked: request.params.arguments.sources.map((sourceId, index) => ({ sourceId, ok: index !== 3, fallbackUsed: index === 1 })),
        warnings: ['Fixture fallback warning']
      } } }), { headers: { 'content-type': 'application/json' } });
    };
  `);
  const script = path.join(root, 'scripts/build_denario.mjs');
  const result = spawnSync(process.execPath, ['--import', preload, script], {
    cwd: temp, encoding: 'utf8', env: { ...process.env, MCP_PROXY: 'https://fixture.test/mcp', DENARIO_MIN_HOURS: '0' }
  });
  assert.equal(result.status, 0, result.stderr);
  const outputPath = path.join(temp, 'public/data/denario.json');
  const output = fs.readFileSync(outputPath, 'utf8');
  const payload = JSON.parse(output);
  assert.equal(payload.kind, 'source-highlights');
  assert.match(payload.summary, /1 sources unavailable; 1 using fallback/);
  assert.equal(payload.items[0].url, 'https://example.org/record');
  assert.equal(payload.items[0].publishedAt, 1788548983402);
  fs.writeFileSync(preload, `globalThis.fetch = async () => new Response('{}', {status: 503});`);
  const failed = spawnSync(process.execPath, ['--import', preload, script], {
    cwd: temp, encoding: 'utf8', env: { ...process.env, MCP_PROXY: 'https://fixture.test/mcp', DENARIO_MIN_HOURS: '0' }
  });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), output, 'failed refresh must not overwrite the prior artifact');
});
