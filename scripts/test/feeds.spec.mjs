import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const feedsPath = path.join(root, 'data', 'feeds.json');
const mcpServerPath = path.join(root, 'gcp', 'mcp-proxy', 'server.js');

function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function loadMcpJsonParser() {
  const source = fs.readFileSync(mcpServerPath, 'utf8');
  const match = source.match(/function parseGenericJsonFeed\(data, feed\) \{[\s\S]*?\n\}\n\nfunction normalizeSignals/);
  assert.ok(match, 'parseGenericJsonFeed should exist in the MCP server');
  const parserSource = match[0].replace(/\n\nfunction normalizeSignals$/, '');
  return Function(
    'normalizeSummary',
    'isCommitteeReportEntry',
    'buildCommitteeReportTitle',
    'buildCommitteeReportSummary',
    'extractStateMetadata',
    `${parserSource}; return parseGenericJsonFeed;`
  )(
    (value = '') => String(value).trim(),
    () => false,
    (_entry, fallbackTitle) => fallbackTitle,
    (_entry, defaultSummary) => defaultSummary,
    () => ({})
  );
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

test('MCP JSON parser normalizes nested response arrays from recent feed payloads', () => {
  const parseGenericJsonFeed = loadMcpJsonParser();
  const feed = { id: 'energy-eia', name: 'EIA', category: 'energy' };

  const responseDataItems = parseGenericJsonFeed({
    response: {
      data: [
        {
          title: 'WTI Crude',
          summary: 'Daily close',
          publishedAt: '2026-03-19T00:00:00Z'
        }
      ]
    }
  }, feed);
  assert.equal(responseDataItems.length, 1);
  assert.equal(responseDataItems[0].title, 'WTI Crude');
  assert.equal(responseDataItems[0].summary, 'Daily close');
  assert.equal(responseDataItems[0].source, 'EIA');

  const responseResultsItems = parseGenericJsonFeed({
    response: {
      results: [
        {
          title: 'Henry Hub',
          description: 'Natural gas benchmark',
          updatedAt: '2026-03-19T12:30:00Z'
        }
      ]
    }
  }, feed);
  assert.equal(responseResultsItems.length, 1);
  assert.equal(responseResultsItems[0].title, 'Henry Hub');
  assert.equal(responseResultsItems[0].summary, 'Natural gas benchmark');
  assert.equal(responseResultsItems[0].category, 'energy');
});
