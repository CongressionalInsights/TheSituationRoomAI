import test from 'node:test';
import assert from 'node:assert/strict';

const { getStateBillSortTimestamp, normalizeCsvSignals, normalizeJsonSignals } = await import('../../gcp/mcp-proxy/signal-normalization.js');
const {
  buildFeedUrl,
  buildMoneyQueryProfile,
  buildRawStructuredContent,
  buildUsaspendingTransactionKey,
  attachMoneyMatch,
  findBestMoneyNameMatch,
  selectSmartFeeds,
  settleMoneyTasks,
  shouldFilterSmartFeedLocally,
  shouldUseLiveFallback,
  supportsHistoryRange
} = await import('../../gcp/mcp-proxy/server.js');

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

test('normalizeJsonSignals prefers published_at over later snake_case state fallbacks', () => {
  const publishedAt = '2026-04-03T08:00:00Z';
  const latestActionDate = '2026-04-01T12:34:56Z';
  const [item] = normalizeJsonSignals(JSON.stringify({
    response: {
      data: [{
        title: 'State bill with explicit published_at',
        state_code: 'or',
        published_at: publishedAt,
        latest_action_date: latestActionDate,
        effective_date: '2026-05-01'
      }]
    }
  }), feed);

  assert.ok(item);
  assert.equal(item.jurisdictionCode, 'OR');
  assert.equal(item.effectiveDate, '2026-05-01');
  assert.equal(item.publishedAt, Date.parse(publishedAt));
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

test('normalizeJsonSignals synthesizes Congress hearing list titles', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    hearings: [{
      chamber: 'Senate',
      congress: 119,
      jacketNumber: 62972,
      number: 315,
      updateDate: '2026-07-07T22:51:20Z',
      url: 'https://api.congress.gov/v3/hearing/119/senate/62972'
    }]
  }), {
    id: 'congress-hearings',
    name: 'Congress.gov Hearings',
    category: 'gov',
    format: 'json'
  });

  assert.ok(item);
  assert.equal(item.title, 'Senate hearing 119-315 (jacket 62972)');
  assert.equal(item.url, 'https://api.congress.gov/v3/hearing/119/senate/62972');
  assert.equal(item.publishedAt, Date.parse('2026-07-07T22:51:20Z'));
});

test('normalizeJsonSignals reads Congress committee meetings and synthesizes titles', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    committeeMeetings: [{
      chamber: 'House',
      congress: 119,
      eventId: '119449',
      updateDate: '2026-07-07T18:19:06Z',
      url: 'https://api.congress.gov/v3/committee-meeting/119/house/119449?format=json'
    }]
  }), {
    id: 'congress-committee-meetings',
    name: 'Congress.gov Committee Meetings',
    category: 'gov',
    format: 'json'
  });

  assert.ok(item);
  assert.equal(item.title, 'House committee meeting 119449');
  assert.equal(item.url, 'https://api.congress.gov/v3/committee-meeting/119/house/119449?format=json');
  assert.equal(item.publishedAt, Date.parse('2026-07-07T18:19:06Z'));
});

