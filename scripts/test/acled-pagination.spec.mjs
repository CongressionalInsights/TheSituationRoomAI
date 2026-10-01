import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../gcp/acled-proxy/server.js', import.meta.url), 'utf8');
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/acled/pagination.json', import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const eventFields = 'event_id_cnty|event_date|disorder_type|event_type|sub_event_type|actor1|actor2|fatalities|latitude|longitude|country|admin1|admin2|location|notes|source';
const harvestFields = 'event_date|disorder_type|event_type|sub_event_type|fatalities|latitude|longitude|country|admin1|admin2|location';

function loadFixtureProxy(responses) {
  const calls = [];
  let tokenCalls = 0;
  const start = source.indexOf('function parseAcledCursor(');
  const end = source.indexOf('\nconst server = http.createServer', start);
  const dateStart = source.indexOf('function formatIsoDate(');
  const dateEnd = source.indexOf('\n}', dateStart) + 2;
  assert.ok(start > 0 && end > start && dateEnd > dateStart);
  const code = `${source.slice(dateStart, dateEnd)}\n${source.slice(start, end)}`;
  assert.doesNotMatch(code, /\bimport\b|process\.env|http\.createServer|server\.listen|async function getAccessToken|requestToken|AdmZip/);
  const context = {
    URL,
    URLSearchParams,
    ACLED_ENDPOINT: 'https://fixture.invalid/api/acled/read',
    DEFAULT_LOOKBACK_DAYS: 30,
    AGGREGATED_CACHE_TTL: 6 * 60 * 60 * 1000,
    aggregatedCache: new Map(),
    getAccessToken: async () => { tokenCalls += 1; return 'inert-fixture-token'; },
    fetch: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://fixture.invalid');
      assert.equal(parsed.pathname, '/api/acled/read');
      assert.equal(options.headers.Authorization, 'Bearer inert-fixture-token');
      assert.equal(parsed.searchParams.has('page'), false);
      calls.push(parsed);
      assert.ok(calls.length <= responses.length, 'Unexpected fixture request');
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return {
        ok: response.status ? response.status < 400 : true,
        status: response.status || 200,
        text: async () => response.raw ?? JSON.stringify(response.body ?? response)
      };
    },
    sendJson: (res, status, payload) => { res.status = status; res.body = clone(payload); }
  };
  vm.runInNewContext(`${code}\nthis.proxy = { buildAcledUrl, handleEvents, probeEventRange, fetchEventRows, handleAggregated };`, context);
  return { ...context.proxy, calls, cache: context.aggregatedCache, tokenCalls: () => tokenCalls };
}

async function route(proxy, name, query = '') {
  const res = {};
  await proxy[name]({ url: `/api/acled/${name === 'handleEvents' ? 'events' : 'aggregated'}${query}`, headers: {} }, res);
  return res;
}

const cursors = (proxy) => proxy.calls.map((url) => url.searchParams.get('cursor'));

test('ACLED URL starts at explicit zero and cursor takes precedence over legacy page', () => {
  const proxy = loadFixtureProxy([]);
  for (const params of [{}, { cursor: 0 }, { cursor: '0', page: 9 }, { page: 1 }]) {
    assert.equal(new URL(proxy.buildAcledUrl(params)).searchParams.get('cursor'), '0');
  }
  const url = new URL(proxy.buildAcledUrl({ cursor: 48213, page: 2, limit: 12, country: 'Fixture Country', event_date: '2026-09-01|2026-09-07', event_date_where: 'BETWEEN', fields: 'event_date|source' }));
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    _format: 'json', limit: '12', cursor: '48213', country: 'Fixture Country',
    event_date: '2026-09-01|2026-09-07', event_date_where: 'BETWEEN', fields: 'event_date|source'
  });
  assert.equal(proxy.tokenCalls(), 0);
  assert.throws(() => proxy.buildAcledUrl({ page: 2 }), /page_pagination_unsupported/);
});

