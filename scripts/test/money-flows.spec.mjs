import './fec-continuation.spec.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchMoneyFlows, buildUsaspendingTransactionKey } from '../../gcp/mcp-proxy/money-flows.js';
import { acquireFec, acquireSam, acquireUsa, acquireMoneySources, acquireLdaPage, fecCycles, MONEY_BUDGET } from '../../gcp/mcp-proxy/money-sources.js';
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

test('LD-203 diagnostics distinguish next-page, duplicate-identity and empty-page guards without exposing input', async () => {
  for (const branch of ['nonadvancing_next_page', 'no_new_identities', 'empty_page_with_next', 'changed_query']) {
    let calls = 0;
    const data = await acquireMoneySources({ terms: ['private-entity'], range: { ...range, years: [2026] }, runtime: runtime(async raw => {
      const url = new URL(raw);
      if (!url.pathname.includes('/contributions/') || !url.searchParams.has('contribution_payee')) return empty(url);
      calls++;
      const next = new URL(url), page = Number(url.searchParams.get('page'));
      next.searchParams.set('page', String(branch === 'nonadvancing_next_page' ? page : page + 1));
      if (branch === 'changed_query') next.searchParams.set('contribution_payee', 'private-replacement');
      return json({ results: branch === 'empty_page_with_next' ? [] : [{ filing_uuid: 'private-identity', secret: 'private-body' }], next: next.toString() });
    }) });
    const source = data.ldaContributions;
    assert.equal(source.coverage.status, 'partial');
    assert.equal(source.coverage.complete, false);
    assert.equal(source.error, branch === 'changed_query' ? 'changed_query' : 'pagination_stalled');
    assert.equal(calls, branch === 'no_new_identities' ? 2 : 1);
    const event = source.coverage.diagnostics.attempts.find(row => row.branch === branch);
    assert.equal(event.filter, 'contribution_payee');
    assert.equal(event.year, 2026);
    assert.equal(event.pageKind, 'numbered');
    assert.equal(event.page, calls);
    assert.equal(event.httpStatus, 200);
    assert.equal(event.attempted, true);
    assert.match(event.identityHash, /^[a-f0-9]{64}$/);
    if (branch === 'no_new_identities') assert.equal(event.newIdentityCount, 0);
    if (branch === 'empty_page_with_next') assert.equal(event.rowCount, 0);
    assert.doesNotMatch(JSON.stringify(source.coverage.diagnostics), /private-|https?:|filing_uuid|nextLink/);
  }
});

test('LDA page diagnostics identify repeated fingerprints without advancing the existing cursor', async () => {
  const args = { terms: ['private-term'], range, binding: 'private-binding' };
  let calls = 0;
  const options = runtime(async raw => {
    calls++;
    const next = new URL(raw); next.searchParams.set('page', String(Number(next.searchParams.get('page')) + 1));
    return json({ results: [{ filing_uuid: 'private-filing' }], next: next.toString() });
  });
  const first = await acquireLdaPage({ ...args, runtime: options });
  const second = await acquireLdaPage({ ...args, cursor: first.traversal.cursor, runtime: options });
  assert.equal(calls, 2);
  assert.equal(second.error, 'pagination_stalled');
  assert.equal(second.traversal.page, 2);
  assert.equal(JSON.parse(Buffer.from(second.traversal.cursor, 'base64url')).page, 2);
  const [event] = second.coverage.diagnostics.attempts;
  assert.equal(event.branch, 'repeated_page_fingerprint');
  assert.equal(event.filter, 'client_name');
  assert.equal(event.page, 2);
  assert.equal(event.rowCount, 1);
  assert.equal(event.newIdentityCount, null);
  assert.match(event.identityHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(second.coverage.diagnostics), /private-|https?:|filing_uuid/);
});

