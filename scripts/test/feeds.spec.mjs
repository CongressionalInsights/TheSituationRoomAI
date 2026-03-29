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

test('MCP generic feed parser accepts nested response arrays', async () => {
  const { parseGenericJsonFeed } = await import('../../gcp/mcp-proxy/feed-parsers.js');
  const feed = { id: 'energy-eia', name: 'EIA Market Signals', category: 'energy' };
  const cases = [
    ['response.data', { response: { data: [{ title: 'Crude drawdown', url: 'https://example.com/data' }] } }],
    ['response.items', { response: { items: [{ title: 'Brent uptick', url: 'https://example.com/items' }] } }],
    ['response.results', { response: { results: [{ title: 'Gas storage', url: 'https://example.com/results' }] } }]
  ];

  cases.forEach(([label, payload]) => {
    const items = parseGenericJsonFeed(payload, feed);
    assert.equal(items.length, 1, `${label} should yield one parsed item`);
    assert.equal(items[0].title, payload.response[Object.keys(payload.response)[0]][0].title, `${label} should preserve the title`);
    assert.equal(items[0].url, payload.response[Object.keys(payload.response)[0]][0].url, `${label} should preserve the URL`);
    assert.equal(items[0].source, feed.name, `${label} should preserve the feed source`);
    assert.equal(items[0].category, feed.category, `${label} should preserve the feed category`);
  });
});