test('ACLED harvest follows actual cursors across short and empty continuing pages', async () => {
  const proxy = loadFixtureProxy([fixtures.short_continuation, fixtures.empty_continuation, fixtures.full_terminal]);
  const result = clone(await proxy.fetchEventRows({ start: '2026-09-01', end: '2026-09-07', country: 'Fixture Country', limit: 2 }));
  assert.deepEqual(cursors(proxy), ['0', '48213', '96543']);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0], fixtures.short_continuation.data[0]);
  assert.deepEqual(result.pagination, {
    complete: true, partial: false, resumable: false, initial_cursor: 0, next_cursor: null,
    requests: 3, request_limit: 6, row_count: 3, start: '2026-09-01', end: '2026-09-07', country: 'Fixture Country'
  });
  for (const url of proxy.calls) {
    assert.equal(url.searchParams.get('fields'), harvestFields);
    assert.equal(url.searchParams.get('country'), 'Fixture Country');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('event_date'), '2026-09-01|2026-09-07');
    assert.equal(url.searchParams.get('event_date_where'), 'BETWEEN');
  }
});

test('ACLED full or empty page is terminal only with explicit null', async () => {
  for (const body of [fixtures.full_terminal, fixtures.empty_terminal]) {
    const proxy = loadFixtureProxy([body]);
    const result = await proxy.fetchEventRows({ limit: 2 });
    assert.equal(result.pagination.complete, true);
    assert.equal(result.pagination.next_cursor, null);
    assert.equal(result.rows.length, body.data.length);
    assert.equal(proxy.calls.length, 1);
  }
});

test('ACLED missing, nested, malformed continuation and malformed data fail closed', async () => {
  const missing = { data: [] };
  const nested = { data: [], pagination: { next_cursor: null } };
  const malformed = fixtures.invalid_next_cursors.map((next_cursor) => ({ data: [], next_cursor }));
  for (const body of [missing, nested, ...malformed, { data: {}, next_cursor: null }]) {
    const proxy = loadFixtureProxy([body]);
    await assert.rejects(proxy.fetchEventRows({ limit: 2 }), (err) => {
      assert.match(err.message, /acled_pagination_(missing_next_cursor|invalid_next_cursor|invalid_data)/);
      assert.equal(err.pagination.complete, false);
      assert.equal(err.pagination.resumable, false);
      assert.equal(Object.hasOwn(err.pagination, 'next_cursor'), false);
      return true;
    });
    assert.equal(proxy.calls.length, 1);
  }
});

test('ACLED detects repeated cursor and multi-page cycles without another request', async () => {
  const cases = [
    [{ data: [], next_cursor: 0 }],
    [fixtures.short_continuation, { data: [], next_cursor: 48213 }],
    [fixtures.short_continuation, fixtures.empty_continuation, { data: [], next_cursor: 48213 }]
  ];
  for (const responses of cases) {
    const proxy = loadFixtureProxy(responses);
    await assert.rejects(proxy.fetchEventRows({ limit: 2 }), /acled_pagination_repeated_next_cursor/);
    assert.equal(proxy.calls.length, responses.length);
  }
});

test('ACLED six-request and row bounds return explicit resumable partial harvest', async () => {
  const responses = fixtures.budget_cursors.map((next_cursor) => ({ ...fixtures.full_terminal, next_cursor }));
  const proxy = loadFixtureProxy(responses);
  const result = await proxy.fetchEventRows({ limit: 2 });
  assert.equal(proxy.calls.length, 6);
  assert.equal(result.rows.length, 12);
  assert.deepEqual(cursors(proxy), ['0', ...fixtures.budget_cursors.slice(0, -1).map(String)]);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.partial, true);
  assert.equal(result.pagination.resumable, true);
  assert.equal(result.pagination.reason, 'request_limit');
  assert.equal(result.pagination.next_cursor, fixtures.budget_cursors.at(-1));
});

