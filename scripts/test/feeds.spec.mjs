import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

const firmsHelperPaths = [
  '../../scripts/firms-csv.js', '../../gcp/feed-proxy/firms-csv.js', '../../gcp/mcp-proxy/firms-csv.js'
];
const firmsHeader = 'latitude,longitude,acq_date,acq_time,bright_ti4,frp,confidence';
const firmsValid = '0,-118.2,2026-09-22,0035,310.5,12.4,n';

test('NASA FIRMS uses the documented CSV route while preserving the public JSON contract', () => {
  const paths = ['data/feeds.json', 'public/data/feeds.json', 'gcp/feed-proxy/feeds.json', 'gcp/mcp-proxy/feeds.json'];
  for (const file of paths) {
    const feed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).feeds.find((row) => row.id === 'nasa-firms');
    assert.equal(feed.url, 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{{key}}/VIIRS_SNPP_NRT/world/1');
    assert.equal(feed.format, 'json');
    assert.equal(feed.requiresKey, true);
    assert.equal(feed.keySource, 'server');
    assert.equal(feed.ttlMinutes, 60);
  }
});

test('NASA FIRMS CSV adapters validate dates, times, numeric coordinates and the 200-item bound', async () => {
  const invalid = [
    '91,-118.2,2026-09-22,0035,310.5,12.4,n',
    '34,-181,2026-09-22,0035,310.5,12.4,n',
    '34,-118.2,2026-02-30,0035,310.5,12.4,n',
    '34,-118.2,2026-09-22,2400,310.5,12.4,n',
    '34,-118.2,2026-09-22,1260,310.5,12.4,n',
    ',-118.2,2026-09-22,0035,310.5,12.4,n',
    '0x10,-118.2,2026-09-22,0035,310.5,12.4,n'
  ];
  for (const modulePath of firmsHelperPaths) {
    const { parseNasaFirmsRows } = await import(modulePath);
    const rows = parseNasaFirmsRows([firmsHeader, ...invalid, ...Array(205).fill(firmsValid)].join('\r\n'), 'text/csv');
    assert.equal(rows.length, 200);
    assert.deepEqual(rows[0], {
      latitude: 0, longitude: -118.2, acq_date: '2026-09-22', acq_time: '0035',
      bright_ti4: '310.5', bright_ti5: '', frp: '12.4', confidence: 'n'
    });
    assert.deepEqual(parseNasaFirmsRows(firmsHeader + '\n' + invalid.join('\n'), 'text/plain'), []);
  }
});

test('NASA FIRMS CSV handles quoted records, BOM, reordered headers and header-only responses', async () => {
  for (const modulePath of firmsHelperPaths) {
    const { parseNasaFirmsRows } = await import(modulePath);
    const body = '\uFEFF"confidence",acq_time,longitude,latitude,acq_date,extra\r\n"n",35,-118.2,0,2026-09-22,"comma, quote "" and\r\nnewline"';
    const [row] = parseNasaFirmsRows(body, 'text/plain');
    assert.equal(row.latitude, 0);
    assert.equal(row.acq_time, '0035');
    assert.equal(row.confidence, 'n');
    assert.deepEqual(parseNasaFirmsRows(firmsHeader, 'text/csv'), []);
    assert.deepEqual(parseNasaFirmsRows(firmsHeader + '\r\n\r\n', 'text/csv'), []);
    assert.equal(parseNasaFirmsRows(firmsHeader + '\n90,180,2024-02-29,2359,1,1,h', 'text/csv').length, 1);
  }
});

test('NASA FIRMS CSV rejects provider error text and malformed records, retaining JSON compatibility', async () => {
  const bad = [
    '', '<html>error</html>', 'Invalid MAP_KEY', 'latitude,longitude\n1,2',
    firmsHeader + ',latitude\n' + firmsValid + ',1',
    firmsHeader + '\n' + firmsValid + ',extra',
    firmsHeader + '\n' + firmsValid.slice(0, -1) + '"n',
    firmsHeader + '\n' + firmsValid.slice(0, -1) + '"n"x'
  ];
  for (const modulePath of firmsHelperPaths) {
    const { parseNasaFirmsRows } = await import(modulePath);
    for (const body of bad) assert.throws(() => parseNasaFirmsRows(body, 'text/csv'), /invalid_firms_csv/);
    const json = { items: [{ latitude: 1, longitude: 2, acq_date: '2026-09-22', acq_time: '35' }] };
    assert.deepEqual(parseNasaFirmsRows(JSON.stringify(json), 'application/json'), json);
    assert.throws(() => parseNasaFirmsRows('{"error":', 'application/json'), SyntaxError);
  }
});

