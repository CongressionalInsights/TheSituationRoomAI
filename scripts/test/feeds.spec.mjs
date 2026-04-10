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
  assert.match(source, /shouldPromotePublishedSnapshot[\s\S]*federal-register[\s\S]*transport-opensky/);
});
