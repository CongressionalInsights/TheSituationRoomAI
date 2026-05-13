import test from 'node:test';
import assert from 'node:assert/strict';

const { getStateBillSortTimestamp, normalizeCsvSignals, normalizeJsonSignals } = await import('../../gcp/mcp-proxy/signal-normalization.js');

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

test('normalizeJsonSignals uses effective_date as a state timestamp fallback', () => {
  const effectiveDate = '2026-05-01';
  const [item] = normalizeJsonSignals(JSON.stringify({
    response: {
      data: [{
        title: 'State bill with effective date only',
        state_code: 'or',
        effective_date: effectiveDate
      }]
    }
  }), feed);

  assert.ok(item);
  assert.equal(item.jurisdictionCode, 'OR');
  assert.equal(item.effectiveDate, effectiveDate);
  assert.equal(item.publishedAt, Date.parse(effectiveDate));
});

test('getStateBillSortTimestamp falls back to effective_date for state legislation ordering', () => {
  const olderAction = {
    id: 'older-action',
    latest_action_date: '2026-04-20'
  };
  const newerEffective = {
    id: 'newer-effective',
    effective_date: '2026-05-01'
  };

  assert.equal(
    [olderAction, newerEffective].sort((a, b) => getStateBillSortTimestamp(b) - getStateBillSortTimestamp(a))[0]?.id,
    'newer-effective'
  );
  assert.equal(getStateBillSortTimestamp(newerEffective), Date.parse('2026-05-01'));
});

test('normalizeJsonSignals uses Congress updateDateIncludingText when it is the only timestamp', () => {
  const updateDateIncludingText = '2026-04-02';
  const [item] = normalizeJsonSignals(JSON.stringify({
    bills: [{
      title: 'Congress bill with updateDateIncludingText only',
      updateDateIncludingText
    }]
  }), {
    id: 'congress-bills',
    name: 'Congress Bills',
    category: 'federal',
    format: 'json'
  });

  assert.ok(item);
  assert.equal(item.publishedAt, Date.parse(updateDateIncludingText));
});

test('normalizeJsonSignals extracts wrapped JSON payloads from Jina-style text responses', () => {
  const [item] = normalizeJsonSignals(`Title: URL Source: http://example.com\nMarkdown Content:\n{"articles":[{"title":"Wrapped GDELT article","seendate":"2026-04-09T10:00:00Z","url":"https://example.com/story"}]}`, {
    id: 'gdelt-doc',
    name: 'GDELT Global News',
    category: 'news',
    format: 'json'
  });

  assert.ok(item);
  assert.equal(item.title, 'Wrapped GDELT article');
  assert.equal(item.url, 'https://example.com/story');
});

test('normalizeCsvSignals maps Stooq quote fields into finance signals', () => {
  const [item] = normalizeCsvSignals(
    'Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-05-13,16:30:22,293.5,297.51,293.5,295.5,6106704\n',
    {
      id: 'stooq-quote',
      name: 'Stooq Quote',
      category: 'finance',
      format: 'csv'
    }
  );

  assert.ok(item);
  assert.equal(item.title, 'AAPL.US Price');
  assert.equal(item.symbol, 'AAPL.US');
  assert.equal(item.value, 295.5);
  assert.equal(item.volume, 6106704);
  assert.ok(item.publishedAt > 0);
});

test('normalizeCsvSignals drops Stooq missing ticker rows', () => {
  const items = normalizeCsvSignals(
    'Symbol,Date,Time,Open,High,Low,Close,Volume\nMONITORING,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n',
    {
      id: 'stooq-quote',
      name: 'Stooq Quote',
      category: 'finance',
      format: 'csv'
    }
  );

  assert.deepEqual(items, []);
});

test('normalizeJsonSignals maps GeoJSON feature properties into signal fields', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 'nc75360036',
      properties: {
        title: 'M 1.2 - 7 km NW of The Geysers, CA',
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/nc75360036',
        time: 1778683419930,
        updated: 1778683514046,
        status: 'automatic',
        type: 'earthquake'
      },
      geometry: {
        type: 'Point',
        coordinates: [-122.803833007812, 38.8283348083496, 1.8]
      }
    }]
  }), {
    id: 'usgs-quakes-hour',
    name: 'USGS Earthquakes (Past Hour)',
    category: 'disaster',
    format: 'json'
  });

  assert.ok(item);
  assert.equal(item.title, 'M 1.2 - 7 km NW of The Geysers, CA');
  assert.equal(item.url, 'https://earthquake.usgs.gov/earthquakes/eventpage/nc75360036');
  assert.equal(item.publishedAt, 1778683419930);
  assert.deepEqual(item.geo, { lat: 38.8283348083496, lon: -122.803833007812 });
});