test('FEC diagnostics distinguish repeated-cursor guards from unchanged native cursors', async () => {
  for (const branch of ['repeated_cursor', 'nonadvancing_native_cursor']) {
    let calls = 0;
    const result = await acquireFec({ terms: ['private-term'], range, key: 'private-key', runtime: runtime(async raw => {
      const url = new URL(raw);
      if (url.searchParams.has('contributor_employer')) return empty(url);
      calls++;
      const current = url.searchParams.get('last_index');
      const following = branch === 'nonadvancing_native_cursor' ? 'private-A' : current === 'private-A' ? 'private-B' : 'private-A';
      return json({ results: [{ sub_id: `private-receipt-${calls}` }], pagination: { last_indexes: { last_index: following, last_contribution_receipt_date: '2026-01-01' } } });
    }, { pages: 8 }) });
    assert.equal(result.error, 'pagination_stalled');
    assert.equal(result.coverage.status, 'partial');
    assert.equal(calls, branch === 'repeated_cursor' ? 3 : 2);
    const event = result.coverage.diagnostics.attempts.find(row => row.branch === branch);
    assert.equal(event.filter, 'contributor_name');
    assert.equal(event.pageKind, 'ordinal');
    assert.equal(event.page, branch === 'repeated_cursor' ? 4 : 2);
    assert.equal(event.attempted, branch !== 'repeated_cursor');
    assert.equal(event.httpStatus, branch === 'repeated_cursor' ? null : 200);
    assert.doesNotMatch(JSON.stringify(result.coverage.diagnostics), /private-|https?:|last_index|api_key/);
  }
});

test('FEC deadline evidence remains local partial coverage and does not acquire another page', async () => {
  let now = 0, calls = 0;
  const result = await acquireFec({ terms: ['private-term'], range, key: 'private-key', runtime: {
    ...runtime(async () => { calls++; now = 45000; return json({ results: [{ sub_id: 'private-id' }], pagination: { last_indexes: { last_index: 'private-cursor', last_contribution_receipt_date: '2026-01-01' } } }); }), now: () => now
  } });
  assert.deepEqual(MONEY_BUDGET, { requests: 12, pages: 3, deadlineMs: 45000, timeoutMs: 15000 });
  assert.equal(calls, 1);
  assert.equal(result.error, null);
  assert.equal(result.coverage.status, 'partial');
  assert.deepEqual(result.coverage.reasons, ['deadline']);
  const stopped = result.coverage.diagnostics.attempts.filter(row => row.branch === 'deadline');
  assert.ok(stopped.length);
  assert.ok(stopped.every(row => !row.attempted && row.httpStatus === null && row.elapsedMs === 45000 && row.remainingMs === 0 && row.budgetMs === 45000));
});

test('Transport diagnostics preserve safe categories and unknown HTTP status without retrying USAspending', async () => {
  for (const [name, category] of [['TimeoutError', 'timeout'], ['AbortError', 'aborted'], ['TypeError', 'transport'], ['private-error-name', 'unknown'], ['constructor', 'unknown']]) {
    let calls = 0;
    const result = await acquireUsa({ terms: ['private-term'], range, runtime: runtime(async () => {
      calls++; const error = new Error('private-message https://secret.invalid/?api_key=private-key'); error.name = name; throw error;
    }) });
    assert.equal(calls, 1);
    assert.equal(result.error, 'fetch_failed');
    assert.equal(result.coverage.status, 'unavailable');
    const [event] = result.coverage.diagnostics.attempts;
    assert.equal(event.branch, 'fetch_exception');
    assert.equal(event.exceptionCategory, category);
    assert.equal(event.httpStatus, null);
    assert.equal(event.identityHash, null);
    assert.equal(event.rowCount, null);
    assert.doesNotMatch(JSON.stringify(result.coverage.diagnostics), /private-|https?:|api_key/);
  }
  const invalid = await acquireUsa({ terms: ['private-term'], range, runtime: runtime(async () => new Response('private-invalid-body', { status: 200 })) });
  assert.equal(invalid.error, 'invalid_json');
  assert.equal(invalid.coverage.diagnostics.attempts[0].branch, 'decode_exception');
  assert.equal(invalid.coverage.diagnostics.attempts[0].exceptionCategory, 'invalid_json');
  assert.equal(invalid.coverage.diagnostics.attempts[0].httpStatus, 200);
});

