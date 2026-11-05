import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchMoneyFlows } from '../../gcp/mcp-proxy/money-flows.js';
import { acquireFecPages, startFecCursor, MONEY_BUDGET } from '../../gcp/mcp-proxy/money-sources.js';
const range = { startIso: '2025-01-01', endIso: '2026-11-03' };
const args = { query: 'Acme', entities: ['Acme'], start: range.startIso, end: range.endIso, mode: 'fec_pages', limit: 1 };
const sourceArgs = { terms: ['Acme'], range, binding: 'fixture-binding', key: 'private-test-key' };
const encode = state => Buffer.from(JSON.stringify(state)).toString('base64url');
const decode = cursor => JSON.parse(Buffer.from(cursor, 'base64url'));
const response = (results, indexes = null) => new Response(JSON.stringify({ results, pagination: { last_indexes: indexes } }), { headers: { 'Content-Type': 'application/json' } });
const indexes = (index, date = '2026-01-01') => ({ last_index: String(index), last_contribution_receipt_date: date });
const row = (id, amount = 1) => ({ sub_id: String(id), contributor_name: 'Acme', contributor_employer: 'Acme',
  committee: { name: 'Recipient', committee_id: 'C00000001' }, contribution_receipt_amount: amount, contribution_receipt_date: '2026-01-01',
  two_year_transaction_period: 2026, transaction_id: `transaction-${id}`, file_number: 123, original_sub_id: null });
const runtime = (fetch, budget = {}) => ({ fetch, sleep: async () => {}, budget });
function stream({ length = 8, calls = [] } = {}) {
  return async raw => {
    const u = new URL(raw); assert.equal(u.hostname, 'api.open.fec.gov');
    assert.equal(u.searchParams.get('per_page'), '100'); assert.equal(u.searchParams.get('sort'), '-contribution_receipt_date');
    const filter = u.searchParams.has('contributor_name') ? 'contributor_name' : 'contributor_employer';
    const cycle = u.searchParams.get('two_year_transaction_period');
    const n = Number(u.searchParams.get('last_index') || 0);
    calls.push({ filter, cycle, n, url: raw });
    if (n === length) return response([]);
    return response([row(`${cycle}${filter === 'contributor_name' ? '1' : '2'}${n + 1}`, n % 3 === 0 ? null : n % 3 === 1 ? 0 : -5)], indexes(n + 1));
  };
}

test('FEC serialized continuation crosses per-call pages/cycles/filters without sample slicing or a total cap', async () => {
  const calls = [], seen = new Set(); let request = { ...args }, last, batches = 0, returned = 0;
  const rt = runtime(stream({ calls, length: 11 }));
  while (request) {
    last = await fetchMoneyFlows(JSON.parse(JSON.stringify(request)), rt); batches++;
    assert.equal(last.error, undefined); assert.equal(last.coverage.outputTruncated, false);
    assert.ok(last.sources.fec.coverage.requests <= MONEY_BUDGET.requests);
    assert.ok(last.items.length > 0 || last.fecTraversal.complete);
    for (const item of last.items) { assert.equal(item.source, 'OpenFEC'); assert.match(item.observationHash, /^[a-f0-9]{64}$/); assert.ok(!seen.has(item.sourceId)); seen.add(item.sourceId); }
    returned += last.items.length; request = last.fecTraversal.next;
    assert.ok(batches < 100, 'fixture must terminate');
  }
  assert.equal(returned, 22); assert.equal(calls.length, 24); assert.equal(last.fecTraversal.complete, true);
  assert.equal(last.fecTraversal.searchesCompleted, 2); assert.equal(last.coverage.complete, true);
  assert.ok(batches > 3); assert.ok(calls.every(c => c.cycle === '2026'));
  // A longer explicit window adds another two-year cycle without changing per-call bounds.
  const wide = await acquireFecPages({ ...sourceArgs, range: { startIso: '2023-01-01', endIso: '2026-11-03' }, runtime: runtime(async raw => {
    const u = new URL(raw); calls.push({ cycle: u.searchParams.get('two_year_transaction_period') }); return response([]);
  }) });
  assert.equal(wide.traversal.searchesCompleted, 4); assert.deepEqual(wide.coverage.cycles, [2024, 2026]);
});