test('ACLED oversized response cannot exceed the retained row budget', async () => {
  const proxy = loadFixtureProxy([fixtures.full_terminal]);
  await assert.rejects(proxy.fetchEventRows({ limit: 1 }), (err) => {
    assert.equal(err.pagination.reason, 'row_limit_exceeded');
    assert.equal(err.pagination.row_count, 0);
    assert.equal(err.pagination.resumable, false);
    return true;
  });
});

test('ACLED transport and parsing errors cannot advertise resume after unreturned rows', async () => {
  for (const response of [new Error('fixture_transport_failure'), { status: 503, raw: 'fixture_unavailable' }, { raw: '{invalid-json' }]) {
    const proxy = loadFixtureProxy([fixtures.short_continuation, response]);
    await assert.rejects(proxy.fetchEventRows({ limit: 2 }), (err) => {
      assert.equal(err.pagination.complete, false);
      assert.equal(err.pagination.partial, true);
      assert.equal(err.pagination.resumable, false);
      assert.equal(Object.hasOwn(err.pagination, 'next_cursor'), false);
      assert.equal(err.pagination.row_count, 1);
      assert.equal(err.pagination.requests, 2);
      return true;
    });
  }
});

test('ACLED events forwards zero or documented cursor with unchanged native fields and terminal payload', async () => {
  for (const query of ['', '?cursor=0&page=9', '?cursor=48213&page=9']) {
    const proxy = loadFixtureProxy([fixtures.full_terminal]);
    const res = await route(proxy, 'handleEvents', query);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ...fixtures.full_terminal, continuation_params: null });
    assert.deepEqual(cursors(proxy), [query.includes('48213') ? '48213' : '0']);
    assert.equal(proxy.calls[0].searchParams.get('fields'), eventFields);
    assert.equal(proxy.calls[0].searchParams.get('limit'), '500');
  }
});