test('Diagnostic status and retry evidence preserve access failures, missing observations and known zero', async () => {
  const denied = await acquireSam({ terms: ['private-name', 'private-other'], key: 'private-key', runtime: runtime(async () => json({ private: 'body' }, 403)) });
  assert.equal(denied.coverage.requests, 1);
  assert.equal(denied.error, 'HTTP 403');
  assert.equal(denied.coverage.diagnostics.attempts[0].httpStatus, 403);
  assert.equal(denied.coverage.diagnostics.attempts[0].branch, 'http_error');
  assert.equal(denied.coverage.diagnostics.attempts[1].branch, 'provider_blocked');
  const absent = await acquireSam({ terms: ['private-name'], key: '', runtime: runtime(async () => assert.fail('Missing key must not acquire')) });
  assert.equal(absent.coverage.status, 'unavailable');
  assert.deepEqual(absent.coverage.diagnostics, { attempts: [], omitted: 0 });
  const zero = await acquireUsa({ terms: ['private-name'], range, runtime: runtime(async raw => empty(new URL(raw))) });
  assert.equal(zero.coverage.complete, true);
  assert.equal(zero.coverage.diagnostics.attempts[0].rowCount, 0);
  assert.equal(zero.coverage.diagnostics.attempts[0].newIdentityCount, 0);
  assert.equal(zero.coverage.diagnostics.attempts[0].httpStatus, 200);
  let calls = 0; const urls = [];
  const retried = await acquireFec({ terms: ['private-name'], range, key: 'private-key', runtime: runtime(async raw => { calls++; urls.push(raw); return calls === 1 ? json({}, 504) : empty(new URL(raw)); }) });
  assert.equal(urls[0], urls[1]);
  assert.deepEqual(retried.coverage.diagnostics.attempts.slice(0, 2).map(row => [row.request, row.attempt, row.httpStatus, row.branch]), [[1, 1, 504, 'http_error'], [2, 2, 200, 'response_ok']]);
});

