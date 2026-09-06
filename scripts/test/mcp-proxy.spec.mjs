import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const {
  getStateBillSortTimestamp,
  normalizeCsvSignals,
  normalizeJsonSignals,
  normalizeSwpcTimestamp,
  parseJsonFeedPayload
} = await import('../../gcp/mcp-proxy/signal-normalization.js');
const {
  buildFeedUrl,
  buildMoneyQueryProfile,
  buildRawStructuredContent,
  buildMcpServer,
  createItemId,
  dedupeSignals,
  fetchRaw,
  matchesSignalQuery,
  buildUsaspendingTransactionKey,
  attachMoneyMatch,
  findBestMoneyNameMatch,
  getOpenStatesCachedRaw,
  getFeedConfiguration,
  getOpenStatesSuccessCacheTtl,
  resetOpenStatesRawCacheForTest,
  fetchFeedProxyFallback,
  resolveMoneyAliasExpansion,
  selectSmartFeeds,
  setOpenStatesCachedRaw,
  settleMoneyTasks,
  summarizeMoneyEntities,
  shouldFilterSmartFeedLocally,
  shouldUseLiveFallback,
  supportsHistoryRange
} = await import('../../gcp/mcp-proxy/server.js');
const { sanitizeEiaPayload } = await import('../../gcp/mcp-proxy/public-payload-safety.js');

test('MCP EIA sanitization covers success, error, and legacy response bodies', () => {
  const feed = { id: 'energy-eia-brent', keyGroup: 'eia' };
  for (const body of [
    JSON.stringify({ request: { params: { api_key: 'fixture-secret' } }, response: { data: [1] } }),
    JSON.stringify({ error: { apiKey: 'fixture-secret', message: 'quota' } }),
    'upstream failed: https://api.eia.gov/series/?api_key=fixture-secret&series_id=x'
  ]) {
    const result = sanitizeEiaPayload(feed, {
      body,
      message: body,
      fetchedUrl: 'https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=fixture-secret&frequency=daily'
    });
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  }

  const proxied = sanitizeEiaPayload(feed, {
    fetchedUrl: 'https://api.allorigins.win/raw?url=https%3A%2F%2Fapi.eia.gov%2Fv2%2Fpetroleum%2Fpri%2Fspt%2Fdata%2F%3Fapi_key%3Dfixture-secret%26frequency%3Ddaily'
  });
  assert.doesNotMatch(JSON.stringify(proxied), /fixture-secret/);
  assert.match(proxied.fetchedUrl, /api_key%3DREDACTED%26frequency%3Ddaily/i);
});

const openStatesCacheEntryCapacity = Math.max(1, Math.ceil(Number(process.env.OPENSTATES_CACHE_MAX_ENTRIES || 256)));

test('Google News MCP fallback preserves the requested query through the Feed Proxy', async () => {
  const calls = [];
  const result = await fetchFeedProxyFallback({ id: 'google-news-search', format: 'rss' }, {
    query: 'breaking news'
  }, {
    base: 'https://feed-proxy.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        body: '<?xml version="1.0"?><rss><channel><item><title>Current</title></item></channel></rss>',
        contentType: 'application/xml; charset=utf-8',
        httpStatus: 200
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://feed-proxy.test/api/feed');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    id: 'google-news-search',
    force: true,
    query: 'breaking news'
  });
  assert.equal(result.proxyUsed, 'feed-proxy');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.body, /<rss>/);
});

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

const swpcFeed = {
  id: 'swpc-json',
  name: 'NOAA SWPC Space Weather (JSON)',
  category: 'space',
  format: 'json',
  url: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json'
};
const swpcNonFinitePayload = `[
  {
    "time_tag": "2026-08-11T19:40:00",
    "source": "SOLAR1",
    "proton_speed": NaN,
    "proton_density": Infinity,
    "proton_temperature": 178434,
    "bx_gsm": -Infinity,
    "by_gsm": +Infinity,
    "status": "NaN and Infinity remain provider text"
  },
  {
    "time_tag": "2026-08-11T19:40:00",
    "source": "ACE",
    "proton_speed": 435,
    "proton_density": 5.1
  }
]`;