test('ACLED events exact native date replay takes precedence and only accepts existing predicates', async () => {
  for (const event_date_where of ['', 'BETWEEN']) {
    const proxy = loadFixtureProxy([fixtures.short_continuation, fixtures.empty_terminal]);
    const params = { cursor: 0, start: '2026-10-01', end: '2026-10-07', event_date: '2026-09-01|2026-09-07', event_date_where, country: 'Fixture', fields: 'event_date|source', limit: '2' };
    const first = await route(proxy, 'handleEvents', `?${new URLSearchParams(params)}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.continuation_params, {
      cursor: 48213, event_date: params.event_date, event_date_where, country: 'Fixture', fields: 'event_date|source', limit: '2'
    });
    const terminal = await route(proxy, 'handleEvents', `?${new URLSearchParams(first.body.continuation_params)}`);
    assert.deepEqual(terminal.body, { ...fixtures.empty_terminal, continuation_params: null });
    assert.deepEqual(cursors(proxy), ['0', '48213']);
    for (const url of proxy.calls) {
      assert.equal(url.searchParams.get('event_date'), params.event_date);
      assert.equal(url.searchParams.get('event_date_where'), event_date_where || null);
    }
  }
  for (const query of ['?event_date=2026-09-01&event_date_where=%3E', '?event_date=2026-09-01&event_date_where=LIKE', '?event_date_where=BETWEEN']) {
    const proxy = loadFixtureProxy([]);
    const res = await route(proxy, 'handleEvents', query);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_event_date_where');
    assert.equal(proxy.calls.length, 0);
    assert.equal(proxy.tokenCalls(), 0);
  }
});

test('ACLED invalid user cursors fail before token stub or request in both routes', async () => {
  for (const value of ['', '-1', '1.5', 'NaN', 'opaque', '9007199254740992']) {
    for (const name of ['handleEvents', 'handleAggregated']) {
      const proxy = loadFixtureProxy([]);
      const res = await route(proxy, name, `?cursor=${value}`);
      assert.equal(res.status, 400);
      assert.equal(proxy.calls.length, 0);
      assert.equal(proxy.tokenCalls(), 0);
    }
  }
});

test('ACLED legacy page-only later pages are rejected instead of silently returning the first page', async () => {
  for (const name of ['handleEvents', 'handleAggregated']) {
    const proxy = loadFixtureProxy([fixtures.full_terminal]);
    const later = await route(proxy, name, '?page=2');
    assert.equal(later.status, 400);
    assert.equal(later.body.error, 'page_pagination_unsupported');
    assert.equal(proxy.calls.length, 0);
    assert.equal(proxy.tokenCalls(), 0);
    assert.equal((await route(proxy, name, '?page=1')).status, 200);
    assert.deepEqual(cursors(proxy), ['0']);
  }
});

test('ACLED initial events recency fallback starts at zero and retains custom filters', async () => {
  const proxy = loadFixtureProxy([fixtures.recency_terminal, fixtures.full_terminal]);
  const res = await route(proxy, 'handleEvents', '?start=2026-09-01&end=2026-09-07&cursor=0&page=9&country=Fixture&limit=2&fields=event_date%7Csource');
  assert.equal(res.status, 200);
  assert.equal(res.body.acled_lag_date, '2026-08-15');
  assert.equal(res.body.continuation_params, null);
  assert.deepEqual(res.body.data, fixtures.full_terminal.data);
  assert.deepEqual(cursors(proxy), ['0', '0']);
  assert.equal(proxy.calls[0].searchParams.get('event_date'), '2026-09-01|2026-09-07');
  assert.equal(proxy.calls[0].searchParams.get('event_date_where'), 'BETWEEN');
  assert.equal(proxy.calls[1].searchParams.get('event_date'), '2026-07-16|2026-08-15');
  assert.equal(proxy.calls[1].searchParams.has('event_date_where'), false);
  for (const url of proxy.calls) {
    assert.equal(url.searchParams.get('country'), 'Fixture');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('fields'), 'event_date|source');
  }
});

test('ACLED recency fallback continuation replays response-provided params through empty null terminal', async () => {
  const proxy = loadFixtureProxy([fixtures.recency_terminal, fixtures.short_continuation, fixtures.empty_continuation, fixtures.recency_terminal]);
  const first = await route(proxy, 'handleEvents', '?start=2026-09-01&end=2026-09-07&cursor=0&country=Fixture&limit=2&fields=event_date%7Csource');
  assert.equal(first.status, 200);
  assert.equal(first.body.acled_lag_date, '2026-08-15');
  assert.deepEqual(first.body.continuation_params, {
    cursor: 48213, event_date: '2026-07-16|2026-08-15', event_date_where: '', country: 'Fixture', fields: 'event_date|source', limit: '2'
  });
  const empty = await route(proxy, 'handleEvents', `?${new URLSearchParams(first.body.continuation_params)}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);
  assert.deepEqual(empty.body.continuation_params, { ...first.body.continuation_params, cursor: 96543 });
  const terminal = await route(proxy, 'handleEvents', `?${new URLSearchParams(empty.body.continuation_params)}`);
  assert.equal(terminal.status, 200);
  assert.deepEqual(terminal.body, { ...fixtures.recency_terminal, continuation_params: null });
  assert.deepEqual(cursors(proxy), ['0', '0', '48213', '96543']);
  assert.equal(proxy.calls[0].searchParams.get('event_date'), '2026-09-01|2026-09-07');
  assert.equal(proxy.calls[0].searchParams.get('event_date_where'), 'BETWEEN');
  for (const url of proxy.calls.slice(1)) {
    assert.equal(url.searchParams.get('event_date'), '2026-07-16|2026-08-15');
    assert.equal(url.searchParams.has('event_date_where'), false);
    assert.equal(url.searchParams.get('country'), 'Fixture');
    assert.equal(url.searchParams.get('fields'), 'event_date|source');
    assert.equal(url.searchParams.get('limit'), '2');
  }
});

test('ACLED events actual continuation ends on empty null without recency scope change', async () => {
  const proxy = loadFixtureProxy([fixtures.short_continuation, fixtures.recency_terminal]);
  const query = '?start=2026-09-01&end=2026-09-07&country=Fixture&limit=2&fields=event_date%7Csource';
  const first = await route(proxy, 'handleEvents', `${query}&cursor=0`);
  assert.equal(first.status, 200);
  assert.equal(first.body.next_cursor, 48213);
  const terminal = await route(proxy, 'handleEvents', `?${new URLSearchParams(first.body.continuation_params)}`);
  assert.equal(terminal.status, 200);
  assert.deepEqual(terminal.body, { ...fixtures.recency_terminal, continuation_params: null });
  assert.deepEqual(cursors(proxy), ['0', '48213']);
  for (const url of proxy.calls) {
    assert.equal(url.searchParams.get('event_date'), '2026-09-01|2026-09-07');
    assert.equal(url.searchParams.get('event_date_where'), 'BETWEEN');
    assert.equal(url.searchParams.get('country'), 'Fixture');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('fields'), 'event_date|source');
  }
});

