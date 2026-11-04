import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchMoneyFlows, buildUsaspendingTransactionKey } from '../../gcp/mcp-proxy/money-flows.js';
import { acquireFec, acquireSam, acquireUsa, acquireMoneySources, fecCycles } from '../../gcp/mcp-proxy/money-sources.js';
import { inspectMoneyFlows, auditMoneyFlows } from '../../analysis/monitor/lib/money_flows.mjs';

const range = { startIso: '2025-01-01', endIso: '2026-11-03', years: [2025, 2026] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const runtime = (fetch, budget = {}) => ({ fetch, sleep: async () => {}, budget });
const empty = (url) => {
  if (url.hostname === 'lda.gov') return json({ results: [], next: null, count: 0 });
  if (url.hostname === 'api.open.fec.gov') return json({ results: [], pagination: { last_indexes: null } });
  if (url.hostname === 'api.usaspending.gov') return json({ results: [], page_metadata: { hasNext: false, next: null } });
  return json({ entityData: [], totalRecords: 0 });
};
const samRow = (id = 'ACME12345678') => ({ entityRegistration: { ueiSAM: id, legalBusinessName: 'Acme', registrationStatus: 'Active', lastUpdateDate: null }, coreData: { physicalAddress: { stateOrProvinceCode: 'VA' } }, totalActiveContracts: 999999 });

test('money adapters and alias configuration are identical in independent deploy contexts', () => {
  for (const file of ['money-flows.js', 'money-sources.js', 'entity-aliases.json']) assert.equal(readFileSync(`gcp/mcp-proxy/${file}`, 'utf8'), readFileSync(`gcp/feed-proxy/${file}`, 'utf8'));
  for (const file of ['server.mjs', 'gcp/feed-proxy/server.js', 'gcp/mcp-proxy/server.js']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /import \{ fetchMoneyFlows \} from/);
    assert.doesNotMatch(source, /async function fetchMoneyFlows/);
  }
});

test('SAM starts at zero, size ten regardless of aggregate 10/60/120, and registrations never become dollars', async () => {
  const previous = process.env.SAMGOV_API_KEY; process.env.SAMGOV_API_KEY = 'fixture-key';
  try {
    for (const limit of [10, 60, 120]) {
      const calls = [];
      const data = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', limit }, runtime(async (raw) => {
        const url = new URL(raw);
        if (url.hostname !== 'api.sam.gov') return empty(url);
        calls.push(url);
        const page = Number(url.searchParams.get('page'));
        assert.equal(url.searchParams.get('size'), '10');
        assert.equal(url.searchParams.get('includeSections'), 'entityRegistration,coreData');
        return json({ entityData: Array.from({ length: page === 0 ? 10 : 1 }, (_, i) => samRow(`UEI-${page}-${i}`)), totalRecords: 11 });
      }));
      assert.deepEqual(calls.map((u) => u.searchParams.get('page')), ['0', '1']);
      assert.equal(data.items.length, Math.min(limit, 11));
      assert.ok(data.items.every((i) => i.amount === null && i.state === 'VA' && i.registrationStatus === 'Active' && i.publishedAt === null));
      assert.equal(data.summary.buckets.registry.totalAmount, null);
      assert.equal(data.summary.top.registry.entityAmount, null);
      assert.equal(data.coverage.outputTruncated, limit === 10);
    }
  } finally { if (previous === undefined) delete process.env.SAMGOV_API_KEY; else process.env.SAMGOV_API_KEY = previous; }
});