test('SWPC JSON parser converts bare non-finite values to null without changing strings', () => {
  const parsed = parseJsonFeedPayload(swpcNonFinitePayload, swpcFeed);
  assert.equal(parsed[0].proton_speed, null);
  assert.equal(parsed[0].proton_density, null);
  assert.equal(parsed[0].bx_gsm, null);
  assert.equal(parsed[0].by_gsm, null);
  assert.equal(parsed[0].status, 'NaN and Infinity remain provider text');

  assert.throws(
    () => parseJsonFeedPayload(swpcNonFinitePayload, { ...swpcFeed, id: 'other-json' }),
    SyntaxError
  );
});

test('SWPC non-finite root arrays remain available through raw and signal normalization', () => {
  const items = normalizeJsonSignals(swpcNonFinitePayload, swpcFeed);
  assert.equal(items.length, 2);
  assert.equal(items[0].publishedAt, Date.parse('2026-08-11T19:40:00Z'));
  assert.equal(items[0].title, 'Solar wind - SOLAR1');
  assert.match(items[0].summary, /Proton temperature 178434 K/);
  assert.equal(items[0].protonSpeed, null);
  assert.equal(items[1].title, 'Solar wind - ACE');
  assert.match(items[1].summary, /Proton speed 435 km\/s/);
  assert.equal(items[1].spacecraft, 'ACE');
  assert.notEqual(items[0].title, items[1].title);

  const structured = buildRawStructuredContent({
    sourceId: swpcFeed.id,
    feed: swpcFeed,
    result: {
      contentType: 'application/json',
      fetchedUrl: swpcFeed.url,
      body: swpcNonFinitePayload,
      responseHeaders: null,
      fallbackUsed: false,
      proxyUsed: null
    },
    responseFormat: 'text'
  });
  assert.equal(structured.data.length, 2);
  assert.equal(structured.data[0].proton_speed, null);
  assert.equal(structured.body, swpcNonFinitePayload);
});

test('SWPC timestamps without an explicit zone are normalized as UTC', () => {
  assert.equal(normalizeSwpcTimestamp('2026-08-11T19:40:00'), '2026-08-11T19:40:00Z');
  assert.equal(normalizeSwpcTimestamp('2026-08-11T19:40:00-04:00'), '2026-08-11T19:40:00-04:00');
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

test('normalizeJsonSignals maps OpenStates URLs, identifiers, and passage dates', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    results: [{
      identifier: 'SB 304',
      title: 'Creates the education savings account program',
      state_code: 'la',
      openstates_url: 'https://openstates.org/la/bills/2026/SB304/',
      updated_at: '2026-06-01T10:00:00Z',
      latest_passage_date: '2026-06-03',
      latest_action_description: 'Sent to the Governor'
    }]
  }), feed);

  assert.ok(item);
  assert.equal(item.title, 'LA SB 304 - Creates the education savings account program');
  assert.equal(item.url, 'https://openstates.org/la/bills/2026/SB304/');
  assert.equal(item.latestPassageDate, '2026-06-03');
  assert.equal(item.effectiveDate, '2026-06-03');
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

test('normalizeJsonSignals retains additive Congress introducedDate fields and sort order', () => {
  const fixture = fs.readFileSync(path.join(
    process.cwd(),
    'scripts',
    'test',
    'fixtures',
    'monitor',
    'congress-bills-introduced-date.json'
  ), 'utf8');
  const items = normalizeJsonSignals(fixture, {
    id: 'congress-api',
    name: 'Congress.gov Bills',
    category: 'gov',
    format: 'json'
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.title), [
    'HR 901 - Later introduced bill',
    'S 402 - Earlier introduced bill'
  ]);
  assert.deepEqual(items.map((item) => item.introducedDate), ['2026-07-21', '2026-07-18']);
  assert.deepEqual(items.map((item) => item.publishedAt), [
    Date.parse('2026-07-21'),
    Date.parse('2026-07-18')
  ]);
  assert.ok(items[0].publishedAt > items[1].publishedAt);
  assert.equal(items[0].url, 'https://www.congress.gov/bill/119th-congress/house-bill/901');
});

