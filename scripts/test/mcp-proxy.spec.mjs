import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeJsonSignals } = await import('../../gcp/mcp-proxy/signal-normalization.js');

const feed = {
  id: 'state-legislation',
  name: 'State Legislation',
  category: 'state',
  format: 'json',
  jurisdictionLevel: 'state',
  capabilities: ['legislation']
};

[
  ['response.data', { response: { data: [{ title: 'Nested data bill', state: 'CA', summary: 'Tracks nested data arrays' }] } }],
  ['response.items', { response: { items: [{ title: 'Nested items bill', state: 'NY', summary: 'Tracks nested items arrays' }] } }],
  ['response.results', { response: { results: [{ title: 'Nested results bill', state: 'TX', summary: 'Tracks nested results arrays' }] } }]
].forEach(([shape, payload]) => {
  test(`normalizeJsonSignals reads ${shape} arrays`, () => {
    const [item] = normalizeJsonSignals(JSON.stringify(payload), feed);
    assert.ok(item, `expected one normalized item for ${shape}`);
    assert.match(item.title, /Nested/);
    assert.equal(item.category, 'state');
    assert.equal(item.source, 'State Legislation');
    assert.ok(item.publishedAt > 0);
    assert.ok(item.jurisdictionCode, `expected jurisdiction metadata for ${shape}`);
  });
});

test('normalizeJsonSignals preserves snake_case state metadata and effective_date timestamps', () => {
  const expectedPublishedAt = Date.parse('2026-04-01T12:34:56Z');
  const [item] = normalizeJsonSignals(JSON.stringify({
    response: {
      results: [{
        title: 'Snake case metadata bill',
        state_code: 'ca',
        state_name: 'California',
        effective_date: '2026-04-01T12:34:56Z',
        summary: 'Tracks snake_case metadata fields'
      }]
    }
  }), feed);

  assert.ok(item, 'expected one normalized item');
  assert.equal(item.jurisdictionCode, 'CA');
  assert.equal(item.jurisdictionName, 'California');
  assert.equal(item.effectiveDate, '2026-04-01T12:34:56Z');
  assert.equal(item.publishedAt, expectedPublishedAt);
});

test('normalizeJsonSignals falls back to latest_action_date for state signal timestamps', () => {
  const expectedPublishedAt = Date.parse('2026-04-02T08:00:00Z');
  const [item] = normalizeJsonSignals(JSON.stringify({
    response: {
      results: [{
        title: 'Latest action timestamp bill',
        state: 'WA',
        latest_action_date: '2026-04-02T08:00:00Z',
        latest_action_description: 'Signed by governor'
      }]
    }
  }), feed);

  assert.ok(item, 'expected one normalized item');
  assert.equal(item.jurisdictionCode, 'WA');
  assert.equal(item.status, 'Signed by governor');
  assert.equal(item.effectiveDate, '2026-04-02T08:00:00Z');
  assert.equal(item.publishedAt, expectedPublishedAt);
});