test('Bounded diagnostic retention never limits LDA acquisition and source snapshots remain separate', async () => {
  const result = await acquireMoneySources({ terms: ['private-name'], range: { ...range, years: [2026] }, runtime: {
    ...runtime(async raw => {
      const url = new URL(raw), page = Number(url.searchParams.get('page'));
      if (!url.searchParams.has('client_name')) return empty(url);
      const next = new URL(url); next.searchParams.set('page', String(page + 1));
      return json({ results: [{ filing_uuid: `private-${page}` }], next: page < 40 ? next.toString() : null });
    }), now: () => 0
  } });
  assert.equal(result.lda.coverage.complete, true);
  assert.equal(result.lda.coverage.requests, 42);
  assert.equal(result.lda.items.length, 40);
  assert.equal(result.lda.coverage.diagnostics.attempts.length, 32);
  assert.equal(result.lda.coverage.diagnostics.omitted, 10);
  assert.equal(result.ldaContributions.coverage.diagnostics.attempts.length, 3);
  assert.equal(result.ldaContributions.coverage.diagnostics.omitted, 0);
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
  const money = { query: 'CVS Health', range: { start: '2026-01-01', end: '2026-11-04' }, ldaTraversal: { startsFromBeginning: true, next: { mode: 'lda_pages', cursor: 'fixture', query: 'CVS Health', start: '2026-01-01', end: '2026-11-04' } }, schemaVersion: 2, items: [], coverage: { status: 'discovery_sample', complete: false }, summary: { basis: 'returned_rows_only' }, sources: Object.fromEntries(['sam', 'fec', 'usaspending', 'lda', 'ldaContributions'].map((name) => [name, { count: 0, coverage: { status: 'partial', complete: false, reasons: ['page_budget'] } }])) };
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

test('The LDA sample deadline leaves unattempted LD-203 searches as incomplete coverage, not provider failures', async (t) => {
  for (const exhausted of ['deadline']) {
    await t.test(exhausted, async () => {
      let now = 0;
      const ldaCalls = [];
      const options = runtime(async (raw) => {
        const url = new URL(raw);
        if (url.hostname === 'lda.gov') {
          ldaCalls.push(url.pathname);
          if (exhausted === 'deadline' && ldaCalls.length === 3) now = 45000;
        }
        return empty(url);
      }, exhausted === 'requests' ? { requests: 3 } : {});
      options.now = () => now;
      const data = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03' }, options);
      assert.deepEqual(ldaCalls, Array(3).fill('/api/v1/filings/'));
      const source = data.sources.ldaContributions;
      assert.equal(source.error, null);
      assert.equal(source.count, 0);
      assert.equal(source.coverage.requests, 0);
      assert.equal(source.coverage.searchesRun, 0);
      assert.equal(source.coverage.searchesPlanned, 3);
      assert.equal(source.coverage.pages, 0);
      assert.deepEqual(source.coverage.reasons, ['deadline']);
      assert.equal(source.coverage.complete, false);
      assert.equal(source.coverage.status, 'partial');
      const alerts = inspectMoneyFlows({ ok: true, data }).alerts.filter((alert) => alert.metadata.identity === 'ldaContributions');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].regressionClass, 'money-flow-partial-coverage');
      assert.equal(alerts[0].severity, 'info');
    });
  }
});

test('An inherited LDA access error remains a provider warning even when LD-203 makes zero requests', async () => {
  const data = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03' }, runtime(async (raw) => {
    const url = new URL(raw);
    return url.hostname === 'lda.gov' ? json({}, 403) : empty(url);
  }));
  const source = data.sources.ldaContributions;
  assert.equal(source.coverage.requests, 0);
  assert.equal(source.coverage.complete, false);
  assert.equal(source.coverage.status, 'unavailable');
  assert.equal(source.error, 'HTTP 403');
  const alerts = inspectMoneyFlows({ ok: true, data }).alerts.filter((alert) => alert.metadata.identity === 'ldaContributions');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].regressionClass, 'money-flow-source-unavailable');
  assert.equal(alerts[0].severity, 'warning');
});

test('LDA has no artificial request/page cap; five aliases over two years reach both endpoints', async () => {
  const calls = [];
  const data = await fetchMoneyFlows({ query: 'Strategic Education', start: '2025-01-01', end: '2026-11-03' }, runtime(async (raw) => {
    const url = new URL(raw); if (url.hostname !== 'lda.gov') return empty(url);
    calls.push(url); assert.equal(url.searchParams.get('page_size'), '25');
    const page = Number(url.searchParams.get('page'));
    const next = new URL(url); next.searchParams.set('page', String(page + 1));
    return json({ results: [{ filing_uuid: `${url.pathname}:${url.searchParams.get('filing_year')}:${page}` }], next: page < 5 ? next.toString() : null });
  }, { requests: 1, pages: 1 }));
  assert.equal(data.aliasExpansion.expandedTo.length, 5);
  assert.equal(calls.length, 300); // 5 aliases * 2 years * 6 filters * 5 pages.
  assert.equal(data.sources.lda.coverage.requests, 150);
  assert.equal(data.sources.ldaContributions.coverage.requests, 150);
  assert.equal(data.sources.lda.coverage.complete, true);
  assert.equal(data.sources.ldaContributions.coverage.complete, true);
});