test('normalizeJsonSignals maps committee-scoped Congress bills to titled web links', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    bills: [{
      congress: 119,
      type: 'HR',
      number: '28',
      title: 'Protection of Women and Girls in Sports Act of 2025',
      latestAction: {
        actionDate: '2025-01-15',
        text: 'Received in the Senate.'
      },
      updateDate: '2025-07-21T19:44:15Z',
      apiUrl: 'https://api.congress.gov/v3/bill/119/hr/28?format=json',
      url: 'https://www.congress.gov/bill/119th-congress/house-bill/28'
    }]
  }), {
    id: 'congress-ew-bills',
    name: 'Congress.gov House Education & Workforce Bills',
    category: 'gov',
    format: 'json',
    congressCommitteeBills: true
  });

  assert.ok(item);
  assert.equal(item.title, 'HR 28 - Protection of Women and Girls in Sports Act of 2025');
  assert.equal(item.url, 'https://www.congress.gov/bill/119th-congress/house-bill/28');
  assert.equal(item.summary, 'Received in the Senate. • 2025-01-15 • 2025-07-21T19:44:15Z');
  assert.equal(item.latestAction.text, 'Received in the Senate.');
  assert.equal(item.updateDate, '2025-07-21T19:44:15Z');
  assert.equal(item.apiUrl, 'https://api.congress.gov/v3/bill/119/hr/28?format=json');
});

test('normalizeJsonSignals maps committee bill rows when detail enrichment is skipped', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    bills: [{
      congress: 119,
      billType: 'S',
      billNumber: '47',
      latestAction: {
        actionDate: '2025-01-09T19:48:33Z',
        text: 'Referred To'
      },
      updateDate: '2025-01-10T11:56:25Z',
      apiUrl: 'https://api.congress.gov/v3/bill/119/s/47?format=json',
    }]
  }), {
    id: 'congress-help-bills',
    name: 'Congress.gov Senate HELP Bills',
    category: 'gov',
    format: 'json',
    congressCommitteeBills: true
  });

  assert.ok(item);
  assert.equal(item.title, 'S 47');
  assert.equal(item.url, 'https://www.congress.gov/bill/119th-congress/senate-bill/47');
  assert.equal(item.summary, 'Referred To • 2025-01-09T19:48:33Z • 2025-01-10T11:56:25Z');
  assert.equal(item.publishedAt, Date.parse('2025-01-10T11:56:25Z'));
});

test('normalizeJsonSignals prefers enriched committee bills over the original wrapper rows', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    bills: [{
      congress: 119,
      type: 'HR',
      number: '28',
      title: 'Protection of Women and Girls in Sports Act of 2025',
      latestAction: {
        actionDate: '2025-01-15',
        text: 'Received in the Senate.'
      },
      updateDate: '2025-07-21T19:44:15Z',
      apiUrl: 'https://api.congress.gov/v3/bill/119/hr/28?format=json',
      url: 'https://www.congress.gov/bill/119th-congress/house-bill/28'
    }],
    committeeBills: {
      bills: [{
        congress: 119,
        billType: 'HR',
        billNumber: '28',
        relationshipType: 'Referred to Committee',
        updateDate: '2025-01-01T00:00:00Z',
        url: 'https://api.congress.gov/v3/bill/119/hr/28?format=json'
      }]
    }
  }), {
    id: 'congress-ew-bills',
    name: 'Congress.gov House Education & Workforce Bills',
    category: 'gov',
    format: 'json',
    congressCommitteeBills: true
  });

  assert.ok(item);
  assert.equal(item.title, 'HR 28 - Protection of Women and Girls in Sports Act of 2025');
  assert.equal(item.summary, 'Received in the Senate. • 2025-01-15 • 2025-07-21T19:44:15Z');
  assert.equal(item.updateDate, '2025-07-21T19:44:15Z');
  assert.equal(item.apiUrl, 'https://api.congress.gov/v3/bill/119/hr/28?format=json');
});

test('normalizeJsonSignals maps Federal Register Education document links and dates', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({
    results: [{
      title: 'Education Department notice',
      abstract: 'Comment request.',
      html_url: 'https://www.federalregister.gov/documents/2026/07/08/2026-13799/example',
      publication_date: '2026-07-08',
      agencies: [{ slug: 'education-department' }]
    }]
  }), {
    id: 'federal-register-ed',
    name: 'Federal Register (Education)',
    category: 'gov',
    format: 'json'
  });

  assert.ok(item);
  assert.equal(item.title, 'Education Department notice');
  assert.equal(item.url, 'https://www.federalregister.gov/documents/2026/07/08/2026-13799/example');
  assert.equal(item.publishedAt, Date.parse('2026-07-08'));
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
    id: 'federal-register-ed',
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