test('FEC continuation carries exact date/null keysets and recognizes only explicit empty terminal pages', async () => {
  for (const date of ['2026-01-01', null]) {
    let calls = 0; const rt = runtime(async raw => {
      const u = new URL(raw); calls++;
      if (!u.searchParams.has('last_index')) return response([row(1, 0)], indexes('1234567890123456789', date));
      assert.equal(u.searchParams.get('last_index'), '1234567890123456789');
      assert.equal(u.searchParams.get('last_contribution_receipt_date'), date);
      assert.equal(u.searchParams.get('sort_null_only'), date === null ? 'true' : null);
      return response([]);
    }, { pages: 1 });
    const first = await acquireFecPages({ ...sourceArgs, runtime: rt });
    assert.equal(first.traversal.complete, false); assert.deepEqual(first.coverage.reasons, ['page_budget']);
    const second = await acquireFecPages({ ...sourceArgs, cursor: first.traversal.cursor, runtime: rt });
    assert.equal(second.traversal.searchesCompleted, 1); assert.equal(second.items.length, 1);
    const third = await acquireFecPages({ ...sourceArgs, cursor: second.traversal.cursor, runtime: rt });
    assert.equal(third.traversal.complete, true); assert.equal(third.traversal.cursor, null); assert.equal(calls, 4);
  }
});

test('FEC malformed/binding/source/order cursor state is rejected before requests', async () => {
  let calls = 0; const rt = runtime(async () => { calls++; return response([row(1)], indexes(1)); }, { pages: 1 });
  const first = await fetchMoneyFlows(args, rt); const next = first.fecTraversal.next, state = decode(next.cursor);
  const cases = [{ query: 'Other' }, { entities: ['Other'] }, { start: '2024-01-01' }, { end: '2026-11-04' }, { matchMode: 'strict' }, { minScore: 99 }, { mode: 'lda_pages' }, { cursor: 'bad' }];
  for (const change of [{ version: 2 }, { search: -1 }, { search: 999 }, { page: 0 }, { notBefore: -1 }, { retryAt: 'tomorrow' },
    { indexes: { last_index: 'url:https://evil.test', sort_null_only: true } }, { indexes: { last_index: 9007199254740992, sort_null_only: true } },
    { indexes: { last_index: '1', last_contribution_receipt_date: 'not-a-date' } }, { indexes: { last_index: '1', sort_null_only: 'true' } },
    { indexes: { last_index: '1', sort_null_only: true, api_key: 'secret' } }, { indexes: [] }, { guard: { anchor: 'bad', power: 1, distance: 0 } },
    { halted: 'arbitrary-error' }, { unexpected: 1 }, { binding: 'changed-order-binding' }]) cases.push({ cursor: encode({ ...state, ...change }) });
  for (const change of cases) assert.equal((await fetchMoneyFlows({ ...next, ...change }, rt)).error, 'invalid_cursor', JSON.stringify(change));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(state), /api_key|private-test-key|https?:|Acme/);
});

test('FEC failed-page retry and serialized recovery keep the exact unfinished native seek request', async () => {
  let fail = true, requests = [];
  const rt = runtime(async raw => {
    requests.push(raw); const u = new URL(raw);
    if (!u.searchParams.has('last_index')) return response([row(1)], indexes(1));
    if (fail) return new Response('{}', { status: 504 });
    return response([]);
  });
  const first = await acquireFecPages({ ...sourceArgs, runtime: rt });
  assert.equal(first.items.length, 1); assert.equal(first.error, 'HTTP 504'); assert.equal(requests.length, 3);
  assert.equal(requests[1], requests[2]); const held = decode(first.traversal.cursor); assert.equal(held.indexes.last_index, '1');
  fail = false; requests = [];
  const second = await acquireFecPages({ ...sourceArgs, cursor: first.traversal.cursor, runtime: rt });
  assert.equal(new URL(requests[0]).searchParams.get('last_index'), '1'); assert.equal(second.traversal.complete, true);
});

