import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJsonSignals } from '../../gcp/mcp-proxy/signal-normalization.js';
import { parseFirmsTimestamp } from '../../gcp/mcp-proxy/firms-csv.js';
const feed = { id: 'arcgis-hms-fire', name: 'NOAA HMS', category: 'disaster' };
const body = properties => JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-77, 38] }, properties }
] });
test('HMS YearDay/Time without admitted semantics remains unknown rather than retrieval time', () => {
  for (const properties of [
    { YearDay: 2026319, Time: '0746' },
    { YearDay: 2026366, Time: '2400' },
    { YearDay: 2026319, Time: '0746', time: 'invalid', updated: 'invalid' },
    { time: null, updated: '' }
  ]) {
    const [item] = normalizeJsonSignals(body(properties), feed);
    assert.equal(item.publishedAt, null);
    assert.deepEqual(item.geo, { lat: 38, lon: -77 });
  }
  assert.equal(parseFirmsTimestamp(2026319), 2026319, 'numeric parser treats input as epoch milliseconds, not documented HMS YearDay');
  assert.equal(parseFirmsTimestamp('2026319'), null);
});
test('HMS already recognized source timestamps remain intact and skip invalid earlier fields', () => {
  for (const properties of [
    { time: '2026-11-15T07:46:00Z' },
    { time: 'invalid', updated: '2026-11-15T07:46:00Z' }
  ]) assert.equal(normalizeJsonSignals(body(properties), feed)[0].publishedAt, Date.parse('2026-11-15T07:46:00Z'));
});
test('Unknown-time fix is confined to HMS and preserves its observation identity fields', () => {
  const [unknown] = normalizeJsonSignals(body({ FID: 3, YearDay: 2026319, Time: '0746' }), feed);
  assert.equal(unknown.source, feed.name);
  const [other] = normalizeJsonSignals(body({}), { ...feed, id: 'unrelated-arcgis-source' });
  assert.equal(typeof other.publishedAt, 'number');
});
