import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGenericJsonFeed
} from '../../gcp/mcp-proxy/json-signals.js';

const feed = {
  id: 'energy-eia',
  name: 'EIA Market Signals',
  category: 'energy',
  format: 'json'
};

test('MCP proxy parses nested response.data arrays', () => {
  const items = parseGenericJsonFeed({
    response: {
      data: [
        {
          name: 'WTI spot price',
          description: 'Cushing, OK',
          updated: '2026-03-19T20:30:00Z'
        }
      ]
    }
  }, feed);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'WTI spot price');
  assert.equal(items[0].summary, 'Cushing, OK');
  assert.equal(items[0].source, 'EIA Market Signals');
});

test('MCP proxy parses nested response.items arrays', () => {
  const items = parseGenericJsonFeed({
    response: {
      items: [
        {
          title: 'Brent spot price',
          summary: 'Europe benchmark',
          publishedAt: '2026-03-19T20:30:00Z'
        }
      ]
    }
  }, feed);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Brent spot price');
  assert.equal(items[0].summary, 'Europe benchmark');
});

test('MCP proxy parses nested response.results arrays', () => {
  const items = parseGenericJsonFeed({
    response: {
      results: [
        {
          headline: 'Henry Hub gas',
          body: 'Weekly benchmark',
          date: '2026-03-19T20:30:00Z'
        }
      ]
    }
  }, feed);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Henry Hub gas');
  assert.equal(items[0].summary, 'Weekly benchmark');
});