test('FEC deadline before/during a page and between searches retains resumable state without an extra request', async () => {
  let calls = 0, now = 0;
  const before = await acquireFecPages({ ...sourceArgs, runtime: { ...runtime(async () => { calls++; return response([]); }, { deadlineMs: 0 }), now: () => now } });
  assert.equal(calls, 0); assert.equal(before.error, null); assert.equal(decode(before.traversal.cursor).search, 0);
  const during = await acquireFecPages({ ...sourceArgs, runtime: { ...runtime(async () => { calls++; now = 45002; throw new DOMException('fixture timeout', 'TimeoutError'); }), now: () => now,
    sleep: async ms => { now += ms; } } });
  assert.equal(calls, 1); assert.deepEqual(during.coverage.reasons, ['deadline']); assert.equal(now, 45502); assert.deepEqual(decode(during.traversal.cursor).indexes, {});
  now = 0; calls = 0;
  const between = await acquireFecPages({ ...sourceArgs, runtime: { ...runtime(async () => { calls++; now = 45000; return response([]); }), now: () => now } });
  assert.equal(calls, 1); assert.equal(between.traversal.searchesCompleted, 1); assert.equal(decode(between.traversal.cursor).search, 1);
  now = 0; calls = 0;
  const afterParsed = await acquireFecPages({ ...sourceArgs, runtime: { ...runtime(async () => { calls++; now = 45000; return response([row(5)], indexes(5)); }), now: () => now } });
  assert.equal(calls, 1); assert.equal(afterParsed.items.length, 1); assert.equal(decode(afterParsed.traversal.cursor).indexes.last_index, '5');
});

test('FEC Retry-After survives serialization without early requests and nonretryable access errors remain explicit', async () => {
  let now = Date.parse('2026-11-04T12:00:00Z'), calls = 0;
  const rt = { ...runtime(async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '120' } }); }), now: () => now };
  const first = await acquireFecPages({ ...sourceArgs, runtime: rt }); assert.equal(calls, 1); assert.equal(first.retryAfterSeconds, 120); assert.equal(first.traversal.blocked, true);
  const early = await acquireFecPages({ ...sourceArgs, cursor: first.traversal.cursor, runtime: rt });
  assert.equal(calls, 1); assert.deepEqual(early.coverage.reasons, ['provider_cooldown']); assert.equal(early.traversal.blocked, true);
  now += 120000;
  const resumed = await acquireFecPages({ ...sourceArgs, cursor: early.traversal.cursor, runtime: { ...rt, fetch: async () => { calls++; return response([]); } } });
  assert.equal(calls, 3); assert.equal(resumed.traversal.complete, true);
  for (const status of [400, 401, 403]) {
    let n = 0; const denied = await acquireFecPages({ ...sourceArgs, runtime: runtime(async () => { n++; return new Response('{}', { status }); }) });
    assert.equal(n, 1); assert.equal(denied.error, `HTTP ${status}`); assert.equal(denied.traversal.complete, false); assert.equal(decode(denied.traversal.cursor).search, 0);
  }
});

test('FEC cross-call pacing is retained and request limit stops before the next cycle/filter', async () => {
  let now = 100000, starts = [], waits = [];
  const rt = { fetch: async () => { starts.push(now); return response([]); }, now: () => now, enforcePacing: true, sleep: async ms => { waits.push(ms); now += ms; }, budget: { requests: 1 } };
  const first = await acquireFecPages({ ...sourceArgs, runtime: rt });
  assert.equal(first.traversal.searchesCompleted, 1); assert.deepEqual(first.coverage.reasons, ['request_budget']);
  const last = await acquireFecPages({ ...sourceArgs, cursor: first.traversal.cursor, runtime: rt });
  assert.equal(last.traversal.complete, true); assert.deepEqual(starts, [100000, 100150]); assert.deepEqual(waits, [150]);
});

