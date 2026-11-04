// Discovery samples plus stateless LDA page traversal. No credentials or provider URLs in cursors.
import { createHash } from 'node:crypto';
export const MONEY_BUDGET = Object.freeze({ requests: 12, pages: 3, deadlineMs: 45000, timeoutMs: 15000 });
// LDA publishes rate limits, not a total request/page limit. Keep only the HTTP
// response deadline for aggregate sampling; page traversal has no total cap.
const LDA_INTERVAL_MS = 4100; // Anonymous: 15 requests/minute (lda.gov/api/tos/).
const samCache = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (item) => item.filing_uuid ?? item.sub_id ?? item.entityRegistration?.ueiSAM ?? hash(item);

export function fecCycles(start, end) {
  const cycles = [], seen = new Set();
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    const cycle = year + year % 2;
    if (!seen.has(cycle)) { seen.add(cycle); cycles.push(cycle); }
  }
  return cycles;
}

function context(runtime = {}, intervalMs = 0) {
  const now = runtime.now || Date.now;
  return { fetch: runtime.fetch || globalThis.fetch, sleep: runtime.sleep || pause, now,
    budget: { ...MONEY_BUDGET, ...runtime.budget }, started: now(), requests: 0, lastRequest: null,
    intervalMs: runtime.enforcePacing || !runtime.sleep ? intervalMs : 0, blocked: null, retryAfterSeconds: null, retryAt: null };
}

async function request(ctx, url, options = {}, retry = false) {
  // Freeze query, cursor, ordering and body across the single permitted retry.
  const frozenUrl = String(url);
  const frozenOptions = { ...options, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'SituationRoomMoney/2.0', ...options.headers } };
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    if (ctx.blocked) throw new Error(ctx.blocked);
    if (ctx.requests >= ctx.budget.requests) { ctx.stopped = 'request_budget'; throw new Error(ctx.stopped); }
    const delay = ctx.lastRequest === null ? 0 : Math.max(0, ctx.intervalMs - (ctx.now() - ctx.lastRequest));
    if (ctx.now() - ctx.started + delay >= ctx.budget.deadlineMs) { ctx.stopped = 'deadline'; throw new Error(ctx.stopped); }
    if (delay) await ctx.sleep(delay);
    ctx.requests++; ctx.lastRequest = ctx.now();
    let response;
    try {
      response = await ctx.fetch(frozenUrl, { ...frozenOptions,
        signal: AbortSignal.timeout(Math.max(1, Math.min(ctx.budget.timeoutMs, ctx.budget.deadlineMs - (ctx.now() - ctx.started)))) });
      if (response.ok) return await response.json();
    } catch (error) {
      if (attempt === 0 && retry && ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name)) {
        await ctx.sleep(500); continue;
      }
      throw new Error(error instanceof SyntaxError ? 'invalid_json' : 'fetch_failed');
    }
    const status = response.status;
    // Access/quota failures stop sibling searches against this provider.
    if (status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header == null ? NaN : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - ctx.now()) / 1000;
      if (Number.isFinite(seconds)) { ctx.retryAfterSeconds = Math.max(0, Math.ceil(seconds)); ctx.retryAt = new Date(ctx.now() + ctx.retryAfterSeconds * 1000).toISOString(); }
    }
    if ([401, 403, 429].includes(status)) ctx.blocked = `HTTP ${status}`;
    await response.body?.cancel();
    if (attempt === 0 && retry && [502, 503, 504].includes(status)) { await ctx.sleep(500); continue; }
    throw new Error(`HTTP ${status}`);
  }
}

function safeNext(current, next, mutable = ['page']) {
  const before = new URL(current), after = new URL(next, current);
  if (after.origin !== before.origin || after.pathname !== before.pathname || after.username || after.password || after.hash) throw new Error('invalid_next');
  const frozen = (url) => [...url.searchParams].filter(([key]) => !mutable.includes(key)).sort().map(JSON.stringify).join('|');
  if (frozen(before) !== frozen(after)) throw new Error('changed_query');
  if (!/^\d+$/.test(after.searchParams.get('page') || '') || Number(after.searchParams.get('page')) <= Number(before.searchParams.get('page') || 1)) throw new Error('pagination_stalled');
  return after.toString();
}