test('Resumable LDA traversal reaches every alias/year/filter/page, without other providers or output loss', async () => {
  let args = { query: 'Strategic Education', start: '2025-01-01', end: '2026-11-03', mode: 'lda_pages', limit: 1 };
  const calls = [], seen = new Set(); let last;
  const options = runtime(async (raw) => {
    const url = new URL(raw); assert.equal(url.hostname, 'lda.gov'); calls.push(raw);
    const page = Number(url.searchParams.get('page'));
    const term = [...url.searchParams].find(([key]) => ['client_name', 'registrant_name', 'filing_specific_lobbying_issues', 'contribution_contributor', 'contribution_payee'].includes(key))[1];
    const year = url.searchParams.get('filing_year');
    const id = `${year}:${term}:${page}`;
    const next = new URL(url); next.searchParams.set('page', String(page + 1));
    const contributions = url.pathname.includes('contributions');
    return json({ results: contributions ? [{ filing_uuid: `child:${id}`, registrant: { name: term }, contribution_items: [
      { id: 1, contributor_name: term, amount: 0, date: `${year}-02-01` },
      { id: 2, contributor_name: term, amount: -5, date: `${year}-02-01` },
      { id: 3, contributor_name: term, amount: null, date: `${year}-02-01` }
    ] }] : [1, 2].map((n) => ({ filing_uuid: `filing:${id}:${n}`, client: { name: term }, income: n })), next: page < 5 ? next.toString() : null });
  }, { requests: 1, pages: 1 });
  while (args) {
    assert.ok(calls.length < 301, 'Traversal must terminate');
    last = await fetchMoneyFlows({ ...args, limit: 1 }, options);
    assert.equal(last.coverage.status, 'lda_page');
    assert.equal(last.coverage.outputTruncated, false);
    assert.ok(last.items.length >= 2, 'limit=1 must not drop page rows/children');
    for (const item of last.items) seen.add(item.sourceId);
    args = last.ldaTraversal.next;
  }
  assert.equal(calls.length, 300);
  assert.equal(new Set(calls).size, 300, 'No page may be skipped or repeated within a search');
  assert.equal(seen.size, 250); // 10 term-years * 5 pages * (2 filings + 3 children), dedup OR searches.
  assert.equal(last.ldaTraversal.searchesCompleted, 60);
  assert.equal(last.ldaTraversal.complete, true);
  assert.equal(last.coverage.complete, true);
  assert.ok(calls[5].includes('/contributions/'), 'LD-203 interleaves with filings');
});

test('Aggregate offers an explicit replay traversal, while page mode removes alias/output truncation', async () => {
  const entities = Array.from({ length: 9 }, (_, i) => `Acme ${i}`);
  const options = runtime(async (raw) => empty(new URL(raw)));
  const sample = await fetchMoneyFlows({ query: 'Acme', entities, start: '2026-01-01', end: '2026-11-03', limit: 1 }, options);
  assert.equal(sample.coverage.queryVariantsTruncated, true);
  assert.equal(sample.ldaTraversal.startsFromBeginning, true);
  let args = JSON.parse(JSON.stringify(sample.ldaTraversal.next));
  let pages = 0, data;
  while (args) {
    data = await fetchMoneyFlows(args, options);
    assert.equal(data.coverage.queryVariantsTruncated, false);
    args = data.ldaTraversal.next; pages++;
  }
  assert.equal(pages, 54);
  assert.equal(data.ldaTraversal.complete, true);
});