test('NASA FIRMS local and static normalization distinguish invalid and empty fixtures without provider calls', async () => {
  const { parseNasaFirmsRows } = await import('../../scripts/firms-csv.js');
  const lanes = [
    ['server.mjs', "  if (!payload.error && feed.id === 'nasa-firms'", '  if (!payload.error && feed.congressCommitteeBills'],
    ['scripts/build_static_cache.mjs', "  if (!payload.error && feed.id === 'nasa-firms'", "  if (!payload.error && feed.id === 'govinfo-api'"]
  ];
  for (const [file, start, end] of lanes) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const helperStart = source.indexOf('function buildNasaFirmsItems(');
    const helperEnd = source.indexOf('\n}', helperStart) + 2;
    const helper = source.slice(helperStart, helperEnd);
    const branchStart = source.indexOf(start);
    const branch = source.slice(branchStart, source.indexOf(end, branchStart));
    for (const [body, expectedError] of [
      [firmsHeader + '\n' + firmsValid, undefined],
      [firmsHeader, 'empty_payload'],
      ['Invalid MAP_KEY fixture-secret', 'invalid_response']
    ]) {
      const payload = { body, contentType: 'text/csv', httpStatus: 200 };
      const context = { feed: { id: 'nasa-firms' }, payload, body, contentType: 'text/csv', parseNasaFirmsRows };
      vm.runInNewContext(helper + '\n' + branch, context);
      assert.equal(payload.error, expectedError, file);
      if (!expectedError) {
        assert.equal(payload.contentType, 'application/json');
        const [item] = JSON.parse(payload.body).items;
        assert.equal(item.latitude, 0);
        assert.equal(item.publishedAt, Date.parse('2026-09-22T00:35:00Z'));
        assert.equal(item.source, 'NASA FIRMS');
      }
    }
  }
});

test('NASA FIRMS feed proxy normalization flags invalid and empty primary CSV before fallback', async () => {
  const { parseNasaFirmsRows } = await import('../../scripts/firms-csv.js');
  const source = fs.readFileSync(path.join(root, 'gcp/feed-proxy/server.js'), 'utf8');
  const helperStart = source.indexOf('function buildNasaFirmsItems(');
  const helper = source.slice(helperStart, source.indexOf('\n}', helperStart) + 2);
  const start = source.indexOf("    if (feed.id === 'nasa-firms' && responseOk");
  const branch = source.slice(start, source.indexOf('    if (feed.congressCommitteeBills', start));
  for (const [body, error] of [[firmsHeader + '\n' + firmsValid, undefined], [firmsHeader, 'empty_payload'], ['Invalid MAP_KEY', 'invalid_response']]) {
    const context = { feed: { id: 'nasa-firms' }, body, contentType: 'text/csv', responseOk: true, firmsError: null, parseNasaFirmsRows };
    vm.runInNewContext(helper + '\n' + branch, context);
    assert.equal(context.responseOk, !error);
    assert.equal(context.firmsError?.error, error);
    if (!error) assert.equal(context.contentType, 'application/json');
  }
});

test('NASA FIRMS MCP URL redaction covers CSV and legacy JSON path keys', () => {
  const source = fs.readFileSync(path.join(root, 'gcp/mcp-proxy/server.js'), 'utf8');
  const start = source.indexOf('function stripSecretsFromUrl(');
  const code = source.slice(start, source.indexOf('\nfunction resolveServerKey', start));
  const context = { URL };
  vm.runInNewContext(code + '\nthis.redact = stripSecretsFromUrl;', context);
  for (const format of ['json', 'csv']) {
    for (const prefix of ['https://firms.modaps.eosdis.nasa.gov', 'invalid-url']) {
      const redacted = context.redact(prefix + '/api/area/' + format + '/fixture-secret/VIIRS_SNPP_NRT/world/1');
      assert.equal(redacted.includes('fixture-secret'), false);
      assert.ok(redacted.includes('/' + format + '/REDACTED/'));
    }
  }
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