async function pages(ctx, initial, { rows, next, options, retry = false, key = identity }) {
  const result = { items: [], pages: 0, complete: false, reason: null };
  const seen = new Set(); let cursor = initial; const cursors = new Set();
  try {
    for (let page = 0; page < ctx.budget.pages; page++) {
      const cursorKey = JSON.stringify(cursor);
      if (cursors.has(cursorKey)) throw new Error('pagination_stalled');
      cursors.add(cursorKey);
      const { url, init } = options ? options(cursor) : { url: cursor, init: {} };
      const data = await request(ctx, url, init, retry);
      const batch = rows(data);
      if (!Array.isArray(batch)) throw new Error('invalid_shape');
      result.pages++;
      let added = 0;
      for (const item of batch) {
        const id = String(key(item));
        if (!seen.has(id)) { seen.add(id); result.items.push(item); added++; }
      }
      if (result.pages > 1 && batch.length && !added) throw new Error('pagination_stalled');
      const following = next(data, cursor, batch);
      if (following === null) { result.complete = true; return result; }
      if (!batch.length || !added) throw new Error('pagination_stalled');
      cursor = following;
    }
    result.reason = 'page_budget';
  } catch (error) { result.reason = error.message; }
  return result;
}

// Materialize only attempted searches; wide historical windows must not allocate
// every year/alias/filter combination before a response deadline can take effect.
function searchPlan(length, at) {
  return { length, at, *[Symbol.iterator]() { for (let i = 0; i < length; i++) yield at(i); } };
}

async function searches(ctx, specs, run) {
  const batches = [];
  const initialRequests = ctx.requests;
  for (const spec of specs) {
    if (ctx.blocked || ctx.stopped || ctx.requests >= ctx.budget.requests || ctx.now() - ctx.started >= ctx.budget.deadlineMs) break;
    batches.push(await run(spec));
  }
  let reasons = [...new Set(batches.map((batch) => batch.reason).filter(Boolean))];
  if (batches.length < specs.length) reasons.push(ctx.blocked || ctx.stopped || (ctx.now() - ctx.started >= ctx.budget.deadlineMs ? 'deadline' : 'request_budget'));
  reasons = [...new Set(reasons)];
  const error = reasons.find((reason) => !['page_budget', 'request_budget', 'search_budget', 'deadline'].includes(reason)) || null;
  const requests = ctx.requests - initialRequests;
  // A sibling can consume the shared budget before this endpoint is attempted.
  // That is incomplete observation, not evidence that the provider failed.
  const unattemptedForBudget = requests === 0 && !error;
  return { items: batches.flatMap((batch) => batch.items), retryAfterSeconds: ctx.retryAfterSeconds, retryAt: ctx.retryAt, coverage: {
    status: reasons.length ? (batches.some((b) => b.pages) || unattemptedForBudget ? 'partial' : 'unavailable') : 'complete_for_queries',
    complete: reasons.length === 0, reasons, searchesPlanned: specs.length, searchesRun: batches.length,
    pages: batches.reduce((sum, b) => sum + b.pages, 0), requests, cachedSearches: batches.filter((b) => b.cached).length
  }, error };
}

export async function acquireLda({ terms, range, contributions = false, ctx }) {
  const filters = contributions ? ['registrant_name', 'contribution_contributor', 'contribution_payee'] : ['client_name', 'registrant_name', 'filing_specific_lobbying_issues'];
  // Each field is its own query: OR across fields, AND only with filing year.
  const specs = searchPlan(range.years.length * terms.length * filters.length, (index) => ({
    year: range.years[Math.floor(index / (terms.length * filters.length))],
    term: terms[Math.floor(index / filters.length) % terms.length], filter: filters[index % filters.length]
  }));
  const result = await searches(ctx, specs, async ({ year, term, filter }) => {
    const url = new URL(`https://lda.gov/api/v1/${contributions ? 'contributions' : 'filings'}/`);
    url.search = new URLSearchParams({ filing_year: String(year), [filter]: term, ordering: '-dt_posted', page_size: '25', page: '1' });
    return pages(ctx, url.toString(), { rows: (d) => d.results,
      next: (d, current) => { if (!Object.hasOwn(d, 'next')) throw new Error('missing_pagination'); return d.next ? safeNext(current, d.next) : null; } });
  });
  result.coverage.dateBasis = 'filing_year (whole years); child contribution dates filtered where known';
  result.coverage.scope = 'Client, registrant and issue searches; LD-203 registrant, contributor and payee searches. Amendments are separate filings; not net lobbying spend.';
  return result;
}