test('LDA cursors freeze query/window/matching, reject malformed state before fetching, and contain no URL', async () => {
  let calls = 0;
  const options = runtime(async (raw) => { calls++; return empty(new URL(raw)); });
  const first = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', mode: 'lda_pages' }, options);
  const next = first.ldaTraversal.next;
  const decoded = Buffer.from(next.cursor, 'base64url').toString();
  assert.doesNotMatch(decoded, /https|api_key|token/i);
  for (const changes of [{ query: 'Other' }, { end: '2026-11-04' }, { entities: ['Different'] }, { matchMode: 'strict' }, { cursor: 'invalid' },
    { cursor: Buffer.from(JSON.stringify({ ...JSON.parse(decoded), page: -1 })).toString('base64url') },
    { cursor: Buffer.from(JSON.stringify({ ...JSON.parse(decoded), search: 999 })).toString('base64url') }]) {
    const bad = await fetchMoneyFlows({ ...next, ...changes }, options);
    assert.equal(bad.error, 'invalid_cursor');
  }
  assert.equal(calls, 1);
  const valid = await fetchMoneyFlows(next, options);
  assert.equal(valid.ldaTraversal.endpoint, 'contributions');
  assert.equal(calls, 2);
  const httpStyle = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', mode: 'lda_pages', minScore: '60', matchMode: null }, options);
  assert.equal(httpStyle.ldaTraversal.next.minScore, 60);
  assert.equal(httpStyle.ldaTraversal.next.matchMode, 'normal');
  assert.equal((await fetchMoneyFlows(httpStyle.ldaTraversal.next, options)).error, undefined);
});

test('LDA failed pages resume the same frozen request; Retry-After prevents early requests', async () => {
  let now = 0, failed = false;
  const calls = [];
  const options = { ...runtime(async (raw) => {
    calls.push(raw);
    if (!failed) { failed = true; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }); }
    return empty(new URL(raw));
  }), now: () => now };
  const first = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', mode: 'lda_pages' }, options);
  assert.equal(first.sources.lda.error, 'HTTP 429');
  assert.equal(first.sources.lda.retryAfterSeconds, 60);
  assert.equal(first.ldaTraversal.complete, false);
  const early = await fetchMoneyFlows(first.ldaTraversal.next, options);
  assert.equal(calls.length, 1);
  assert.deepEqual(early.sources.lda.coverage.reasons, ['deadline']);
  assert.equal(early.sources.lda.error, null);
  now = 60000;
  const resumed = await fetchMoneyFlows(early.ldaTraversal.next, options);
  assert.equal(calls[0], calls[1]);
  assert.equal(resumed.ldaTraversal.searchesCompleted, 1);
});

test('LDA continuation detects repeated pages and query drift without falsely completing or advancing', async () => {
  for (const changed of [false, true]) {
    const options = runtime(async (raw) => {
      const url = new URL(raw), next = new URL(raw);
      next.searchParams.set('page', String(Number(url.searchParams.get('page')) + 1));
      if (changed && url.searchParams.get('page') === '2') next.searchParams.set('client_name', 'Other');
      return json({ results: [{ filing_uuid: changed ? url.searchParams.get('page') : 'same', client: { name: 'Acme' } }], next: next.toString() });
    });
    const first = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03', mode: 'lda_pages' }, options);
    const second = await fetchMoneyFlows(first.ldaTraversal.next, options);
    assert.equal(second.sources.lda.error, changed ? 'changed_query' : 'pagination_stalled');
    assert.equal(second.ldaTraversal.complete, false);
    assert.equal(second.ldaTraversal.searchesCompleted, 0);
    assert.equal(JSON.parse(Buffer.from(second.ldaTraversal.next.cursor, 'base64url')).page, 2);
  }
});

test('Anonymous pacing persists across LDA continuations and the sample deadline is a response bound', async () => {
  let now = 0;
  const times = [];
  const options = { fetch: async (raw) => {
    const url = new URL(raw);
    if (url.hostname === 'lda.gov') times.push(now);
    return empty(url);
  }, now: () => now, sleep: async (ms) => { now += ms; }, enforcePacing: true };
  const sample = await fetchMoneyFlows({ query: 'Strategic Education', start: '2025-01-01', end: '2026-11-03' }, options);
  assert.equal(times.length, 11); // Twelfth start would be 45.1s, past caller's 45s response slice.
  assert.equal(sample.sources.ldaContributions.coverage.requests, 0);
  assert.equal(sample.sources.ldaContributions.error, null);
  assert.equal(sample.sources.ldaContributions.coverage.status, 'partial');
  assert.equal(sample.ldaTraversal.startsFromBeginning, true);
  let next = sample.ldaTraversal.next;
  for (let i = 0; i < 60; i++) {
    const data = await fetchMoneyFlows(next, options);
    assert.equal(data.ldaTraversal.searchesCompleted, i + 1);
    next = data.ldaTraversal.next;
  }
  assert.equal(next, null);
  assert.equal(times.length, 71);
  assert.ok(times.slice(1).every((time, i) => time - times[i] >= 4100));
});