test('normalizeJsonSignals skips invalid earlier timestamps and falls back to later valid Congress dates', () => {
  const updateDateIncludingText = '2026-04-03';
  const [item] = normalizeJsonSignals(JSON.stringify({
    bills: [{
      title: 'Congress bill with invalid earlier timestamp',
      updateDate: 'not-a-date',
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

test('raw history maps Federal Register date ranges to upstream publication date params', () => {
  const federalRegister = {
    id: 'federal-register',
    url: 'https://www.federalregister.gov/api/v1/documents?format=json&per_page=20&order=newest'
  };
  const url = buildFeedUrl(federalRegister, {
    start: '2026-06-01',
    end: '2026-06-07',
    history: true
  });
  const parsed = new URL(url);

  assert.equal(supportsHistoryRange(federalRegister), true);
  assert.equal(parsed.searchParams.get('conditions[publication_date][gte]'), '2026-06-01');
  assert.equal(parsed.searchParams.get('conditions[publication_date][lte]'), '2026-06-07');
  assert.equal(parsed.searchParams.has('start'), false);
  assert.equal(parsed.searchParams.has('end'), false);
});

test('history support is explicit for unsupported sources and template sources', () => {
  assert.equal(supportsHistoryRange({
    id: 'congress-api',
    url: 'https://api.congress.gov/v3/bill?format=json&sort=updateDate+desc&limit=20'
  }), false);
  assert.equal(supportsHistoryRange({
    id: 'ucdp-candidate-events',
    url: 'https://ucdpapi.pcr.uu.se/api/gedevents/25.0.11?StartDate={{start}}&EndDate={{end}}&pagesize=500'
  }), true);
});

test('raw history does not fall back to current static snapshots', () => {
  assert.equal(shouldUseLiveFallback({ history: true }), false);
  assert.equal(shouldUseLiveFallback({ history: false }), true);
  assert.equal(shouldUseLiveFallback({}), true);
});

test('raw structured content parses JSON content regardless of requested text format', () => {
  const structured = buildRawStructuredContent({
    sourceId: 'congress-hearings',
    feed: {
      id: 'congress-hearings',
      url: 'https://api.congress.gov/v3/hearing?format=json&limit=20'
    },
    result: {
      contentType: 'application/json',
      fetchedUrl: 'https://api.congress.gov/v3/hearing?format=json&limit=20&api_key=REDACTED',
      body: '{"hearings":[{"jacketNumber":62972}]}',
      responseHeaders: null,
      fallbackUsed: false,
      proxyUsed: null
    },
    responseFormat: 'text'
  });

  assert.deepEqual(structured.data, { hearings: [{ jacketNumber: 62972 }] });
  assert.equal(structured.body, '{"hearings":[{"jacketNumber":62972}]}');
});

test('smart search honors explicit gov category before news fallback', () => {
  const selected = selectSmartFeeds({
    query: 'senate hearing',
    categories: ['gov'],
    maxSources: 8
  });

  assert.ok(selected.length > 0);
  assert.equal(selected.every((entry) => entry.category === 'gov'), true);
  assert.equal(selected.some((entry) => entry.id === 'google-news-search'), false);
});

test('smart search only filters non-query feeds for explicit constrained searches', () => {
  const congressFeed = { id: 'congress-hearings', category: 'gov', supportsQuery: false };

  assert.equal(shouldFilterSmartFeedLocally({
    feed: congressFeed,
    query: 'what happened in Congress today',
    categories: undefined,
    sources: undefined
  }), false);
  assert.equal(shouldFilterSmartFeedLocally({
    feed: congressFeed,
    query: 'postal products',
    categories: ['gov'],
    sources: undefined
  }), true);
  assert.equal(shouldFilterSmartFeedLocally({
    feed: { ...congressFeed, supportsQuery: true },
    query: 'postal products',
    categories: ['gov'],
    sources: undefined
  }), false);
});

test('money flow entity matching uses aliases, word tokens, and relevance scores', () => {
  const capella = buildMoneyQueryProfile('Capella University');
  const capellaMatch = findBestMoneyNameMatch(capella, 'CAPELLA EDUCATION COMPANY');
  assert.ok(capellaMatch);
  assert.equal(capellaMatch.name, 'CAPELLA EDUCATION COMPANY');

  const strategic = buildMoneyQueryProfile('Strategic Education');
  assert.equal(findBestMoneyNameMatch(strategic, 'STRATEGIC DEFENSE LLC'), null);
  assert.equal(findBestMoneyNameMatch(strategic, 'STRATEGIC EDUCATION RESEARCH PARTNERSHIP INSTITUTE'), null);
  assert.ok(findBestMoneyNameMatch(strategic, 'STRATEGIC EDUCATION INC'));
});

test('money flow entity matching deeply flattens contribution item name arrays', () => {
  const profile = buildMoneyQueryProfile('Microsoft');
  const match = findBestMoneyNameMatch(profile, [['Microsoft Corporation PAC']]);

  assert.ok(match);
  assert.equal(match.name, 'Microsoft Corporation PAC');
  assert.equal(match.score, 0.667);
  assert.equal(findBestMoneyNameMatch(profile, 'Microsoft Research Partnership Institute'), null);
});

test('money flow LDA normalized items retain private contribution match fields', () => {
  const profile = buildMoneyQueryProfile('Second Contributor');
  const item = attachMoneyMatch(profile, {
    source: 'LDA',
    entity: 'First Contributor',
    recipient: 'First Payee',
    registrant: 'Different Registrant',
    moneyMatchFields: [
      ['First Contributor', 'First Payee'],
      ['Second Contributor', 'Second Payee']
    ]
  });

  assert.ok(item);
  assert.equal(item.matchedName, 'Second Contributor');
  assert.equal(item.moneyMatchFields, undefined);
});

test('money flow keyword matches preserve non-entity program results', () => {
  const profile = buildMoneyQueryProfile('airport terminal');
  const item = attachMoneyMatch(profile, {
    source: 'USAspending',
    entity: 'City Transit Authority',
    recipient: 'City Transit Authority',
    keywordMatchFields: ['Airport terminal expansion and safety grant']
  });

  assert.ok(item);
  assert.equal(item.matchedName, 'Airport terminal expansion and safety grant');
  assert.equal(item.matchType, 'keyword');
  assert.equal(item.keywordMatchFields, undefined);
});

test('money flow USAspending dedupe keeps separate same-award transactions', () => {
  const first = {
    'Award ID': 'FAKE-AWARD-1',
    'Recipient Name': 'Recipient',
    'Action Date': '2026-01-02',
    'Transaction Amount': 100,
    'Transaction Description': 'Base award'
  };
  const second = {
    ...first,
    'Action Date': '2026-02-03',
    'Transaction Amount': 250,
    'Transaction Description': 'Modification'
  };

  assert.notEqual(buildUsaspendingTransactionKey(first), buildUsaspendingTransactionKey(second));
});

test('money flow variant tasks preserve fulfilled sibling results after a rejection', async () => {
  const results = await settleMoneyTasks([
    Promise.resolve({ items: [{ sourceId: 'kept' }] }),
    Promise.reject(new Error('timeout'))
  ]);

  assert.deepEqual(results[0], { items: [{ sourceId: 'kept' }] });
  assert.deepEqual(results[1], { items: [], error: 'timeout' });
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
