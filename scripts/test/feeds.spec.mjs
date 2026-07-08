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