test('committee Congress feed URLs keep congress local and add a date window', () => {
  const feed = {
    id: 'congress-ew-bills',
    url: 'https://api.congress.gov/v3/committee/house/hsed00/bills?format=json&limit=20',
    supportsParams: true,
    congressCommitteeBills: true,
    defaultParams: { congress: 119 }
  };

  const defaultUrl = new URL(buildFeedUrl(feed, {}));
  assert.equal(defaultUrl.pathname, '/v3/committee/house/hsed00/bills');
  assert.equal(defaultUrl.searchParams.has('congress'), false);
  assert.equal(defaultUrl.searchParams.get('fromDateTime'), '2025-01-03T00:00:00Z');
  assert.equal(defaultUrl.searchParams.get('toDateTime'), '2027-01-03T00:00:00Z');

  const requestedUrl = new URL(buildFeedUrl(feed, { params: { congress: 118 } }));
  assert.equal(requestedUrl.pathname, '/v3/committee/house/hsed00/bills');
  assert.equal(requestedUrl.searchParams.has('congress'), false);
  assert.equal(requestedUrl.searchParams.get('fromDateTime'), '2023-01-03T00:00:00Z');
  assert.equal(requestedUrl.searchParams.get('toDateTime'), '2025-01-03T00:00:00Z');
});

test('committee Congress enrichment synthesizes detail URLs from bill identifiers', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'gcp', 'mcp-proxy', 'server.js'), 'utf8');
  assert.match(source, /function buildCongressBillDetailApiUrl/);
  assert.match(source, /const type = row\.type \|\| row\.billType/);
  assert.match(source, /const number = row\.number \|\| row\.billNumber/);
  assert.match(source, /const upstreamRows = getCongressCommitteeBillRows\(parsed\)/);
  assert.match(source, /committeeBills: \{[\s\S]*bills: \[\]/);
  assert.match(source, /fetchCongressBillDetail\(apiUrl, feed, key, requestHeaders, timeoutMs\)/);
});

test('signals.list passes limit to committee detail enrichment without breaking raw.fetch', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'gcp', 'mcp-proxy', 'server.js'), 'utf8');
  assert.match(source, /'raw\.fetch'[\s\S]*const result = await fetchRaw\(feed, \{ query, start, end, params \}\)/);
  assert.match(source, /'signals\.list'[\s\S]*const result = await fetchRaw\(feed, \{ query, start, end, params, limit \}\)/);
});

test('signal item ids prefer stable upstream identifiers before titles and timestamps', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'gcp', 'mcp-proxy', 'server.js'), 'utf8');
  assert.match(source, /const stableSourceId = item\.apiUrl \|\| item\.docId \|\| item\.documentNumber \|\| item\.packageId \|\| item\.sourceId \|\| ''/);
  assert.ok(source.includes('const base = stableSourceId'));
  assert.ok(source.includes('`${stableSourceId}|${item.url || \'\'}'));
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

test('live fallback is disabled when query or params differ from the static snapshot request', () => {
  const openStatesFeed = {
    id: 'state-legislation',
    supportsParams: true,
    paramStrategy: 'openstates-jurisdiction',
    defaultParams: {
      classification: '',
      per_page: 20
    }
  };
  const rulemakingFeed = {
    id: 'state-rulemaking',
    supportsParams: true,
    paramStrategy: 'state-code',
    defaultParams: {
      state: '',
      signalType: 'rulemaking'
    },
    capabilities: ['rulemaking']
  };
  const searchFeed = {
    id: 'google-news-search',
    supportsQuery: true,
    defaultQuery: 'breaking'
  };
  const plainFeed = {
    id: 'congress-hearings'
  };

  assert.equal(shouldUseLiveFallback(openStatesFeed, {}), true);
  assert.equal(shouldUseLiveFallback(openStatesFeed, { params: { per_page: 20 } }), true);
  assert.equal(shouldUseLiveFallback(openStatesFeed, { params: { q: 'noncompete', per_page: 3 } }), false);
  assert.equal(shouldUseLiveFallback(openStatesFeed, { params: { state: 'NY' } }), false);
  assert.equal(shouldUseLiveFallback(rulemakingFeed, { params: { state: 'TX' } }), false);
  assert.equal(shouldUseLiveFallback(searchFeed, {}), true);
  assert.equal(shouldUseLiveFallback(searchFeed, { query: 'breaking' }), true);
  assert.equal(shouldUseLiveFallback(searchFeed, { query: '' }), true);
  assert.equal(shouldUseLiveFallback(searchFeed, { query: 'breaking when:1d' }), true);
  assert.equal(shouldUseLiveFallback(searchFeed, { query: 'accreditation' }), false);
  assert.equal(shouldUseLiveFallback(searchFeed, { query: 'accreditation when:1d' }), false);
  assert.equal(shouldUseLiveFallback(plainFeed, { params: { q: 'noncompete' } }), false);
  assert.equal(shouldUseLiveFallback(plainFeed, { query: 'noncompete' }), true);
  assert.equal(shouldUseLiveFallback({ ...plainFeed, url: 'https://example.test/{{query}}' }, { query: 'noncompete' }), false);
  assert.equal(shouldUseLiveFallback(openStatesFeed, { start: '2026-07-01' }), false);
});

