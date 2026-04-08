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

test('normalizeJsonSignals uses snake_case state dates for timestamps and metadata', () => {
  const latestActionDate = '2026-04-01T12:34:56Z';
  const [item] = normalizeJsonSignals(JSON.stringify({
    response: {
      data: [{
        title: 'State bill with snake_case fields',
        state_code: 'wa',
        state_name: 'Washington',
        summary: 'Tracks normalized state metadata',
        effective_date: '2026-05-01',
        latest_action_date: latestActionDate,
        latest_action_description: 'Signed by governor'
      }]
    }
  }), feed);

  assert.ok(item);
  assert.equal(item.jurisdictionCode, 'WA');
  assert.equal(item.jurisdictionName, 'Washington');
  assert.equal(item.effectiveDate, '2026-05-01');
  assert.equal(item.status, 'Signed by governor');
  assert.equal(item.publishedAt, Date.parse(latestActionDate));
});
