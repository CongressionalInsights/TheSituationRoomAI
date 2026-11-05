import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMoneyFlows } from '../../gcp/mcp-proxy/money-flows.js';
import { acquireLdaPage } from '../../gcp/mcp-proxy/money-sources.js';

// Structural replay of owner-captured pagination, not a copy of private raw
// responses: count 105, 25/25/25/25/5 repeated parents, identical ID-less children.
const query = 'Finite Fixture';
const args = { query, entities: [query], start: '2026-01-01', end: '2026-11-03', limit: 120 };
const children = Array.from({ length: 105 }, (_, i) => ({ contributor_name: query,
  payee_name: `Recipient ${i}`, amount: i === 0 ? null : i === 1 ? 0 : -5, date: '2026-02-26' }));
const parent = { filing_uuid: 'filing-repeated', registrant: { name: query }, contribution_items: children };
function link(url, page, omitFirst = false) {
  if (page === null) return null;
  const next = new URL(url);
  if (omitFirst && page === 1) next.searchParams.delete('page');
  else next.searchParams.set('page', String(page));
  return next.toString();
}
function fixture(mutate = () => {}, { filings = false } = {}) {
  const pages = [];
  const runtime = { sleep: async () => {}, fetch: async raw => {
    const url = new URL(raw);
    let data;
    const target = url.hostname === 'lda.gov' && url.pathname.endsWith(filings ? '/filings/' : '/contributions/')
      && url.searchParams.has(filings ? 'client_name' : 'contribution_contributor');
    if (target) {
      const page = Number(url.searchParams.get('page')); pages.push(page);
      assert.ok(page <= 5, 'finite metadata must not acquire beyond the terminal page');
      data = { count: 105, results: Array(page === 5 ? 5 : 25).fill(parent),
        next: link(url, page < 5 ? page + 1 : null), previous: link(url, page > 1 ? page - 1 : null, true) };
      mutate(data, page, url);
    } else if (url.hostname === 'lda.gov') data = { count: 0, results: [], next: null, previous: null };
    else if (url.hostname === 'api.open.fec.gov') data = { results: [], pagination: { last_indexes: null } };
    else if (url.hostname === 'api.usaspending.gov') data = { results: [], page_metadata: { hasNext: false } };
    else data = { entityData: [], totalRecords: 0 };
    return new Response(JSON.stringify(data), { status: 200 });
  } };
  return { pages, runtime };
}
async function collect(mode, f, input = args) {
  const outputs = [];
  let next = { ...input, mode };
  for (let i = 0; i < 12; i++) {
    const data = await fetchMoneyFlows(next, f.runtime); outputs.push(data);
    const failed = Object.values(data.sources).some(s => s.error);
    if (mode === 'sample' || failed || data.ldaTraversal.complete) return outputs;
    next = data.ldaTraversal.next;
  }
  assert.fail('fixture did not terminate');
}
for (const mode of ['sample', 'lda_pages']) {
  test(`LD203 finite proof ${mode}: five repeated-parent pages reach true exhaustion`, async () => {
    const f = fixture(); const out = await collect(mode, f);
    assert.deepEqual(f.pages, [1, 2, 3, 4, 5]);
    assert.ok(out.every(d => !d.sources.ldaContributions.error));
    if (mode === 'sample') assert.equal(out[0].sources.ldaContributions.coverage.complete, true);
    else { assert.equal(out.at(-1).ldaTraversal.complete, true); assert.equal(out.at(-1).ldaTraversal.next, null); }
    const rows = out.flatMap(d => d.items).filter(r => r.type === 'Lobbying Contribution');
    const distinct = new Map(rows.map(r => [r.sourceId, r]));
    assert.equal(distinct.size, 105);
    assert.deepEqual([...new Set(rows.map(r => r.amount))].sort(), [-5, 0, null].sort());
    assert.ok(rows.every(r => r.childId === null));
  });
  test(`LD203 finite proof ${mode}: page three retains a later in-window child and parent`, async () => {
    const later = { contributor_name: query, payee_name: 'Later', amount: 0, date: '2026-11-02' };
    const f = fixture((data, page) => {
      if (page === 3) {
        data.results[0] = { ...parent, contribution_items: [...children, later] };
        data.results[1] = { ...parent, filing_uuid: 'later-parent', contribution_items: [{ ...later, amount: -5 }] };
      }
    });
    const out = await collect(mode, f, { ...args, start: '2026-10-31' });
    assert.deepEqual(f.pages, [1, 2, 3, 4, 5]);
    const rows = out.flatMap(d => d.items).filter(r => r.type === 'Lobbying Contribution');
    assert.deepEqual(rows.map(r => r.amount).sort(), [-5, 0]);
    assert.equal(new Set(rows.map(r => r.sourceId)).size, 2);
  });
  const defects = {
    'missing count': d => { delete d.count; },
    'null count': d => { d.count = null; },
    'string count': d => { d.count = '105'; },
    'negative count': d => { d.count = -1; },
    'fractional count': d => { d.count = 105.5; },
    'unsafe count': d => { d.count = Number.MAX_SAFE_INTEGER + 1; },
    'count drift': d => { d.count = 106; },
    'missing previous': d => { delete d.previous; },
    'wrong previous': (d, p, u) => { d.previous = link(u, p); },
    'previous query drift': (d, p, u) => { const v = new URL(link(u, p - 1)); v.searchParams.set('filing_year', '2025'); d.previous = v.toString(); },
    'previous credentials': (d, p, u) => { const v = new URL(link(u, p - 1)); v.username = 'fixture'; d.previous = v.toString(); },
    'previous fragment': (d, p, u) => { d.previous = link(u, p - 1) + '#fragment'; },
    'previous duplicate page': (d, p, u) => { d.previous = link(u, p - 1) + '&page=1'; },
    'short page': d => { d.results = d.results.slice(1); },
    'premature terminal': d => { d.next = null; },
    'missing next': d => { delete d.next; },
    'malformed next': d => { d.next = false; },
    'skipped next': (d, p, u) => { d.next = link(u, p + 2); },
    'repeated next': (d, p, u) => { d.next = link(u, p); },
    'duplicate next page': (d, p, u) => { d.next = link(u, p + 1) + '&page=4'; },
    'next query drift': (d, p, u) => { const v = new URL(link(u, p + 1)); v.searchParams.set('contribution_contributor', 'Other'); d.next = v.toString(); }
  };
  for (const [name, mutate] of Object.entries(defects)) test(`LD203 finite guard ${mode}: ${name} preserves rows and stops`, async () => {
    const f = fixture((d, p, u) => { if (p === 2) mutate(d, p, u); });
    const out = await collect(mode, f);
    assert.deepEqual(f.pages, [1, 2]);
    const failed = out.find(d => d.sources.ldaContributions.error);
    assert.ok(failed); assert.equal(failed.sources.ldaContributions.coverage.complete, false);
    assert.equal(failed.sources.ldaContributions.coverage.status, 'partial');
    assert.ok(failed.items.length > 0, 'retain already fetched children on malformed pagination');
    assert.equal(failed.ldaTraversal.complete, false);
  });
  test(`LD203 finite guard ${mode}: missing-count true stall and non-contribution guards remain`, async () => {
    const missing = fixture(d => { delete d.count; delete d.previous; });
    const out = await collect(mode, missing); assert.deepEqual(missing.pages, [1, 2]);
    assert.ok(out.some(d => d.sources.ldaContributions.error === 'pagination_stalled'));
    const filings = fixture(() => {}, { filings: true });
    const other = await collect(mode, filings); assert.deepEqual(filings.pages, [1, 2]);
    assert.ok(other.some(d => d.sources.lda.error === 'pagination_stalled'));
  });
  test(`LD203 finite guard ${mode}: terminal page cannot advertise another page or change count`, async () => {
    for (const mutate of [(d, p, u) => { d.next = link(u, 6); }, d => { d.count = 106; }, d => { delete d.count; }]) {
      const f = fixture((d, p, u) => { if (p === 5) mutate(d, p, u); });
      const out = await collect(mode, f);
      assert.deepEqual(f.pages, [1, 2, 3, 4, 5]);
      assert.ok(out.some(d => d.sources.ldaContributions.error));
      assert.equal(out.at(-1).ldaTraversal.complete, false);
    }
  });
}