test('OpenStates raw result cache evicts the least recently used entry and clones results', () => {
  resetOpenStatesRawCacheForTest();
  try {
    setOpenStatesCachedRaw('first', { body: 'first', responseHeaders: { etag: 'first' } });
    const firstHit = getOpenStatesCachedRaw('first');
    firstHit.responseHeaders.etag = 'mutated';
    assert.equal(getOpenStatesCachedRaw('first').responseHeaders.etag, 'first');

    if (openStatesCacheEntryCapacity === 1) {
      setOpenStatesCachedRaw('second', { body: 'second' });
      assert.equal(getOpenStatesCachedRaw('first'), null);
      assert.equal(getOpenStatesCachedRaw('second').body, 'second');
      return;
    }

    setOpenStatesCachedRaw('second', { body: 'second' });
    getOpenStatesCachedRaw('first');

    for (let index = 0; index < openStatesCacheEntryCapacity - 2; index += 1) {
      setOpenStatesCachedRaw(`entry-${index}`, { body: String(index) });
    }
    setOpenStatesCachedRaw('overflow', { body: 'overflow' });

    assert.equal(getOpenStatesCachedRaw('second'), null);
    assert.equal(getOpenStatesCachedRaw('first').responseHeaders.etag, 'first');
    assert.equal(getOpenStatesCachedRaw('overflow').body, 'overflow');
  } finally {
    resetOpenStatesRawCacheForTest();
  }
});