test('SAM public next links retain the frozen query; credential identity separates caches and access errors stop siblings', async () => {
  const original = globalThis.fetch; const seen = [];
  globalThis.fetch = async (raw) => { const url = new URL(raw); seen.push(url); return json({ entityData: [samRow()], totalRecords: 1 }); };
  try {
    const args = { terms: ['Unique cache fixture'], runtime: { sleep: async () => {} } };
    await acquireSam({ ...args, key: 'key-a' }); await acquireSam({ ...args, key: 'key-a' }); await acquireSam({ ...args, key: 'key-b' });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((u) => u.searchParams.get('api_key')), ['key-a', 'key-b']);
  } finally { globalThis.fetch = original; }
  let calls = 0;
  const denied = await acquireSam({ terms: ['Acme', 'Acme Inc'], key: 'fixture', runtime: runtime(async () => { calls++; return json({}, 403); }) });
  assert.equal(calls, 1); assert.equal(denied.coverage.status, 'unavailable'); assert.match(denied.error, /403/);
  const links = [];
  const result = await acquireSam({ terms: ['Acme'], key: 'fixture', runtime: runtime(async (raw) => {
    const url = new URL(raw); links.push(url); const page = Number(url.searchParams.get('page'));
    const next = new URL(url); next.searchParams.delete('api_key'); next.searchParams.set('page', '1');
    return json({ entityData: [samRow(String(page))], totalRecords: 2, links: page === 0 ? { nextLink: next.toString() } : {} });
  }) });
  assert.equal(result.items.length, 2); assert.equal(links[1].searchParams.get('api_key'), 'fixture');
});

test('LDA uses separate server-side OR filters, later pages, all relevant children and null/zero/negative amounts', async () => {
  const calls = [];
  const result = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', limit: 120 }, runtime(async (raw) => {
    const url = new URL(raw); if (url.hostname !== 'lda.gov') return empty(url); calls.push(url);
    assert.equal(url.searchParams.get('filing_year'), '2026');
    const filters = ['client_name', 'registrant_name', 'filing_specific_lobbying_issues', 'contribution_contributor', 'contribution_payee'].filter((f) => url.searchParams.has(f));
    assert.equal(filters.length, 1);
    if (url.pathname.includes('/contributions/')) return json({ results: [{ filing_uuid: 'child-filing', registrant: { name: 'Different' }, contribution_items: [
      { id: 1, contributor_name: 'Unrelated', payee_name: 'Other', amount: 100, date: '2026-02-01' },
      { id: 2, contributor_name: 'Acme', payee_name: 'Committee', amount: 0, date: '2026-02-01' },
      { id: 3, contributor_name: 'Acme', payee_name: 'Committee', amount: -10, date: '2026-02-01' }
    ] }], next: null });
    if (url.searchParams.get('page') === '1') {
      const next = new URL(url); next.searchParams.set('page', '2');
      return json({ results: [{ filing_uuid: 'unrelated', client: { name: 'Other' } }], next: next.toString() });
    }
    return json({ results: [{ filing_uuid: 'later-page', client: { name: 'Acme' }, registrant: { name: 'Lobbyist' }, income: null, expenses: '-25', dt_posted: '2026-02-01' }], next: null });
  }));
  assert.equal(result.items.filter((i) => i.type === 'Lobbying Filing').length, 1);
  assert.equal(result.items.find((i) => i.sourceId === 'later-page').amount, -25);
  const children = result.items.filter((i) => i.type === 'Lobbying Contribution');
  assert.deepEqual(children.map((i) => i.sourceId).sort(), ['child-filing:2', 'child-filing:3']);
  assert.deepEqual(children.map((i) => i.amount).sort((a, b) => a - b), [-10, 0]);
  assert.equal(result.summary.buckets.contributions.totalAmount, -10);
  assert.ok(children.find((i) => i.amount === 0).detailFields.some((f) => f.value === '$0'));
  assert.ok(children.every((i) => i.canonicalUrl.includes('/contribution/')));
});

test('LDA repeated pages and changed-query next links are partial, never silent success', async () => {
  for (const changed of [false, true]) {
    const acquired = await acquireMoneySources({ terms: ['Acme'], range: { ...range, years: [2026] }, runtime: runtime(async (raw) => {
      const url = new URL(raw); if (url.hostname !== 'lda.gov') return empty(url);
      const next = new URL(url); next.searchParams.set('page', String(Number(url.searchParams.get('page')) + 1));
      if (changed) next.searchParams.set('registrant_name', 'Changed');
      return json({ results: [{ filing_uuid: 'same' }], next: next.toString() });
    }) });
    assert.equal(acquired.lda.coverage.complete, false);
    assert.ok(acquired.lda.coverage.reasons.includes(changed ? 'changed_query' : 'pagination_stalled'));
  }
});