test('ACLED empty continuing events page does not switch to the recency window', async () => {
  const body = { ...fixtures.recency_terminal, next_cursor: 96543 };
  const proxy = loadFixtureProxy([body]);
  const res = await route(proxy, 'handleEvents', '?cursor=48213');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...body, continuation_params: { cursor: 96543, limit: '500', country: '', event_date: '', event_date_where: '', fields: eventFields } });
  assert.equal(proxy.calls.length, 1);
});

test('ACLED events and recency fallback reject invalid continuation truthfully', async () => {
  for (const responses of [[{ data: [] }], [fixtures.recency_terminal, { data: [] }], ...[null, false, 0].map((body) => [fixtures.recency_terminal, { raw: JSON.stringify(body) }])]) {
    const proxy = loadFixtureProxy(responses);
    const res = await route(proxy, 'handleEvents', '?cursor=0');
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'pagination_error');
    assert.equal(res.body.pagination.complete, false);
    assert.equal(res.body.pagination.resumable, false);
  }
});

test('ACLED each range probe starts at zero and does not misclassify empty continuation', async () => {
  const proxy = loadFixtureProxy([fixtures.empty_terminal, fixtures.empty_continuation]);
  assert.equal(await proxy.probeEventRange({ start: '2026-09-01', end: '2026-09-07' }), false);
  assert.equal(await proxy.probeEventRange({ start: '2026-08-26', end: '2026-09-01' }), true);
  assert.deepEqual(cursors(proxy), ['0', '0']);
  for (const url of proxy.calls) {
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.get('fields'), 'event_date');
    assert.equal(url.searchParams.get('event_date_where'), 'BETWEEN');
  }
});

test('ACLED aggregate cache separates cursor identity and preserves normalization', async () => {
  const proxy = loadFixtureProxy([fixtures.full_terminal, fixtures.full_terminal]);
  const first = await route(proxy, 'handleAggregated', '?country=Fixture&cursor=0');
  const resumed = await route(proxy, 'handleAggregated', '?country=Fixture&cursor=48213');
  const cached = await route(proxy, 'handleAggregated', '?country=Fixture&cursor=0');
  assert.deepEqual(cursors(proxy), ['0', '48213']);
  assert.deepEqual(cached, first);
  assert.equal(resumed.body.pagination.initial_cursor, 48213);
  assert.equal(first.body.source, 'acled');
  assert.equal(first.body.region, 'global');
  assert.equal(first.body.count, 1);
  assert.equal(first.body.pagination.complete, true);
  assert.deepEqual(first.body.delivery, {
    complete: true, output_truncated: false, output_limit: 2000, group_count: 1, returned_count: 1, discarded_count: 0
  });
  assert.deepEqual(first.body.data, [{
    week: '2026-08-29', country: 'Fixture Country', admin1: 'Fixture Admin',
    disorder_type: 'Political violence', event_type: 'Battles', sub_event_type: 'Armed clash',
    event_count: 2, fatalities: 5, centroid_latitude: 11, centroid_longitude: 21
  }]);
  assert.equal(proxy.calls[0].searchParams.get('limit'), '5000');
});