test('FEC repeated pages/cursors retain fetched rows and block instead of silently skipping a search', async () => {
  for (const kind of ['identities', 'cursor', 'cycle']) {
    let calls = 0, next = null;
    const rt = runtime(async raw => {
      calls++; const n = Number(new URL(raw).searchParams.get('last_index') || 0);
      const id = kind === 'identities' ? 1 : calls;
      return response([row(id, calls === 1 ? 0 : -5)], indexes(kind === 'cursor' ? 1 : kind === 'cycle' ? (n === 1 ? 2 : 1) : calls));
    }, { pages: 1 });
    let last;
    for (let n = 0; n < 12; n++) { last = await acquireFecPages({ ...sourceArgs, cursor: next, runtime: rt }); next = last.traversal.cursor; if (last.traversal.blocked) break; }
    assert.equal(last.error, 'pagination_stalled'); assert.equal(last.items.length, 1); assert.equal(last.traversal.searchesCompleted, 0);
    const count = calls; const blocked = await acquireFecPages({ ...sourceArgs, cursor: next, runtime: rt });
    assert.equal(calls, count); assert.equal(blocked.traversal.requiresRestart, true);
  }
});

test('FEC no-progress page retains changed versions, unknown/zero/negative amounts and native lineage', async () => {
  let calls = 0; const data = await fetchMoneyFlows(args, runtime(async () => {
    calls++; return response(calls === 1 ? [row(1, null), row(2, 0)] : [row(1, -5), row(2, 0)], indexes(calls));
  }));
  assert.equal(calls, 2); assert.equal(data.items.length, 3); assert.equal(data.coverage.outputTruncated, false);
  assert.equal(data.items.filter(x => x.sourceId === '1').length, 2); assert.equal(data.items.filter(x => x.duplicateIdentity).length, 1);
  assert.equal(data.items.find(x => x.duplicateIdentity).includeInSubtotal, false);
  assert.equal(data.summary.buckets.contributions.totalAmount, 0); assert.equal(data.summary.buckets.contributions.unknownAmountCount, 1);
  assert.ok(data.items.every(x => x.fileNumber === 123 && x.originalSubId === null && x.transactionId));
});

test('FEC lost responses/replay and missing history restart preserve identity/hash but never assert durable acknowledgment', async () => {
  const rt = runtime(stream({ length: 4 }), { pages: 1 });
  const lost = await fetchMoneyFlows(args, rt), replay = await fetchMoneyFlows(args, rt);
  assert.deepEqual(lost.items, replay.items);
  const resumed = await fetchMoneyFlows(JSON.parse(JSON.stringify(replay.fecTraversal.next)), rt);
  assert.notEqual(resumed.items[0].sourceId, replay.items[0].sourceId);
  const recovered = new Map([...lost.items, ...replay.items, ...resumed.items].map(x => [`${x.source}:${x.sourceId}:${x.observationHash}`, x]));
  assert.equal(recovered.size, 2); assert.match(replay.coverage.note, /best-effort, not durable acknowledgment/);
  assert.equal(replay.fecTraversal.startsFromBeginning, true); assert.equal(resumed.fecTraversal.startsFromBeginning, false);
});

test('FEC traversal always starts at beginning after a ranked sample and covers all explicit aliases', async () => {
  const entities = Array.from({ length: 10 }, (_, i) => `Entity ${i}`);
  const rt = runtime(async raw => {
    const u = new URL(raw);
    if (u.hostname === 'api.open.fec.gov') return u.searchParams.has('last_index') ? response([]) : response([row(1), row(2)], indexes(2));
    if (u.hostname === 'lda.gov') return new Response(JSON.stringify({ results: [], next: null }));
    if (u.hostname === 'api.usaspending.gov') return new Response(JSON.stringify({ results: [], page_metadata: { hasNext: false } }));
    return new Response(JSON.stringify({ entityData: [], totalRecords: 0 }));
  });
  const sample = await fetchMoneyFlows({ ...args, mode: 'sample' }, rt);
  assert.equal(sample.items.length, 1); assert.equal(sample.fecTraversal.startsFromBeginning, true);
  assert.deepEqual(decode(sample.fecTraversal.next.cursor).indexes, {}); assert.equal(decode(sample.fecTraversal.next.cursor).search, 0);
  const page = await fetchMoneyFlows(sample.fecTraversal.next, rt); assert.equal(page.items.length, 2);
  const many = await fetchMoneyFlows({ ...args, entities }, runtime(async () => response([])));
  assert.equal(many.fecTraversal.searchesPlanned, 20); assert.equal(many.coverage.queryVariantsTruncated, false);
  assert.equal(many.sources.fec.coverage.requests, 12); assert.equal(many.fecTraversal.complete, false);
});