test('FEC cycles and exact native cursor, with one retry of the same frozen request', async () => {
  assert.deepEqual(fecCycles('2023-10-01', '2026-11-03'), [2024, 2026]);
  const calls = []; let failed = false;
  const result = await acquireFec({ terms: ['Acme'], range, key: 'fixture', runtime: runtime(async (raw) => {
    const url = new URL(raw); calls.push(raw);
    assert.equal(url.searchParams.get('two_year_transaction_period'), '2026');
    assert.equal(url.searchParams.get('min_date'), range.startIso);
    assert.equal(url.searchParams.get('sort'), '-contribution_receipt_date');
    assert.equal(url.searchParams.has('page'), false);
    if (!failed) { failed = true; return json({}, 504); }
    if (url.searchParams.has('last_index')) {
      assert.equal(url.searchParams.get('last_index'), '4021200000000000001');
      assert.equal(url.searchParams.get('last_contribution_receipt_date'), '2026-02-01');
      return json({ results: [], pagination: { last_indexes: null } });
    }
    return json({ results: [{ sub_id: '4021200000000000001' }], pagination: { last_indexes: { last_index: '4021200000000000001', last_contribution_receipt_date: '2026-02-01' } } });
  }) });
  assert.equal(calls[0], calls[1]); assert.equal(result.coverage.complete, true);
  assert.ok(calls.some((u) => new URL(u).searchParams.has('contributor_employer')));
});

test('FEC exhaustion, nonretryable errors, missing/repeated cursors and explicit committee identities', async () => {
  for (const status of [504, 400, 403, 429]) {
    let calls = 0;
    const result = await acquireFec({ terms: ['Acme'], range, key: 'fixture', runtime: runtime(async () => { calls++; return json({}, status); }) });
    assert.equal(calls, status === 504 ? 4 : status === 400 ? 2 : 1);
    assert.equal(result.coverage.status, 'unavailable'); assert.match(result.error, new RegExp(String(status)));
  }
  const urls = [];
  const pac = await acquireFec({ terms: ['C00000001'], range, key: 'fixture', runtime: runtime(async (raw) => { urls.push(new URL(raw)); return json({ results: [], pagination: {} }); }) });
  assert.equal(pac.coverage.complete, true);
  assert.ok(urls.some((u) => u.searchParams.get('contributor_id') === 'C00000001'));
  assert.ok(urls.some((u) => u.searchParams.get('committee_id') === 'C00000001'));
  const stalled = await acquireFec({ terms: ['Acme'], range, key: 'fixture', runtime: runtime(async () => json({ results: [{ sub_id: '1' }], pagination: { last_indexes: { last_index: '1', last_contribution_receipt_date: '2026-01-01' } } })) });
  assert.ok(stalled.coverage.reasons.includes('pagination_stalled'));
});