test('LD203 finite cursor optional count is validated before acquisition; old cursors remain accepted', async () => {
  const binding = 'fixture';
  const state = { version: 1, binding, search: 3, page: 1, previous: null, notBefore: 0 };
  const range = { startIso: args.start, endIso: args.end };
  const f = fixture();
  for (const count of [-1, '105', 1.5, Number.MAX_SAFE_INTEGER + 1, {}]) {
    const result = await acquireLdaPage({ terms: [query], range, binding,
      cursor: Buffer.from(JSON.stringify({ ...state, contributionCount: count })).toString('base64url'), runtime: f.runtime });
    assert.equal(result.invalidCursor, true);
  }
  assert.deepEqual(f.pages, []);
  const result = await acquireLdaPage({ terms: [query], range, binding,
    cursor: Buffer.from(JSON.stringify(state)).toString('base64url'), runtime: f.runtime });
  assert.equal(result.error, null); assert.deepEqual(f.pages, [1]);
  const current = JSON.parse(Buffer.from(result.traversal.cursor, 'base64url'));
  assert.equal(current.contributionCount, 105);
  delete current.contributionCount;
  const legacy = await acquireLdaPage({ terms: [query], range, binding,
    cursor: Buffer.from(JSON.stringify(current)).toString('base64url'), runtime: f.runtime });
  assert.equal(legacy.error, 'pagination_stalled', 'legacy mid-search count stability is unknown');
  assert.equal(legacy.traversal.complete, false);
  assert.equal(legacy.items.length, 25, 'retain fetched rows even when old cursor cannot establish finite progress');
});
