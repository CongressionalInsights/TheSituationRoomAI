import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const feedsPath = path.join(root, 'data', 'feeds.json');
const mcpProxyPath = path.join(root, 'gcp', 'mcp-proxy', 'server.js');

function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function loadNormalizeSignals() {
  const source = fs.readFileSync(mcpProxyPath, 'utf8');
  const start = source.indexOf('function normalizeSummary');
  const end = source.indexOf('function extractSafeResponseHeaders');
  assert.notEqual(start, -1, 'normalizeSummary definition not found');
  assert.notEqual(end, -1, 'extractSafeResponseHeaders definition not found');
  const context = {
    normalizeJurisdictionCode: () => null
  };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.__testExports = { normalizeSignals };`, context);
  return context.__testExports.normalizeSignals;
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

test('MCP proxy normalizes response wrapper arrays', () => {
  const normalizeSignals = loadNormalizeSignals();
  const feed = { id: 'energy-eia', name: 'EIA Market Signals', category: 'energy', format: 'json' };
  const wrappers = ['data', 'items', 'results'];

  wrappers.forEach((key) => {
    const items = normalizeSignals(JSON.stringify({
      response: {
        [key]: [
          {
            title: `Series ${key}`,
            summary: `Signal from ${key}`,
            publishedAt: '2026-03-19T12:00:00Z',
            url: `https://example.com/${key}`
          }
        ]
      }
    }), feed);

    assert.equal(items.length, 1, `response.${key} should produce one normalized signal`);
    assert.equal(items[0].title, `Series ${key}`);
    assert.equal(items[0].summary, `Signal from ${key}`);
    assert.equal(items[0].url, `https://example.com/${key}`);
    assert.equal(items[0].source, feed.name);
    assert.equal(items[0].category, feed.category);
    assert.equal(items[0].publishedAt, Date.parse('2026-03-19T12:00:00Z'));
  });
});