test('Employer match retains actual donor, committee IDs and receipt zero; missing amounts stay null', async () => {
  const data = await fetchMoneyFlows({ query: 'Acme', start: '2025-01-01', end: '2025-12-31' }, runtime(async (raw) => {
    const url = new URL(raw); if (url.hostname !== 'api.open.fec.gov') return empty(url);
    if (url.searchParams.has('last_index')) return json({ results: [], pagination: {} });
    return json({ results: [
      { sub_id: 'zero', contributor_name: 'Jane Doe', contributor_employer: 'Acme', committee: { name: 'Recipient PAC', committee_id: 'C00000001' }, contribution_receipt_amount: 0, contribution_receipt_date: '2025-02-01' },
      { sub_id: 'unknown', contributor_name: 'Acme', contribution_receipt_amount: '', contribution_receipt_date: '2025-02-01' }
    ], pagination: { last_indexes: { last_index: 'unknown', last_contribution_receipt_date: '2025-02-01' } } });
  }));
  const zero = data.items.find((i) => i.sourceId === 'zero');
  assert.equal(zero.amount, 0); assert.equal(zero.donor, 'Jane Doe'); assert.equal(zero.matchRole, 'reported_employer');
  assert.equal(zero.committeeId, 'C00000001'); assert.equal(zero.employer, 'Acme');
  assert.equal(new URL(zero.canonicalUrl).searchParams.get('two_year_transaction_period'), '2026');
  assert.equal(data.items.find((i) => i.sourceId === 'unknown').amount, null);
  assert.equal(data.summary.buckets.contributions.totalAmount, 0);
  assert.equal(data.summary.buckets.contributions.unknownAmountCount, 1);
});

test('USAspending modification collisions, pagination, deobligations and missing amounts survive normalization', async () => {
  const base = { 'Award ID': 'A1', generated_internal_id: 'CONT_AWD_A1', 'Recipient Name': 'Acme', 'Recipient UEI': 'UEI123', 'Action Date': '2026-01-03', 'Transaction Description': 'Same award' };
  assert.notEqual(buildUsaspendingTransactionKey({ ...base, Mod: '0' }), buildUsaspendingTransactionKey({ ...base, Mod: '1' }));
  assert.notEqual(buildUsaspendingTransactionKey({ ...base, 'Transaction Amount': null }), buildUsaspendingTransactionKey({ ...base, 'Transaction Amount': 0 }));
  const data = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', limit: 120 }, runtime(async (raw, init) => {
    const url = new URL(raw); if (url.hostname !== 'api.usaspending.gov') return empty(url);
    const body = JSON.parse(init.body); assert.ok(body.fields.includes('Mod')); assert.ok(body.fields.includes('Recipient UEI'));
    if (body.page === 1) return json({ results: [{ ...base, Mod: '0', 'Transaction Amount': 0 }, { ...base, Mod: '1', 'Transaction Amount': -200 }], page_metadata: { hasNext: true, next: 2 } });
    return json({ results: [{ ...base, Mod: '2', 'Transaction Amount': null }], page_metadata: { hasNext: false, next: null } });
  }));
  assert.equal(data.items.length, 3); assert.equal(new Set(data.items.map((i) => i.sourceId)).size, 3);
  assert.ok(data.items.every((i) => i.type === 'Federal Transaction' && i.canonicalUrl.endsWith('/CONT_AWD_A1') && i.recipientUei === 'UEI123'));
  assert.equal(data.summary.buckets.spending.totalAmount, -200);
  assert.equal(data.summary.buckets.spending.unknownAmountCount, 1);
  assert.equal(data.summary.basis, 'returned_rows_only');
});

test('Partial pages preserve successful rows and never become complete or zero activity', async () => {
  let count = 0;
  const result = await acquireUsa({ terms: ['Acme'], range, runtime: runtime(async () => {
    count++; if (count === 2) return json({}, 504);
    return json({ results: [{ 'Award ID': 'A1', Mod: '1' }], page_metadata: { hasNext: true, next: 2 } });
  }) });
  assert.equal(result.items.length, 1); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.status, 'partial');
  assert.equal(result.error, 'HTTP 504');
});