test('ACLED sliced partial aggregate disables lossless resume and marks cursor as provenance', async () => {
  const responses = fixtures.budget_cursors.map((next_cursor, index) => ({ ...(index === 0 ? fixtures.two_group_terminal : fixtures.empty_terminal), next_cursor }));
  const proxy = loadFixtureProxy([...responses, fixtures.later_group_terminal]);
  const first = await route(proxy, 'handleAggregated', '?country=Fixture&limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 2);
  assert.equal(first.body.data.length, 1);
  assert.equal(first.body.data[0].admin1, 'Group A');
  assert.equal(first.body.pagination.complete, false);
  assert.equal(first.body.pagination.partial, true);
  assert.equal(first.body.pagination.resumable, false);
  assert.equal(first.body.pagination.reason, 'request_limit');
  assert.equal(first.body.pagination.next_cursor, 330011);
  assert.equal(first.body.pagination.next_cursor_role, 'provenance_only');
  assert.deepEqual(first.body.delivery, {
    complete: false, output_truncated: true, output_limit: 1, group_count: 2, returned_count: 1, discarded_count: 1
  });
  const resumed = await route(proxy, 'handleAggregated', `?country=Fixture&limit=1&cursor=${first.body.pagination.next_cursor}`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data[0].admin1, 'Group C');
  assert.equal(resumed.body.pagination.initial_cursor, 330011);
  assert.equal(resumed.body.pagination.resumable, false);
  assert.equal(resumed.body.pagination.next_cursor, null);
  assert.equal(resumed.body.delivery.discarded_count, 0);
  assert.ok([...first.body.data, ...resumed.body.data].every((row) => row.admin1 !== 'Group B'));
  assert.equal(proxy.calls.length, 7);
});

test('ACLED terminal aggregate slicing preserves the output limit without claiming complete delivery', async () => {
  const proxy = loadFixtureProxy([fixtures.two_group_terminal]);
  const res = await route(proxy, 'handleAggregated', '?limit=1&cursor=48213');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.pagination.complete, true);
  assert.equal(res.body.pagination.resumable, false);
  assert.equal(res.body.pagination.next_cursor, null);
  assert.equal(Object.hasOwn(res.body.pagination, 'next_cursor_role'), false);
  assert.deepEqual(res.body.delivery, {
    complete: false, output_truncated: true, output_limit: 1, group_count: 2, returned_count: 1, discarded_count: 1
  });
});

test('ACLED initial aggregate shifted probe window starts its harvest at zero', async () => {
  const proxy = loadFixtureProxy([fixtures.empty_terminal, { data: [fixtures.full_terminal.data[0]], next_cursor: null }, fixtures.full_terminal]);
  const res = await route(proxy, 'handleAggregated', '?start=2026-09-01&end=2026-09-07&cursor=0');
  assert.equal(res.status, 200);
  assert.deepEqual(cursors(proxy), ['0', '0', '0']);
  assert.equal(proxy.calls[2].searchParams.get('event_date'), '2026-08-26|2026-09-01');
  assert.equal(res.body.range_start, '2026-08-26');
  assert.equal(res.body.range_end, '2026-09-01');
  assert.equal(res.body.pagination.initial_cursor, 0);
});

test('ACLED aggregate nonzero cursor directly harvests the exact requested window without probe', async () => {
  const proxy = loadFixtureProxy([fixtures.full_terminal]);
  const res = await route(proxy, 'handleAggregated', '?start=2026-09-01&end=2026-09-07&country=Fixture&cursor=48213');
  assert.equal(res.status, 200);
  assert.deepEqual(cursors(proxy), ['48213']);
  assert.equal(res.body.pagination.initial_cursor, 48213);
  assert.equal(res.body.range_start, '2026-09-01');
  assert.equal(res.body.range_end, '2026-09-07');
  assert.equal(proxy.calls[0].searchParams.get('event_date'), '2026-09-01|2026-09-07');
  assert.equal(proxy.calls[0].searchParams.get('event_date_where'), 'BETWEEN');
  assert.equal(proxy.calls[0].searchParams.get('country'), 'Fixture');
  assert.equal(proxy.calls[0].searchParams.get('limit'), '5000');
  assert.equal(proxy.calls[0].searchParams.get('fields'), harvestFields);
});

