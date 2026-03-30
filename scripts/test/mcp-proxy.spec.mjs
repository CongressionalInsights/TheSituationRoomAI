import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = path.join(process.cwd(), 'gcp', 'mcp-proxy', 'server.js');
const sourceText = fs.readFileSync(sourcePath, 'utf8');

function extractNamedBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing source marker: ${marker}`);
  }
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error(`Missing opening brace for: ${marker}`);
  }
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed block for: ${marker}`);
}

async function loadParseGenericJsonFeed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proxy-spec-'));
  const tempModulePath = path.join(tempDir, 'parse-generic-json-feed.mjs');
  const moduleSource = [
    'const normalizeJurisdictionCode = (value) => value == null ? null : String(value).toUpperCase();',
    extractNamedBlock(sourceText, 'function normalizeSummary('),
    extractNamedBlock(sourceText, 'function extractStateMetadata('),
    extractNamedBlock(sourceText, 'const COMMITTEE_REPORT_TYPE_MAP = {'),
    extractNamedBlock(sourceText, 'function normalizeCongressReportType('),
    extractNamedBlock(sourceText, 'function formatCongressReportTypeNumber('),
    extractNamedBlock(sourceText, 'function isCommitteeReportEntry('),
    extractNamedBlock(sourceText, 'function formatCongressChamber('),
    extractNamedBlock(sourceText, 'function buildCommitteeReportTitle('),
    extractNamedBlock(sourceText, 'function buildCommitteeReportSummary('),
    extractNamedBlock(sourceText, 'function parseGenericJsonFeed('),
    'export { parseGenericJsonFeed };'
  ].join('\n\n');
  fs.writeFileSync(tempModulePath, moduleSource);
  return import(pathToFileURL(tempModulePath).href);
}

const feed = {
  id: 'energy-eia',
  name: 'EIA Energy',
  category: 'energy',
  format: 'json'
};

test('MCP parser normalizes nested response arrays', async () => {
  const { parseGenericJsonFeed } = await loadParseGenericJsonFeed();
  const variants = [
    {
      label: 'response.data',
      payload: {
        response: {
          data: [
            {
              title: 'WTI crude settles higher',
              description: 'Weekly oil benchmark update',
              updatedAt: '2026-03-19T00:00:00Z'
            }
          ]
        }
      }
    },
    {
      label: 'response.items',
      payload: {
        response: {
          items: [
            {
              name: 'Brent spot price',
              summary: 'European benchmark moved higher',
              date: '2026-03-19T00:00:00Z'
            }
          ]
        }
      }
    },
    {
      label: 'response.results',
      payload: {
        response: {
          results: [
            {
              headline: 'Henry Hub weekly price',
              body: 'Natural gas benchmark snapshot',
              publishedAt: '2026-03-19T00:00:00Z'
            }
          ]
        }
      }
    }
  ];

  for (const variant of variants) {
    const items = parseGenericJsonFeed(variant.payload, feed);
    assert.equal(items.length, 1, `${variant.label} should produce one signal`);
    assert.equal(items[0].source, 'EIA Energy');
    assert.equal(items[0].category, 'energy');
    assert.match(items[0].title, /WTI crude|Brent spot price|Henry Hub weekly price/);
    assert.ok(Number.isFinite(items[0].publishedAt), `${variant.label} should carry a timestamp`);
  }
});
