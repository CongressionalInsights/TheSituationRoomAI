import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGenericJsonFeed } from '../../gcp/mcp-proxy/generic-json-feed.js';

const feed = {
  id: 'energy-eia',
  name: 'EIA Market Signals',
  category: 'energy'
};

[
  ['response.data', { response: { data: [{ title: 'WTI crude', description: 'Up 2%' }] } }],
  ['response.items', { response: { items: [{ title: 'Brent crude', description: 'Flat' }] } }],
  ['response.results', { response: { results: [{ title: 'Henry Hub gas', description: 'Down 1%' }] } }]
].forEach(([label, payload]) => {
  test(`parseGenericJsonFeed normalizes ${label} arrays`, () => {
    const [item] = parseGenericJsonFeed(payload, feed);
    assert.equal(item.title, payload.response[label.split('.')[1]][0].title);
    assert.equal(item.summary, payload.response[label.split('.')[1]][0].description);
    assert.equal(item.source, feed.name);
    assert.equal(item.category, feed.category);
  });
});