test('ACLED aggregate nonzero terminal-empty cursor preserves scope without probe or year fallback', async () => {
  const proxy = loadFixtureProxy([fixtures.empty_terminal]);
  const query = '?start=2026-09-01&end=2026-09-07&country=Fixture&region=us-canada&limit=1&cursor=48213';
  const res = await route(proxy, 'handleAggregated', query);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.source, 'acled');
  assert.equal(res.body.region, 'us-canada');
  assert.equal(res.body.range_start, '2026-09-01');
  assert.equal(res.body.range_end, '2026-09-07');
  assert.deepEqual(res.body.pagination, {
    complete: true, partial: false, resumable: false, initial_cursor: 48213, next_cursor: null,
    requests: 1, request_limit: 6, row_count: 0, start: '2026-09-01', end: '2026-09-07', country: 'Fixture'
  });
  assert.deepEqual(cursors(proxy), ['48213']);
  assert.equal(proxy.calls[0].searchParams.get('event_date'), '2026-09-01|2026-09-07');
  assert.equal(proxy.calls[0].searchParams.get('limit'), '5000');
  assert.equal(proxy.calls[0].searchParams.get('fields'), harvestFields);
  assert.deepEqual(await route(proxy, 'handleAggregated', query), res);
  assert.equal(proxy.calls.length, 1);
});

test('ACLED initial aggregate annual fallback starts a changed query window at zero', async () => {
  const proxy = loadFixtureProxy([{ data: [fixtures.full_terminal.data[0]], next_cursor: null }, fixtures.empty_terminal, fixtures.full_terminal]);
  const res = await route(proxy, 'handleAggregated', '?start=2026-09-01&end=2026-09-07&cursor=0');
  assert.equal(res.status, 200);
  assert.deepEqual(cursors(proxy), ['0', '0', '0']);
  assert.equal(proxy.calls[2].searchParams.get('event_date'), '2025-09-01|2025-09-07');
  assert.equal(res.body.pagination.start, '2025-09-01');
  assert.equal(res.body.pagination.end, '2025-09-07');
});

test('ACLED bounded empty partial harvest stays in its window and cache retains partial metadata', async () => {
  const responses = [{ data: [], next_cursor: 48213 }, ...fixtures.budget_cursors.map((next_cursor) => ({ data: [], next_cursor }))];
  const proxy = loadFixtureProxy(responses);
  const query = '?start=2026-09-01&end=2026-09-07';
  const res = await route(proxy, 'handleAggregated', query);
  assert.equal(res.status, 200);
  assert.equal(proxy.calls.length, 7);
  assert.equal(res.body.pagination.complete, false);
  assert.equal(res.body.pagination.partial, true);
  assert.equal(res.body.pagination.resumable, true);
  assert.equal(res.body.pagination.next_cursor, 330011);
  assert.equal(res.body.delivery.complete, false);
  assert.equal(res.body.delivery.output_truncated, false);
  for (const url of proxy.calls) assert.equal(url.searchParams.get('event_date'), '2026-09-01|2026-09-07');
  assert.deepEqual(await route(proxy, 'handleAggregated', query), res);
  assert.equal(proxy.calls.length, 7);
});

test('ACLED aggregate continuation failure exposes incomplete metadata and is not cached', async () => {
  const proxy = loadFixtureProxy([fixtures.short_continuation, { data: [] }, fixtures.full_terminal]);
  const failed = await route(proxy, 'handleAggregated');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.pagination.complete, false);
  assert.equal(failed.body.pagination.partial, true);
  assert.equal(failed.body.pagination.resumable, false);
  assert.equal(failed.body.pagination.row_count, 1);
  assert.equal(proxy.cache.size, 0);
  assert.equal((await route(proxy, 'handleAggregated')).status, 200);
  assert.deepEqual(cursors(proxy), ['0', '48213', '0']);
});