test('Audit distinguishes failed, partial and contract-invalid money sources without claiming completeness', async () => {
  const data = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03' }, runtime(async (raw) => empty(new URL(raw))));
  const missingSam = inspectMoneyFlows({ ok: true, data });
  assert.ok(missingSam.alerts.some((a) => a.regressionClass === 'money-flow-source-unavailable'));
  data.sources.sam = { count: 0, coverage: { status: 'partial', complete: false, reasons: ['page_budget'] } };
  assert.equal(inspectMoneyFlows({ ok: true, data }).status, 'ok');
  data.items.push({ source: 'SAM.gov', sourceId: 'bad', amount: 500, bucket: 'spending' });
  assert.ok(inspectMoneyFlows({ ok: true, data }).alerts.some((a) => a.regressionClass === 'money-flow-registration-as-money'));
  assert.equal(inspectMoneyFlows({ ok: false }).status, 'degraded');
  let calls = 0;
  await auditMoneyFlows({ mcp: 'https://example.test/mcp' }, async (endpoint, name, args, timeout, options) => {
    calls++; assert.equal(name, 'money.flows'); assert.equal(args.limit, 10); assert.equal(options.retry, false); return { ok: true, data };
  });
  assert.equal(calls, 1);
});

test('FEC null-sort cursors, malformed cursors, quota metadata and global budgets remain explicit', async () => {
  const urls = [];
  const nulled = await acquireFec({ terms: ['Acme'], range, key: 'fixture', runtime: runtime(async (raw) => {
    const url = new URL(raw); urls.push(url);
    if (url.searchParams.has('last_index')) return json({ results: [], pagination: {} });
    return json({ results: [{ sub_id: '1' }], pagination: { last_indexes: { last_index: '1', last_contribution_receipt_date: null } } });
  }) });
  assert.equal(nulled.coverage.complete, true);
  assert.ok(urls.some((u) => u.searchParams.get('sort_null_only') === 'true' && !u.searchParams.has('last_contribution_receipt_date')));
  const missing = await acquireFec({ terms: ['Acme'], range, runtime: runtime(async () => json({ results: [{ sub_id: '1' }], pagination: {} })) });
  assert.equal(missing.error, 'missing_cursor'); assert.equal(missing.coverage.complete, false);
  let calls = 0;
  const budgeted = await acquireFec({ terms: ['Acme', 'Other'], range, runtime: runtime(async () => { calls++; return json({}, 504); }, { requests: 1 }) });
  assert.equal(calls, 1); assert.equal(budgeted.coverage.complete, false);
  const quota = await acquireSam({ terms: ['Acme'], key: 'fixture', runtime: runtime(async () => new Response('{}', { status: 429, headers: { 'retry-after': '0' } })) });
  assert.equal(quota.retryAfterSeconds, 0); assert.ok(quota.retryAt); assert.equal(quota.error, 'HTTP 429');
});

test('The normal full audit includes exactly one money-flow acquisition and persists its coverage in the report', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runMonitor } = await import('../../analysis/monitor/lib/run.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'tsr-money-audit-'));
  let moneyCalls = 0;
  const money = { schemaVersion: 2, items: [], coverage: { status: 'discovery_sample', complete: false }, summary: { basis: 'returned_rows_only' }, sources: Object.fromEntries(['sam', 'fec', 'usaspending', 'lda', 'ldaContributions'].map((name) => [name, { count: 0, coverage: { status: 'partial', complete: false, reasons: ['page_budget'] } }])) };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/mcp')) {
      const request = JSON.parse(init.body);
      const name = request.params.name;
      if (name === 'money.flows') moneyCalls++;
      return json({ jsonrpc: '2.0', id: request.id, result: { content: [], structuredContent: name === 'money.flows' ? money : name === 'signals.list' ? { items: [] } : { body: '{}', contentType: 'application/json', httpStatus: 200 } } });
    }
    return json({ body: '{}', contentType: 'application/json', httpStatus: 200 });
  });
  try {
    const report = await runMonitor('full', ['--base', 'https://fixture.test', '--mcp', 'https://fixture.test/mcp', '--no-docs', '--no-static', '--no-write', '--output-dir', directory, '--baseline-dir', directory]);
    assert.equal(moneyCalls, 1);
    assert.equal(report.moneyFlowResult.coverage.complete, false);
    assert.ok(report.alerts.some((a) => a.feedId === 'money-flows' && a.regressionClass === 'money-flow-partial-coverage'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