export async function acquireFec({ terms, range, key, runtime }) {
  const ctx = context(runtime, 150);
  const cycles = fecCycles(range.startIso, range.endIso);
  const specs = searchPlan(cycles.length * terms.length * 2, (index) => {
    const term = terms[Math.floor(index / 2) % terms.length];
    const filters = /^C\d{8}$/i.test(term) ? ['contributor_id', 'committee_id'] : ['contributor_name', 'contributor_employer'];
    return { cycle: cycles[Math.floor(index / (terms.length * 2))], term, filter: filters[index % 2] };
  });
  const result = await searches(ctx, specs, ({ cycle, term, filter }) => {
    const base = new URL('https://api.open.fec.gov/v1/schedules/schedule_a/');
    base.search = new URLSearchParams({ api_key: key || 'DEMO_KEY', per_page: '100', sort: '-contribution_receipt_date',
      min_date: range.startIso, max_date: range.endIso, two_year_transaction_period: String(cycle), [filter]: term, sort_hide_null: 'false' });
    return pages(ctx, {}, { retry: true, rows: (d) => d.results,
      options: (cursor) => { const url = new URL(base); for (const [k, v] of Object.entries(cursor)) url.searchParams.set(k, String(v)); return { url: url.toString(), init: {} }; },
      next: (d, cursor, batch) => {
        if (!d.pagination || typeof d.pagination !== 'object') throw new Error('missing_pagination');
        if (!batch.length) return null;
        const indexes = d.pagination.last_indexes;
        if (!indexes || indexes.last_index == null) throw new Error('missing_cursor');
        if (!Object.hasOwn(indexes, 'last_contribution_receipt_date') && indexes.sort_null_only !== true) throw new Error('missing_cursor');
        const allowed = ['last_index', 'last_contribution_receipt_date', 'last_contribution_receipt_amount', 'sort_null_only'];
        if (Object.keys(indexes).some((k) => !allowed.includes(k))) throw new Error('invalid_cursor');
        const next = Object.fromEntries(Object.entries(indexes).filter(([, v]) => v !== null && v !== undefined));
        if (indexes.last_contribution_receipt_date === null) next.sort_null_only = true;
        if (JSON.stringify(next) === JSON.stringify(cursor)) throw new Error('pagination_stalled');
        return next;
      } });
  });
  result.coverage.scope = 'Schedule A receipts: named donors, reported employers, or explicit committee IDs. Employer affiliation is not an employer donation. PAC affiliation is not inferred from names.';
  result.coverage.cycles = fecCycles(range.startIso, range.endIso);
  return result;
}

export async function acquireUsa({ terms, range, runtime }) {
  const ctx = context(runtime, 150);
  return searches(ctx, terms, (term) => pages(ctx, 1, {
    rows: (d) => d.results,
    key: (item) => hash(item),
    options: (page) => ({ url: 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      filters: { keywords: [term], time_period: [{ start_date: range.startIso, end_date: range.endIso }],
        award_type_codes: ['A', 'B', 'C', 'D', 'IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'] },
      fields: ['Recipient Name', 'Recipient UEI', 'Award ID', 'generated_internal_id', 'Mod', 'Action Date', 'Action Type', 'Transaction Amount', 'Loan Value', 'Subsidy Cost', 'Awarding Agency', 'Transaction Description'],
      limit: 100, page, sort: 'Action Date', order: 'desc'
    }) } }),
    next: (d, current) => {
      const meta = d.page_metadata;
      if (typeof meta?.hasNext !== 'boolean') throw new Error('missing_pagination');
      if (!meta.hasNext) return null;
      if (!Number.isInteger(meta.next) || meta.next <= current) throw new Error('pagination_stalled');
      return meta.next;
    }
  }));
}