test('FEC continuation leaves audit/verifier acquisition allowance unchanged and HTTP forwards mode/cursor', () => {
  assert.deepEqual(MONEY_BUDGET, { requests: 12, pages: 3, deadlineMs: 45000, timeoutMs: 15000 });
  for (const path of ['server.mjs', 'gcp/feed-proxy/server.js']) {
    const code = readFileSync(path, 'utf8'); assert.match(code, /mode: url.searchParams.get\('mode'\) \|\| 'sample', cursor: url.searchParams.get\('cursor'\)/);
  }
  const verifier = readFileSync('scripts/verify_money_candidate.mjs', 'utf8'); assert.doesNotMatch(verifier, /fec_pages/);
});

test('Feed and local HTTP routes execute fec_pages and forward frozen cursor arguments with inert FEC responses', async t => {
  const { spawn } = await import('node:child_process');
  const { get } = await import('node:http');
  const { pathToFileURL } = await import('node:url');
  const read = url => new Promise((resolve, reject) => get(url, response => {
    let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
  for (const file of ['server.mjs', 'gcp/feed-proxy/server.js']) {
    const program = `import http from 'node:http';
      const listen = http.Server.prototype.listen;
      http.Server.prototype.listen = function(...args) { const callback = args.find(arg => typeof arg === 'function'); return listen.call(this, 0, '127.0.0.1', () => { console.log('FIXTURE_PORT=' + this.address().port); callback?.(); }); };
      globalThis.fetch = async raw => { const u = new URL(raw); if (u.hostname !== 'api.open.fec.gov') throw new Error('Unobserved provider forbidden');
        console.log('FIXTURE_REQUEST'); const n = Number(u.searchParams.get('last_index') || 0);
        return new Response(JSON.stringify({results: n >= 4 ? [] : [{sub_id:String(n+1),contributor_name:'Acme',contribution_receipt_amount:n,contribution_receipt_date:'2026-01-01'}], pagination:{last_indexes:{last_index:String(n+1),last_contribution_receipt_date:'2026-01-01'}}})); };
      await import(${JSON.stringify(pathToFileURL(`${process.cwd()}/${file}`).href)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATA_GOV: 'inert' } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
    t.after(() => child.kill());
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`HTTP fixture failed to start: ${errors}`)), 10000);
      child.stdout.on('data', () => { const match = /FIXTURE_PORT=(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`HTTP fixture exit ${code}: ${errors}`)); });
    });
    const base = `http://127.0.0.1:${port}/api/money-flows`;
    const query = { q: 'Acme', start: '2025-01-01', end: '2026-11-03', mode: 'fec_pages', limit: '1' };
    const first = await read(`${base}?${new URLSearchParams(query)}`);
    assert.equal(first.items.length, 3, file); assert.equal(first.coverage.status, 'fec_batch');
    const next = first.fecTraversal.next; const forwarded = { ...next, q: next.query }; delete forwarded.query;
    const second = await read(`${base}?${new URLSearchParams(forwarded)}`);
    assert.equal(second.items[0].sourceId, '4', file);
    const requests = output.match(/FIXTURE_REQUEST/g)?.length || 0;
    const invalid = await read(`${base}?${new URLSearchParams({ ...forwarded, q: 'Different' })}`);
    assert.equal(invalid.error, 'invalid_cursor'); assert.equal(output.match(/FIXTURE_REQUEST/g)?.length || 0, requests);
    child.kill();
  }
});

test('Normal audit inspects the FEC entrypoint in its existing aggregate response without new acquisitions', async () => {
  const { inspectMoneyFlows } = await import('../../analysis/monitor/lib/money_flows.mjs');
  const rt = runtime(async raw => {
    const u = new URL(raw);
    if (u.hostname === 'lda.gov') return new Response(JSON.stringify({ results: [], next: null }));
    if (u.hostname === 'api.open.fec.gov') return response([]);
    if (u.hostname === 'api.usaspending.gov') return new Response(JSON.stringify({ results: [], page_metadata: { hasNext: false } }));
    return new Response(JSON.stringify({ entityData: [], totalRecords: 0 }));
  });
  const data = await fetchMoneyFlows({ ...args, mode: 'sample' }, rt);
  assert.ok(!inspectMoneyFlows({ ok: true, data }).alerts.some(x => x.regressionClass === 'money-flow-fec-continuation'));
  delete data.fecTraversal;
  assert.ok(inspectMoneyFlows({ ok: true, data }).alerts.some(x => x.regressionClass === 'money-flow-fec-continuation'));
});

test('Sample FEC Retry-After is preserved by its restart-from-beginning entrypoint', async () => {
  let now = 100000, fecCalls = 0;
  const rt = { ...runtime(async raw => {
    const u = new URL(raw);
    if (u.hostname === 'api.open.fec.gov') { fecCalls++; return new Response('{}', { status: 429, headers: { 'retry-after': '120' } }); }
    if (u.hostname === 'lda.gov') return new Response(JSON.stringify({ results: [], next: null }));
    if (u.hostname === 'api.usaspending.gov') return new Response(JSON.stringify({ results: [], page_metadata: { hasNext: false } }));
    return new Response(JSON.stringify({ entityData: [], totalRecords: 0 }));
  }), now: () => now };
  const sample = await fetchMoneyFlows({ ...args, mode: 'sample' }, rt);
  const next = await fetchMoneyFlows(sample.fecTraversal.next, rt);
  assert.equal(fecCalls, 1); assert.equal(next.fecTraversal.blocked, true); assert.equal(next.sources.fec.retryAfterSeconds, 120);
});

test('FEC malformed provider rows halt without fabricating receipts; missing native identity stays null', async () => {
  const bad = await acquireFecPages({ ...sourceArgs, runtime: runtime(async () => response([null], indexes(1))) });
  assert.equal(bad.error, 'invalid_shape'); assert.equal(bad.items.length, 0); assert.equal(bad.traversal.requiresRestart, true);
  const unknown = await fetchMoneyFlows(args, runtime(async () => response([{ contributor_name: 'Acme', contribution_receipt_amount: null }], indexes(1)), { pages: 1 }));
  assert.equal(unknown.items[0].sourceId, null); assert.equal(unknown.items[0].amount, null); assert.match(unknown.items[0].observationHash, /^[a-f0-9]{64}$/);
});

test('FEC version subtotal exclusion applies to matching returned identities, not unmatched acquired versions', async () => {
  const data = await fetchMoneyFlows({ ...args, matchMode: 'strict' }, runtime(async () => response([
    { ...row(1, 100), contributor_name: 'Unrelated', contributor_employer: null }, row(1, -5), row(1, 0)
  ], indexes(1)), { pages: 1 }));
  assert.equal(data.items.length, 2); assert.equal(data.items[0].amount, -5);
  assert.equal(data.items[0].duplicateIdentity, false); assert.equal(data.items[1].duplicateIdentity, true);
  assert.equal(data.summary.buckets.contributions.totalAmount, -5);
});

test('FEC unidentified equal-content occurrences retain multiplicity without inventing source identity', async () => {
  const raw = { contributor_name: 'Acme', contribution_receipt_amount: 10 };
  const rt = runtime(async () => response([raw, { ...raw }], indexes(1)), { pages: 1 });
  const data = await fetchMoneyFlows(args, rt), replay = await fetchMoneyFlows(args, rt);
  assert.equal(data.sources.fec.count, 2); assert.equal(data.items.length, 2);
  assert.deepEqual(data.items.map(x => x.sourceId), [null, null]);
  assert.equal(data.items[0].observationHash, data.items[1].observationHash);
  assert.deepEqual(data.items.map(x => x.observationOccurrence), [0, 1]);
  assert.equal(data.summary.buckets.contributions.totalAmount, 20);
  assert.deepEqual(data.items, replay.items);
  assert.match(data.coverage.note, /hash alone cannot reconcile/);
});

test('FEC diagnostic newIdentityCount counts distinct identities while retaining both observed versions', async () => {
  const data = await acquireFecPages({ ...sourceArgs, runtime: runtime(async () => response([row(1, 0), row(1, -5)], indexes(1)), { pages: 1 }) });
  assert.equal(data.items.length, 2);
  const parsed = data.coverage.diagnostics.attempts.find(x => x.branch === 'response_ok');
  assert.equal(parsed.rowCount, 2); assert.equal(parsed.newIdentityCount, 1);
});
