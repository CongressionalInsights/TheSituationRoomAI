import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeJsonSignals } from '../../gcp/mcp-proxy/signal-normalization.js';
import { createItemId } from '../../gcp/mcp-proxy/server.js';
import { summarizeProxyPayload } from '../../analysis/monitor/lib/audit.mjs';

const feed = JSON.parse(readFileSync(new URL('../../data/feeds.json', import.meta.url))).feeds.find(f => f.id === 'warspotting-losses');
const fixture = { losses: [
  { id: 765, type: 'Vehicle', model: 'Model A', status: 'Destroyed', date: '2026-11-25',
    nearest_location: 'Fixture location', geo: '48.5, 32.5', unit: null, tags: null },
  { id: 766, type: 'Vehicle', status: 'Damaged', date: '2026-11-31', geo: '91, 200' },
  { id: 765, type: 'Vehicle', model: 'Duplicate identity', date: '2026-11-24' },
  { title: 'No provider identity', geo: ', 0' }
] };
const payload = { contentType: 'application/json', httpStatus: 200, body: JSON.stringify(fixture) };

test('Warspotting uses the losses array and retains date precision, provider identity and valid optional geography', () => {
  const rows = normalizeJsonSignals(payload.body, feed);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].observationKey, 'warspotting-losses:765');
  assert.equal(rows[0].publishedAt, Date.parse('2026-11-25T00:00:00Z'));
  assert.equal(rows[0].observationDate, '2026-11-25');
  assert.equal(rows[0].timeSemantics, 'event-date');
  assert.equal(rows[0].title, 'Destroyed — Model A');
  assert.equal(rows[0].source, feed.name);
  assert.equal(rows[0].location, 'Fixture location');
  assert.deepEqual(rows[0].geo, { lat: 48.5, lon: 32.5 });
  assert.equal(rows[1].publishedAt, null);
  assert.equal(rows[1].geo, null);
  assert.notEqual(createItemId(rows[0]), createItemId(rows[1]));
  assert.deepEqual(normalizeJsonSignals('{"losses":[]}', feed), []);
  assert.deepEqual(normalizeJsonSignals('{"results":[{"title":"Not a loss"}]}', feed), []);
});

test('monitor counts the actual raw rows and dates without broadening other JSON feeds', () => {
  const v = summarizeProxyPayload(feed, payload, { status: 200 });
  assert.equal(v.rawItemCount, 4);
  assert.equal(v.newestTimestamp, Date.parse('2026-11-25T00:00:00Z'));
  const other = { id: 'unrelated', name: 'Unrelated', format: 'json' };
  assert.equal(summarizeProxyPayload(other, payload, { status: 200 }).rawItemCount, 0);
  assert.deepEqual(normalizeJsonSignals(payload.body, other), []);
});

test('Warspotting retains the existing generic JSON limit', () => {
  const losses = Array.from({ length: 100 }, (_, i) => ({ id: i+1, model: 'Model', date: '2026-11-25' }));
  assert.equal(normalizeJsonSignals(JSON.stringify({ losses }), feed).length, 50);
});