export async function acquireSam({ terms, key, runtime }) {
  const ctx = context(runtime, 150);
  if (!key) return { items: [], error: 'missing_key', coverage: { status: 'unavailable', complete: false, reasons: ['missing_key'], pages: 0, requests: 0 } };
  const result = await searches(ctx, terms, async (term) => {
    // Exact query + credential identity; response pages always have size 10, starting at 0.
    const cacheKey = hash([term, key, ctx.budget.pages]);
    const cached = samCache.get(cacheKey);
    if (!runtime?.fetch && cached && ctx.now() - cached.at < 600000) return { ...cached.result, cached: true };
    const base = new URL('https://api.sam.gov/entity-information/v4/entities');
    base.search = new URLSearchParams({ api_key: key, legalBusinessName: term, includeSections: 'entityRegistration,coreData', page: '0', size: '10' });
    const result = await pages(ctx, base.toString(), { rows: (d) => d.entityData,
      next: (d, current, batch) => {
        if (d.links?.nextLink) {
          // SAM omits the key in links. Validate the complete frozen query before restoring it.
          const next = new URL(d.links.nextLink, current); next.searchParams.set('api_key', key);
          return safeNext(current, next.toString());
        }
        const total = Number(d.totalRecords);
        if (d.totalRecords == null || !Number.isFinite(total)) throw new Error('missing_pagination');
        const page = Number(new URL(current).searchParams.get('page'));
        if ((page * 10) + batch.length >= total) return null;
        const next = new URL(current); next.searchParams.set('page', String(page + 1)); return next.toString();
      } });
    if (result.complete && !runtime?.fetch) {
      if (samCache.size >= 128) samCache.delete(samCache.keys().next().value);
      samCache.set(cacheKey, { at: ctx.now(), result });
    }
    return result;
  });
  result.coverage.scope = 'Current public legal-name registrations only; no award or historical spending evidence.';
  return result;
}

export async function acquireMoneySources({ terms, range, runtime = {} }) {
  const ldaContext = ldaContextFor(runtime);
  const lda = (async () => {
    const filings = await acquireLda({ terms, range, ctx: ldaContext });
    const contributions = await acquireLda({ terms, range, ctx: ldaContext, contributions: true });
    for (const source of [filings, contributions]) source.coverage.nextRequestAt = ldaNextRequestAt(ldaContext);
    return { lda: filings, ldaContributions: contributions };
  })();
  const [ldaResult, fec, usaspending, sam] = await Promise.all([
    lda, acquireFec({ terms, range, key: process.env.DATA_GOV, runtime }),
    acquireUsa({ terms, range, runtime }), acquireSam({ terms, key: process.env.SAMGOV_API_KEY || process.env.DATA_GOV, runtime })
  ]);
  return { ...ldaResult, fec, usaspending, sam };
}


function ldaContextFor(runtime) {
  const ctx = context(runtime, LDA_INTERVAL_MS);
  ctx.budget.requests = Infinity;
  ctx.budget.pages = Infinity;
  return ctx;
}

function ldaNextRequestAt(ctx) {
  return Math.max(ctx.lastRequest === null ? 0 : ctx.lastRequest + ctx.intervalMs, Date.parse(ctx.retryAt) || 0);
}

function ldaPagePlan(terms, range) {
  // Same stable year/alias/filter order as the original version-1 cursor. Compute
  // only the current search instead of allocating the historical cross-product.
  const fields = ['client_name', 'registrant_name', 'filing_specific_lobbying_issues'];
  const childFields = ['registrant_name', 'contribution_contributor', 'contribution_payee'];
  const startYear = range.startYear ?? Number(range.startIso.slice(0, 4));
  const endYear = range.endYear ?? Number(range.endIso.slice(0, 4));
  const perYear = terms.length * 6;
  return {
    length: (endYear - startYear + 1) * perYear,
    at(index) {
      const contributions = index % 2 === 1;
      const fieldIndex = Math.floor((index % 6) / 2);
      return { year: startYear + Math.floor(index / perYear), term: terms[Math.floor((index % perYear) / 6)],
        filter: (contributions ? childFields : fields)[fieldIndex],
        source: contributions ? 'ldaContributions' : 'lda', endpoint: contributions ? 'contributions' : 'filings' };
    }
  };
}