test('OpenStates success cache TTL is bounded by the feed freshness contract', () => {
  assert.equal(getOpenStatesSuccessCacheTtl({ ttlMinutes: 120 }), 120 * 60 * 1000);
  assert.equal(getOpenStatesSuccessCacheTtl({ ttlMinutes: 480 }), 6 * 60 * 60 * 1000);
  assert.equal(getOpenStatesSuccessCacheTtl({}), 6 * 60 * 60 * 1000);
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

test('money flow umbrella aliases expand from data-driven mappings', () => {
  const expectedExpansion = {
    umbrella: 'Strategic Education',
    expandedTo: [
      'STRAYER UNIVERSITY, LLC',
      'STRAYER UNIVERSITY',
      'CAPELLA EDUCATION COMPANY',
      'CAPELLA UNIVERSITY',
      'STRATEGIC EDUCATION, INC.'
    ]
  };

  assert.deepEqual(resolveMoneyAliasExpansion('SEI'), expectedExpansion);

  const profile = buildMoneyQueryProfile('Strategic Education');
  assert.deepEqual(profile.aliasExpansion, expectedExpansion);
  assert.ok(findBestMoneyNameMatch(profile, 'STRAYER UNIVERSITY, LLC'));
  assert.ok(findBestMoneyNameMatch(profile, 'CAPELLA EDUCATION COMPANY'));
  assert.equal(findBestMoneyNameMatch(profile, 'STRATEGIC DEFENSE LLC'), null);
});

test('money flow explicit entities bypass umbrella aliases', () => {
  const profile = buildMoneyQueryProfile('Strategic Education', {
    entities: ['Example Legal Entity LLC']
  });

  assert.deepEqual(profile.aliasExpansion, {
    umbrella: 'Strategic Education',
    expandedTo: ['Example Legal Entity LLC'],
    explicit: true
  });
  assert.deepEqual(profile.searchTerms, ['Example Legal Entity LLC']);
  assert.ok(findBestMoneyNameMatch(profile, 'EXAMPLE LEGAL ENTITY, LLC'));
  assert.equal(findBestMoneyNameMatch(profile, 'STRAYER UNIVERSITY, LLC'), null);
});

test('money flow match modes and minScore tune word-boundary matching', () => {
  const normal = buildMoneyQueryProfile('Strategic Education');
  const loose = buildMoneyQueryProfile('Strategic Education', { matchMode: 'loose', minScore: 50 });

  assert.equal(normal.matchMode, 'normal');
  assert.equal(normal.matchThreshold, 0.66);
  assert.equal(findBestMoneyNameMatch(normal, 'STRATEGIC EDUCATION RESEARCH PARTNERSHIP INSTITUTE'), null);
  assert.ok(findBestMoneyNameMatch(loose, 'STRATEGIC EDUCATION RESEARCH PARTNERSHIP INSTITUTE'));
  assert.equal(findBestMoneyNameMatch(loose, 'STRATEGIC DEFENSE LLC'), null);
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

  const strictProfile = buildMoneyQueryProfile('airport terminal', { minScore: 90 });
  assert.equal(attachMoneyMatch(strictProfile, {
    source: 'USAspending',
    entity: 'City Transit Authority',
    recipient: 'City Transit Authority',
    keywordMatchFields: ['Airport terminal expansion and safety grant']
  }), null);
  assert.equal(attachMoneyMatch(buildMoneyQueryProfile('airport terminal', { matchMode: 'strict' }), {
    source: 'USAspending',
    entity: 'City Transit Authority',
    recipient: 'City Transit Authority',
    keywordMatchFields: ['Airport terminal expansion and safety grant']
  }), null);

  const entities = summarizeMoneyEntities([item]);
  assert.equal(entities[0].name, 'CITY TRANSIT AUTHORITY');
  assert.equal(entities[0].sample, 'City Transit Authority');
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

test('state connector configuration is explicit in catalog metadata', () => {
  const rulemakingFeed = {
    id: 'state-rulemaking',
    requiresConfig: true
  };

  assert.deepEqual(getFeedConfiguration(rulemakingFeed, {}), {
    configured: false,
    requiredEnv: ['STATE_CONNECTOR_BASE_URL', 'STATE_CONNECTOR_API_KEY'],
    optionalEnv: ['STATE_CONNECTOR_KEY_HEADER'],
    coveredStates: ['CA', 'FL', 'MN', 'NY', 'TX', 'VA'],
    message: 'State connector provider is not configured.'
  });
  assert.equal(getFeedConfiguration(rulemakingFeed, {
    STATE_CONNECTOR_BASE_URL: 'https://state.example',
    STATE_CONNECTOR_API_KEY: 'secret'
  }).configured, true);

  assert.deepEqual(getFeedConfiguration({ id: 'acled-events', acledMode: 'aggregated', requiresConfig: true }, {}), {
    configured: false,
    requiredEnv: ['ACLED_PROXY'],
    optionalEnv: [],
    message: 'ACLED proxy is not configured.'
  });
  assert.equal(getFeedConfiguration({ id: 'acled-events', acledMode: 'aggregated', requiresConfig: true }, {
    ACLED_PROXY: 'https://acled.example'
  }).configured, true);
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

const nwsFeed = { id: 'nws-alerts', name: 'NWS Alerts (US)', category: 'weather', format: 'json', url: 'https://api.weather.gov/alerts/active' };
function nwsFixture(overrides = {}) {
  return {
    type: 'Feature',
    id: 'https://api.weather.gov/alerts/fixture-nc',
    geometry: { type: 'Polygon', coordinates: [[[-83, 35], [-82, 35], [-82, 36], [-83, 35]]] },
    properties: {
      id: 'urn:fixture:nc', event: 'Flood Warning', headline: 'Flood Warning for Buncombe',
      description: 'Fixture warning description.', instruction: 'Fixture action.',
      status: 'Actual', messageType: 'Alert', severity: 'Severe', urgency: 'Immediate', certainty: 'Observed',
      sent: '2026-09-04T12:00:00-04:00', effective: '2026-09-04T12:05:00-04:00', expires: '2026-09-04T14:00:00-04:00',
      areaDesc: 'Buncombe', geocode: { UGC: ['NCC021'] }, affectedZones: ['https://api.weather.gov/zones/county/NCC021'],
      ...overrides
    }
  };
}

test('NWS normalization preserves alert details, polygons, source timestamps, and state search', () => {
  const feature = nwsFixture();
  const [item] = normalizeJsonSignals(JSON.stringify({ features: [feature] }), nwsFeed);
  assert.equal(item.title, feature.properties.headline);
  assert.equal(item.url, feature.id);
  assert.equal(item.docId, feature.properties.id);
  assert.equal(item.publishedAt, Date.parse(feature.properties.sent));
  assert.equal(item.expires, feature.properties.expires);
  assert.equal(item.instruction, feature.properties.instruction);
  assert.equal(item.severity, 'Severe');
  assert.equal(item.status, 'Actual');
  assert.deepEqual(item.geometry, feature.geometry);
  assert.equal(item.geo, null, 'do not turn a polygon into a fabricated point');
  assert.deepEqual(item.jurisdictionCodes, ['NC']);
  assert.deepEqual(item.jurisdictionNames, ['North Carolina']);
  assert.equal(matchesSignalQuery(item, 'north carolina', nwsFeed), true);
  assert.equal(matchesSignalQuery(item, 'buncombe', nwsFeed), true);
  assert.equal(matchesSignalQuery(item, 'california', nwsFeed), false);
  assert.equal(shouldFilterSmartFeedLocally({ feed: nwsFeed, query: 'North Carolina' }), true);
});

test('NWS searches include records beyond the generic first-50 cap and suppress test alerts', () => {
  const features = Array.from({ length: 55 }, (_, index) => nwsFixture({ id: `urn:fixture:${index}`, areaDesc: 'Virginia', geocode: { UGC: ['VAC001'] }, affectedZones: [] }));
  features.push(nwsFixture(), nwsFixture({ status: 'Test' }), nwsFixture({ status: 'Exercise' }));
  const items = normalizeJsonSignals(JSON.stringify({ features }), nwsFeed);
  assert.equal(items.length, 56);
  assert.equal(items.filter((item) => matchesSignalQuery(item, 'north carolina', nwsFeed)).length, 1);
  assert.equal(items.filter((item) => matchesSignalQuery(item, 'alaska', nwsFeed)).length, 0);
  assert.deepEqual(normalizeJsonSignals('{"features":[]}', nwsFeed), []);
});

test('NWS missing dates stay unknown, fallback event titles work, and multi-state zones remain searchable', () => {
  const [item] = normalizeJsonSignals(JSON.stringify({ features: [nwsFixture({
    headline: null, sent: 'bad-date', effective: null,
    geocode: { UGC: ['NCC021', 'SCC001'] }, affectedZones: []
  })] }), nwsFeed);
  assert.equal(item.title, 'Flood Warning');
  assert.equal(item.publishedAt, null);
  assert.equal(matchesSignalQuery(item, 'south carolina', nwsFeed), true);
});

test('fire identities and deduplication preserve distinct detections with equal titles and times', () => {
  const fireFeed = { id: 'nasa-firms', name: 'NASA FIRMS', category: 'disaster' };
  const rows = [
    { title: 'Fire detection', publishedAt: 1788548983402, source: 'NOAA HMS', latitude: 46.47, longitude: -105.15, summary: 'FRP 10' },
    { title: 'Fire detection', publishedAt: 1788548983402, source: 'NOAA HMS', latitude: 46.48, longitude: -105.16, summary: 'FRP 10' },
    { title: 'Fire detection', publishedAt: 1788548983402, source: 'NOAA HMS', latitude: 46.47, longitude: -105.15, summary: 'FRP 20' }
  ];
  const items = normalizeJsonSignals(JSON.stringify({ items: rows }), fireFeed);
  assert.equal(new Set(items.map(createItemId)).size, 3);
  assert.equal(dedupeSignals([...items, items[0]]).length, 3);
  assert.equal(items[0].source, 'NOAA HMS');
  const reordered = normalizeJsonSignals(JSON.stringify({ items: [...rows].reverse() }), fireFeed);
  assert.deepEqual(reordered.map(createItemId).reverse(), items.map(createItemId));
});

test('geographic zero coordinates survive while missing coordinates stay missing', () => {
  const [zero, missing] = normalizeJsonSignals(JSON.stringify({ items: [
    { title: 'Zero', latitude: 0, longitude: 0 },
    { title: 'Missing', latitude: null, longitude: null }
  ] }), { id: 'nasa-firms', name: 'NASA FIRMS', category: 'disaster' });
  assert.deepEqual(zero.geo, { lat: 0, lon: 0 });
  assert.equal(missing.geo, null);
});

test('unsupported NC state connector requests report coverage before any network request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  for (const id of ['state-rulemaking', 'state-executive-orders']) {
    const result = await fetchRaw({ id, supportsParams: true, paramStrategy: 'state-code' }, { params: { state: 'NC' } });
    assert.equal(result.error, 'unsupported_state');
    assert.match(result.message, /does not cover NC/);
    assert.match(result.message, /CA, FL, MN, NY, TX, VA/);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('NASA fire fallback keeps the raw response contract and identifies NOAA substitution', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('upstream.test')) return new Response('unavailable', { status: 403 });
    return new Response(JSON.stringify({ features: [{ geometry: { type: 'Point', coordinates: [-105, 46] }, properties: { frp: 10, acq_date: '2026-09-04' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const feed = { id: 'nasa-firms', name: 'NASA FIRMS', category: 'disaster', format: 'json', url: 'https://upstream.test/fire' };
  const result = await fetchRaw(feed, {});
  assert.equal(result.error, undefined);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.proxyUsed, 'arcgis-hms-fire');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.data, undefined, 'raw result fields must not be nested under data');
  const raw = buildRawStructuredContent({ sourceId: feed.id, feed, result, responseFormat: 'json' });
  assert.equal(raw.data.items[0].source, 'NOAA HMS');
  assert.match(raw.warning, /NASA FIRMS unavailable.*NOAA HMS/);
  assert.equal(normalizeJsonSignals(result.body, feed).length, 1);
});

test('published NASA snapshots remain flagged as fallback and retain record attribution', async (t) => {
  const body = JSON.stringify({ items: [{ title: 'Fire detection', latitude: 40, longitude: -100, source: 'NOAA HMS', publishedAt: 1788548983402 }] });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/data/feeds/nasa-firms.json')) return new Response(JSON.stringify({ body, contentType: 'application/json', httpStatus: 200 }));
    return new Response('unavailable', { status: 403 });
  });
  const feed = { id: 'nasa-firms', name: 'NASA FIRMS', category: 'disaster', format: 'json', url: 'https://upstream.test/fire' };
  const result = await fetchRaw(feed, {});
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.proxyUsed, 'live-cache');
  const raw = buildRawStructuredContent({ sourceId: feed.id, feed, result, responseFormat: 'json' });
  assert.match(raw.warning, /cache snapshot/);
  assert.equal(raw.data.items[0].source, 'NOAA HMS');
});

test('malformed NWS responses are failures while a real empty alert set is successful', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const bad = await fetchRaw(nwsFeed, {});
  assert.equal(bad.error, 'invalid_response');
  globalThis.fetch.mock.mockImplementation(async () => new Response('{"features":[]}', { headers: { 'content-type': 'application/json' } }));
  const empty = await fetchRaw(nwsFeed, {});
  assert.equal(empty.error, undefined);
  assert.deepEqual(normalizeJsonSignals(empty.body, nwsFeed), []);
});

test('MCP tool calls preserve NWS geography through raw, list, search, and get routes', async (t) => {
  const requireFromProxy = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
  const { Client } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { InMemoryTransport } = await import(requireFromProxy.resolve('@modelcontextprotocol/sdk/inMemory.js'));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [nwsFixture(), nwsFixture({ status: 'Test' })] }), { headers: { 'content-type': 'application/geo+json' } }));
  const server = buildMcpServer();
  const client = new Client({ name: 'signal-contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const raw = await call('raw.fetch', { sourceId: 'nws-alerts', format: 'json' });
  assert.equal(raw.data.features.length, 2, 'raw access preserves upstream test messages');
  const listed = await call('signals.list', { sourceId: 'nws-alerts', query: 'North Carolina', limit: 5 });
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.items[0].geometry, nwsFixture().geometry);
  const searched = await call('search.smart', { sources: ['nws-alerts'], query: 'North Carolina', totalLimit: 5 });
  assert.equal(searched.signals.length, 1);
  assert.equal(searched.signals[0].id, listed.items[0].id);
  const found = await call('signals.get', { sourceId: 'nws-alerts', id: listed.items[0].id });
  assert.equal(found.item.docId, 'urn:fixture:nc');
  const empty = await call('search.smart', { sources: ['nws-alerts'], query: 'Alaska' });
  assert.equal(empty.signals.length, 0);
  assert.equal(empty.sourcesChecked[0].ok, true);
  const unsupported = await call('signals.list', { sourceId: 'state-rulemaking', params: { state: 'NC' } });
  assert.equal(unsupported.error, 'unsupported_state');
});