test('A full LD-203 page keeps more than 120 matching children and retries transient failures without skipping', async () => {
  let failed = false;
  const args = { query: 'Acme', start: '2026-01-01', end: '2026-11-03', mode: 'lda_pages', limit: 1 };
  const options = runtime(async (raw) => {
    const url = new URL(raw);
    if (url.pathname.includes('/filings/')) return empty(url);
    if (!failed) { failed = true; return json({}, 504); }
    return json({ results: [{ filing_uuid: 'many', registrant: { name: 'Acme' }, contribution_items: Array.from({ length: 201 }, (_, id) => ({ id, contributor_name: 'Acme', amount: id === 0 ? null : -id, date: '2026-02-01' })) }], next: null });
  });
  const first = await fetchMoneyFlows(args, options);
  const failedPage = await fetchMoneyFlows(first.ldaTraversal.next, options);
  assert.equal(failedPage.sources.ldaContributions.error, 'HTTP 504');
  assert.equal(failedPage.ldaTraversal.searchesCompleted, 1);
  const resumed = await fetchMoneyFlows({ ...failedPage.ldaTraversal.next, limit: 1 }, options);
  assert.equal(resumed.items.length, 201);
  assert.equal(resumed.coverage.outputTruncated, false);
  assert.equal(resumed.summary.buckets.contributions.unknownAmountCount, 1);
  assert.equal(resumed.ldaTraversal.searchesCompleted, 2);
});

test('Normal audit catches a lost LDA traversal entrypoint without issuing any extra provider requests', async () => {
  const data = await fetchMoneyFlows({ query: 'Acme', start: '2026-01-01', end: '2026-11-03' }, runtime(async (raw) => empty(new URL(raw))));
  assert.ok(!inspectMoneyFlows({ ok: true, data }).alerts.some((a) => a.regressionClass === 'money-flow-lda-continuation'));
  delete data.ldaTraversal;
  assert.ok(inspectMoneyFlows({ ok: true, data }).alerts.some((a) => a.regressionClass === 'money-flow-lda-continuation'));
});