const encodeLdaCursor = (state) => Buffer.from(JSON.stringify(state)).toString('base64url');
export function startLdaCursor(binding, notBefore = 0) {
  return encodeLdaCursor({ version: 1, binding, search: 0, page: 1, previous: null, notBefore });
}

// A cursor is validated query state, not authority: URLs are reconstructed from
// the current query plan. No server-side checkpoint or signing secret is needed.
export async function acquireLdaPage({ terms, range, binding, cursor, runtime = {} }) {
  const specs = ldaPagePlan(terms, range);
  let state;
  try {
    if (cursor && (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new Error();
    state = JSON.parse(Buffer.from(cursor || startLdaCursor(binding), 'base64url').toString());
    if (state.version !== 1 || state.binding !== binding || !Number.isSafeInteger(state.search) || state.search < 0 || state.search >= specs.length ||
        !Number.isSafeInteger(state.page) || state.page < 1 ||
        !(state.previous === null || /^[a-f0-9]{64}$/.test(state.previous)) ||
        !Number.isFinite(state.notBefore) || state.notBefore < 0) throw new Error();
  } catch { return { invalidCursor: true }; }
  const ctx = ldaContextFor(runtime);
  if (state.notBefore) ctx.lastRequest = state.notBefore - ctx.intervalMs;
  const spec = specs.at(state.search);
  const url = new URL(`https://lda.gov/api/v1/${spec.endpoint}/`);
  url.search = new URLSearchParams({ filing_year: String(spec.year), [spec.filter]: spec.term,
    ordering: '-dt_posted', page_size: '25', page: String(state.page) });
  let items = [], error = null, nextState = { ...state }, fetched = false;
  try {
    const data = await request(ctx, url);
    if (!Array.isArray(data.results)) throw new Error('invalid_shape');
    // Return an entire page, including every contribution child. Never rank-slice
    // away records before advancing a cursor. Dedup across pages belongs to caller.
    items = data.results;
    fetched = true;
    const fingerprint = hash(items.map(identity).map(String).sort());
    if (items.length && fingerprint === state.previous) throw new Error('pagination_stalled');
    if (!Object.hasOwn(data, 'next')) throw new Error('missing_pagination');
    if (data.next) {
      if (!items.length) throw new Error('pagination_stalled');
      const following = new URL(safeNext(url, data.next));
      const page = Number(following.searchParams.get('page'));
      if (!Number.isSafeInteger(page)) throw new Error('invalid_next');
      nextState = { ...state, page, previous: fingerprint };
    } else {
      nextState = { ...state, search: state.search + 1, page: 1, previous: null };
    }
  } catch (failure) { error = failure.message; }
  nextState.notBefore = Math.max(state.notBefore, ldaNextRequestAt(ctx));
  const complete = !error && nextState.search === specs.length;
  const providerError = error === 'deadline' ? null : error;
  return { source: spec.source, items, error: providerError, retryAfterSeconds: ctx.retryAfterSeconds, retryAt: ctx.retryAt,
    coverage: { status: error ? (fetched || !providerError ? 'partial' : 'unavailable') : 'page', complete: false,
      reasons: error ? [error] : [], pages: fetched ? 1 : 0, requests: ctx.requests,
      scope: 'One LDA provider page; whole filing years, contribution dates filtered where known.' },
    traversal: { complete, searchesPlanned: specs.length, searchesCompleted: nextState.search,
      search: state.search, page: state.page, endpoint: spec.endpoint, filter: spec.filter,
      filingYear: spec.year, term: spec.term, nextRequestAt: nextState.notBefore,
      cursor: complete ? null : encodeLdaCursor(nextState) }
  };
}