test('LDA historical traversal spans 1999–2026, resumes a failed older page, and reaches every year', async () => {
  let args = { query: 'Acme', start: '1999-01-01', end: '2026-11-03', mode: 'lda_pages', limit: 1 };
  const calls = [], seen = new Set(); let failed = false, failedUrl, last;
  const options = runtime(async (raw) => {
    const url = new URL(raw); assert.equal(url.hostname, 'lda.gov'); calls.push(raw);
    const year = url.searchParams.get('filing_year'), page = url.searchParams.get('page');
    const contribution = url.pathname.includes('/contributions/');
    const id = `${contribution ? 'child' : 'filing'}:${year}:${page}`;
    if (year === '2008' && contribution && page === '2' && !failed) {
      failed = true; failedUrl = raw; return json({}, 504);
    }
    const next = new URL(url); next.searchParams.set('page', '2');
    return json({ results: contribution
      ? [{ filing_uuid: id, contribution_items: [{ id: 1, contributor_name: 'Acme', amount: -1, date: `${year}-02-01` }] }]
      : [{ filing_uuid: id, client: { name: 'Acme' }, income: 0 }], next: page === '1' ? next.toString() : null });
  });
  while (args) {
    assert.ok(calls.length < 338, 'Historical traversal must terminate');
    last = await fetchMoneyFlows(JSON.parse(JSON.stringify(args)), options);
    assert.equal(last.error, undefined);
    assert.deepEqual(last.range, { start: '1999-01-01', end: '2026-11-03' });
    if (last.sources.ldaContributions.error) {
      assert.equal(last.sources.ldaContributions.error, 'HTTP 504');
      assert.equal(last.ldaTraversal.complete, false);
      assert.equal(last.ldaTraversal.filingYear, 2008);
      assert.equal(last.ldaTraversal.page, 2);
    }
    for (const item of last.items) seen.add(item.sourceId);
    args = last.ldaTraversal.next;
  }
  assert.equal(calls.length, 337); // 28 years * 6 searches * 2 pages + one retry.
  assert.equal(new Set(calls).size, 336);
  const failedIndex = calls.indexOf(failedUrl);
  assert.equal(calls[failedIndex + 1], failedUrl);
  assert.deepEqual([...new Set(calls.map(raw => Number(new URL(raw).searchParams.get('filing_year'))))], Array.from({ length: 28 }, (_, i) => 1999 + i));
  assert.equal(seen.size, 112);
  assert.equal(last.ldaTraversal.searchesCompleted, 168);
  assert.equal(last.ldaTraversal.complete, true);
});

test('Long windows are accepted without historical clipping; invalid and reversed dates still make no requests', async () => {
  let calls = 0;
  const options = runtime(async (raw) => { calls++; return empty(new URL(raw)); });
  for (const mode of ['sample', 'lda_pages']) {
    for (const [start, end] of [['not-a-date', '2026-01-01'], ['2026-01-01', '1999-01-01']]) {
      assert.equal((await fetchMoneyFlows({ query: 'Acme', start, end, mode }, options)).error, 'invalid_range');
    }
  }
  assert.equal(calls, 0);
  const long = await fetchMoneyFlows({ query: 'Acme', start: '1999-01-01', end: '2026-11-03' }, options);
  assert.equal(long.error, undefined);
  assert.equal(long.ldaTraversal.next.start, '1999-01-01');
  assert.equal(long.ldaTraversal.next.end, '2026-11-03');
  assert.equal(long.coverage.complete, false);
  const page = await fetchMoneyFlows(long.ldaTraversal.next, options);
  assert.equal(page.ldaTraversal.filingYear, 1999);
  assert.equal(page.ldaTraversal.searchesPlanned, 168);
});

test('Historical LDA planning computes only the current search and retains provider errors at older years', async () => {
  const historical = { startIso: '1900-01-01', endIso: '2026-11-03', startYear: 1900, endYear: 2026,
    get years() { throw new Error('Page mode must not enumerate the historical year plan'); } };
  const terms = Array.from({ length: 15 }, (_, i) => `Acme ${i}`);
  let calls = 0;
  const result = await acquireLdaPage({ terms, range: historical, binding: 'fixture', runtime: runtime(async (raw) => {
    calls++; const url = new URL(raw);
    assert.equal(url.searchParams.get('filing_year'), '1900');
    assert.equal(url.searchParams.get('page_size'), '25');
    return empty(url);
  }) });
  assert.equal(calls, 1);
  assert.equal(result.traversal.searchesPlanned, 11430);
  assert.equal(result.traversal.searchesCompleted, 1);
  const failed = await fetchMoneyFlows({ query: 'Acme', start: '1900-01-01', end: '2026-11-03', mode: 'lda_pages' }, runtime(async () => json({}, 400)));
  assert.equal(failed.sources.lda.error, 'HTTP 400');
  assert.equal(failed.ldaTraversal.searchesCompleted, 0);
  assert.equal(failed.ldaTraversal.complete, false);
  assert.ok(failed.ldaTraversal.next.cursor);
});
