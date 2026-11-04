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
const DIAGNOSTIC_LIMIT = 32;
const diagnosticFilters = new Set(['client_name', 'registrant_name', 'filing_specific_lobbying_issues', 'contribution_contributor', 'contribution_payee', 'contributor_id', 'committee_id', 'contributor_name', 'contributor_employer', 'keywords', 'legalBusinessName']);
const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const exceptionCategories = new Map([['TimeoutError', 'timeout'], ['AbortError', 'aborted'], ['TypeError', 'transport'], ['SyntaxError', 'invalid_json']]);
const exceptionCategory = error => exceptionCategories.get(error?.name) || 'unknown';

function diagnosticTiming(ctx) {
  const elapsedMs = nonnegative(ctx.now() - ctx.started), budgetMs = nonnegative(ctx.budget.deadlineMs);
  return { elapsedMs, budgetMs, remainingMs: elapsedMs === null || budgetMs === null ? null : Math.max(0, budgetMs - elapsedMs) };
}

// Bounded evidence only: never retain names, URLs, cursors, bodies or error text.
function recordDiagnostic(ctx, details, branch, attempted = false, attempt = 0) {
  const row = { sequence: ++ctx.diagnosticSequence, request: ctx.requests, attempt, attempted,
    filter: diagnosticFilters.has(details.filter) ? details.filter : null,
    year: integer(details.year), page: integer(details.page), pageKind: details.pageKind === 'numbered' ? 'numbered' : 'ordinal',
    branch, httpStatus: null, exceptionCategory: null, rowCount: null, newIdentityCount: null, identityHash: null,
    ...diagnosticTiming(ctx) };
  ctx.diagnostics.push(row);
  if (ctx.diagnostics.length > DIAGNOSTIC_LIMIT) ctx.diagnostics.shift();
  ctx.lastDiagnostic = row;
}

function annotateDiagnostic(ctx, changes) {
  if (ctx.lastDiagnostic) Object.assign(ctx.lastDiagnostic, changes, diagnosticTiming(ctx));
}

function diagnosticSnapshot(ctx, since = 0) {
  const attempts = ctx.diagnostics.filter(row => row.sequence > since).map(row => ({ ...row }));
  return { attempts, omitted: ctx.diagnosticSequence - since - attempts.length };
}

function paginationFailure(ctx, error) {
  if (ctx.lastDiagnostic?.branch !== 'response_ok') return;
  const branches = ['invalid_shape', 'missing_pagination', 'missing_cursor', 'invalid_cursor'];
  annotateDiagnostic(ctx, { branch: branches.includes(error.message) ? error.message : 'pagination_error' });
}

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
    intervalMs: runtime.enforcePacing || !runtime.sleep ? intervalMs : 0, blocked: null, retryAfterSeconds: null, retryAt: null,
    diagnostics: [], diagnosticSequence: 0, lastDiagnostic: null };
}

async function request(ctx, url, options = {}, retry = false, details = {}) {
  // Freeze query, cursor, ordering and body across the single permitted retry.
  const frozenUrl = String(url);
  const frozenOptions = { ...options, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'SituationRoomMoney/2.0', ...options.headers } };
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    if (ctx.blocked) { recordDiagnostic(ctx, details, 'provider_blocked'); throw new Error(ctx.blocked); }
    if (ctx.requests >= ctx.budget.requests) { recordDiagnostic(ctx, details, 'request_budget'); ctx.stopped = 'request_budget'; throw new Error(ctx.stopped); }
    const delay = ctx.lastRequest === null ? 0 : Math.max(0, ctx.intervalMs - (ctx.now() - ctx.lastRequest));
    if (ctx.now() - ctx.started + delay >= ctx.budget.deadlineMs) { recordDiagnostic(ctx, details, 'deadline'); ctx.stopped = 'deadline'; throw new Error(ctx.stopped); }
    if (delay) await ctx.sleep(delay);
    ctx.requests++; ctx.lastRequest = ctx.now();
    recordDiagnostic(ctx, details, 'request_start', true, attempt + 1);
    let response;
    try {
      response = await ctx.fetch(frozenUrl, { ...frozenOptions,
        signal: AbortSignal.timeout(Math.max(1, Math.min(ctx.budget.timeoutMs, ctx.budget.deadlineMs - (ctx.now() - ctx.started)))) });
      annotateDiagnostic(ctx, { httpStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null });
      if (response.ok) {
        const data = await response.json();
        annotateDiagnostic(ctx, { branch: 'response_ok' });
        return data;
      }
    } catch (error) {
      annotateDiagnostic(ctx, { branch: response?.ok ? 'decode_exception' : 'fetch_exception', exceptionCategory: exceptionCategory(error) });
      if (attempt === 0 && retry && ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name)) {
        await ctx.sleep(500); continue;
      }
      throw new Error(error instanceof SyntaxError ? 'invalid_json' : 'fetch_failed');
    }
    const status = response.status;
    annotateDiagnostic(ctx, { branch: 'http_error' });
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

function safeNext(current, next, mutable = ['page'], ctx) {
  const before = new URL(current), after = new URL(next, current);
  if (after.origin !== before.origin || after.pathname !== before.pathname || after.username || after.password || after.hash) { annotateDiagnostic(ctx, { branch: 'invalid_next' }); throw new Error('invalid_next'); }
  const frozen = (url) => [...url.searchParams].filter(([key]) => !mutable.includes(key)).sort().map(JSON.stringify).join('|');
  if (frozen(before) !== frozen(after)) { annotateDiagnostic(ctx, { branch: 'changed_query' }); throw new Error('changed_query'); }
  if (!/^\d+$/.test(after.searchParams.get('page') || '') || Number(after.searchParams.get('page')) <= Number(before.searchParams.get('page') || 1)) { annotateDiagnostic(ctx, { branch: 'nonadvancing_next_page' }); throw new Error('pagination_stalled'); }
  return after.toString();
}

async function pages(ctx, initial, { rows, next, options, retry = false, key = identity, diagnostic = {}, pageNumber }) {
  const result = { items: [], pages: 0, complete: false, reason: null };
  const seen = new Set(); let cursor = initial; const cursors = new Set();
  try {
    for (let page = 0; page < ctx.budget.pages; page++) {
      const details = { ...diagnostic, page: pageNumber ? pageNumber(cursor) : page + 1, pageKind: pageNumber ? 'numbered' : 'ordinal' };
      const cursorKey = JSON.stringify(cursor);
      if (cursors.has(cursorKey)) { recordDiagnostic(ctx, details, 'repeated_cursor'); throw new Error('pagination_stalled'); }
      cursors.add(cursorKey);
      const { url, init } = options ? options(cursor) : { url: cursor, init: {} };
      const data = await request(ctx, url, init, retry, details);
      const batch = rows(data);
      if (!Array.isArray(batch)) throw new Error('invalid_shape');
      result.pages++;
      let added = 0; const ids = [];
      for (const item of batch) {
        const id = String(key(item));
        ids.push(id);
        if (!seen.has(id)) { seen.add(id); result.items.push(item); added++; }
      }
      annotateDiagnostic(ctx, { rowCount: batch.length, newIdentityCount: added, identityHash: hash(ids.sort()) });
      if (result.pages > 1 && batch.length && !added) { annotateDiagnostic(ctx, { branch: 'no_new_identities' }); throw new Error('pagination_stalled'); }
      const following = next(data, cursor, batch);
      if (following === null) { result.complete = true; return result; }
      if (!batch.length || !added) { annotateDiagnostic(ctx, { branch: 'empty_page_with_next' }); throw new Error('pagination_stalled'); }
      cursor = following;
    }
    result.reason = 'page_budget';
    recordDiagnostic(ctx, diagnostic, 'page_budget');
  } catch (error) { paginationFailure(ctx, error); result.reason = error.message; }
  return result;
}

// Materialize only attempted searches; wide historical windows must not allocate
// every year/alias/filter combination before a response deadline can take effect.
function searchPlan(length, at) {
  return { length, at, *[Symbol.iterator]() { for (let i = 0; i < length; i++) yield at(i); } };
}

async function searches(ctx, specs, run, details = spec => ({ filter: spec.filter, year: spec.year ?? spec.cycle })) {
  const batches = [];
  const initialRequests = ctx.requests;
  const initialDiagnostic = ctx.diagnosticSequence;
  for (const spec of specs) {
    if (ctx.blocked || ctx.stopped || ctx.requests >= ctx.budget.requests || ctx.now() - ctx.started >= ctx.budget.deadlineMs) {
      recordDiagnostic(ctx, details(spec), ctx.blocked ? 'provider_blocked' : ctx.stopped || (ctx.requests >= ctx.budget.requests ? 'request_budget' : 'deadline'));
      break;
    }
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
    pages: batches.reduce((sum, b) => sum + b.pages, 0), requests, cachedSearches: batches.filter((b) => b.cached).length,
    diagnostics: diagnosticSnapshot(ctx, initialDiagnostic)
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
    return pages(ctx, url.toString(), { rows: (d) => d.results, diagnostic: { filter, year }, pageNumber: current => Number(new URL(current).searchParams.get('page')),
      next: (d, current) => { if (!Object.hasOwn(d, 'next')) throw new Error('missing_pagination'); return d.next ? safeNext(current, d.next, ['page'], ctx) : null; } });
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
    return pages(ctx, {}, { retry: true, rows: (d) => d.results, diagnostic: { filter, year: cycle },
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
        if (JSON.stringify(next) === JSON.stringify(cursor)) { annotateDiagnostic(ctx, { branch: 'nonadvancing_native_cursor' }); throw new Error('pagination_stalled'); }
        return next;
      } });
  });
  result.coverage.scope = 'Schedule A receipts: named donors, reported employers, or explicit committee IDs. Employer affiliation is not an employer donation. PAC affiliation is not inferred from names.';
  result.coverage.cycles = fecCycles(range.startIso, range.endIso);
  result.coverage.nextRequestAt = Math.max(ctx.lastRequest === null ? 0 : ctx.lastRequest + ctx.intervalMs, Date.parse(ctx.retryAt) || 0);
  return result;
}

export async function acquireUsa({ terms, range, runtime }) {
  const ctx = context(runtime, 150);
  return searches(ctx, terms, (term) => pages(ctx, 1, {
    rows: (d) => d.results,
    key: (item) => hash(item),
    diagnostic: { filter: 'keywords' }, pageNumber: page => page,
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
      if (!Number.isInteger(meta.next) || meta.next <= current) { annotateDiagnostic(ctx, { branch: 'nonadvancing_next_page' }); throw new Error('pagination_stalled'); }
      return meta.next;
    }
  }), () => ({ filter: 'keywords' }));
}

export async function acquireSam({ terms, key, runtime }) {
  const ctx = context(runtime, 150);
  if (!key) return { items: [], error: 'missing_key', coverage: { status: 'unavailable', complete: false, reasons: ['missing_key'], pages: 0, requests: 0, diagnostics: diagnosticSnapshot(ctx) } };
  const result = await searches(ctx, terms, async (term) => {
    // Exact query + credential identity; response pages always have size 10, starting at 0.
    const cacheKey = hash([term, key, ctx.budget.pages]);
    const cached = samCache.get(cacheKey);
    if (!runtime?.fetch && cached && ctx.now() - cached.at < 600000) return { ...cached.result, cached: true };
    const base = new URL('https://api.sam.gov/entity-information/v4/entities');
    base.search = new URLSearchParams({ api_key: key, legalBusinessName: term, includeSections: 'entityRegistration,coreData', page: '0', size: '10' });
    const result = await pages(ctx, base.toString(), { rows: (d) => d.entityData, diagnostic: { filter: 'legalBusinessName' }, pageNumber: current => Number(new URL(current).searchParams.get('page')),
      next: (d, current, batch) => {
        if (d.links?.nextLink) {
          // SAM omits the key in links. Validate the complete frozen query before restoring it.
          const next = new URL(d.links.nextLink, current); next.searchParams.set('api_key', key);
          return safeNext(current, next.toString(), ['page'], ctx);
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
  }, () => ({ filter: 'legalBusinessName' }));
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
        !(state.previous === null || typeof state.previous === 'string' && /^[a-f0-9]{64}$/.test(state.previous)) ||
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
    const data = await request(ctx, url, {}, false, { filter: spec.filter, year: spec.year, page: state.page, pageKind: 'numbered' });
    if (!Array.isArray(data.results)) throw new Error('invalid_shape');
    // Return an entire page, including every contribution child. Never rank-slice
    // away records before advancing a cursor. Dedup across pages belongs to caller.
    items = data.results;
    fetched = true;
    const fingerprint = hash(items.map(identity).map(String).sort());
    annotateDiagnostic(ctx, { rowCount: items.length, identityHash: fingerprint });
    if (items.length && fingerprint === state.previous) { annotateDiagnostic(ctx, { branch: 'repeated_page_fingerprint' }); throw new Error('pagination_stalled'); }
    if (!Object.hasOwn(data, 'next')) throw new Error('missing_pagination');
    if (data.next) {
      if (!items.length) { annotateDiagnostic(ctx, { branch: 'empty_page_with_next' }); throw new Error('pagination_stalled'); }
      const following = new URL(safeNext(url, data.next, ['page'], ctx));
      const page = Number(following.searchParams.get('page'));
      if (!Number.isSafeInteger(page)) throw new Error('invalid_next');
      nextState = { ...state, page, previous: fingerprint };
    } else {
      nextState = { ...state, search: state.search + 1, page: 1, previous: null };
    }
  } catch (failure) { paginationFailure(ctx, failure); error = failure.message; }
  nextState.notBefore = Math.max(state.notBefore, ldaNextRequestAt(ctx));
  const complete = !error && nextState.search === specs.length;
  const providerError = error === 'deadline' ? null : error;
  return { source: spec.source, items, error: providerError, retryAfterSeconds: ctx.retryAfterSeconds, retryAt: ctx.retryAt,
    coverage: { status: error ? (fetched || !providerError ? 'partial' : 'unavailable') : 'page', complete: false,
      reasons: error ? [error] : [], pages: fetched ? 1 : 0, requests: ctx.requests,
      scope: 'One LDA provider page; whole filing years, contribution dates filtered where known.', diagnostics: diagnosticSnapshot(ctx) },
    traversal: { complete, searchesPlanned: specs.length, searchesCompleted: nextState.search,
      search: state.search, page: state.page, endpoint: spec.endpoint, filter: spec.filter,
      filingYear: spec.year, term: spec.term, nextRequestAt: nextState.notBefore,
      cursor: complete ? null : encodeLdaCursor(nextState) }
  };
}

// FEC continuation is separate from ranked discovery. The plan and native seek
// state are credential-free; each invocation retains the existing source budget.
export const FEC_TRAVERSAL_ORDER = 'schedule_a:-contribution_receipt_date:sort_hide_null=false:per_page=100:v1';
const stableFecValue = value => Array.isArray(value) ? value.map(stableFecValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableFecValue(value[key])])) : value;
export const fecObservationHash = value => hash(stableFecValue(value));
const encodeFecCursor = state => Buffer.from(JSON.stringify(state)).toString('base64url');
const fecGuard = () => ({ anchor: hash({}), power: 1, distance: 0 });
export function startFecCursor(binding, notBefore = 0, retryAt = null) {
  return encodeFecCursor({ version: 1, binding, search: 0, page: 1, indexes: {}, previous: null,
    guard: fecGuard(), notBefore, retryAt, halted: null });
}
function fecPlan(terms, range) {
  const cycles = fecCycles(range.startIso, range.endIso);
  return searchPlan(cycles.length * terms.length * 2, index => {
    const term = terms[Math.floor(index / 2) % terms.length];
    const filters = /^C\d{8}$/i.test(term) ? ['contributor_id', 'committee_id'] : ['contributor_name', 'contributor_employer'];
    return { cycle: cycles[Math.floor(index / (terms.length * 2))], term, filter: filters[index % 2] };
  });
}
function nativeFecIndexes(value) {
  const allowed = ['last_index', 'last_contribution_receipt_date', 'last_contribution_receipt_amount', 'sort_null_only'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('invalid_cursor');
  const index = value.last_index;
  if (!(typeof index === 'string' && /^\d{1,128}$/.test(index)) && !(Number.isSafeInteger(index) && index >= 0)) throw new Error('invalid_cursor');
  if (Object.hasOwn(value, 'sort_null_only') && typeof value.sort_null_only !== 'boolean') throw new Error('invalid_cursor');
  const date = value.last_contribution_receipt_date;
  if (date != null && typeof date === 'string' && (!Number.isFinite(Date.parse(date)) ? '' : new Date(date.slice(0, 10)).toISOString().slice(0, 10)) !== date.slice(0, 10)) throw new Error('invalid_cursor');
  if (date !== null && date !== undefined && !(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/.test(date) && Number.isFinite(Date.parse(date)))) throw new Error('invalid_cursor');
  if (!Object.hasOwn(value, 'last_contribution_receipt_date') && value.sort_null_only !== true) throw new Error('missing_cursor');
  if (value.sort_null_only === true && date != null) throw new Error('invalid_cursor');
  const amount = value.last_contribution_receipt_amount;
  if (amount != null && (typeof amount !== 'number' || !Number.isFinite(amount))) throw new Error('invalid_cursor');
  const result = { last_index: String(index) };
  if (date != null) result.last_contribution_receipt_date = date;
  if (amount != null) result.last_contribution_receipt_amount = amount;
  if (value.sort_null_only === true || date === null) result.sort_null_only = true;
  else if (value.sort_null_only === false) result.sort_null_only = false;
  return result;
}
const fecHalts = ['pagination_stalled', 'missing_cursor', 'invalid_cursor', 'missing_pagination', 'invalid_shape'];
function readFecCursor(cursor, binding, plan) {
  if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
  const state = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  const keys = ['version', 'binding', 'search', 'page', 'indexes', 'previous', 'guard', 'notBefore', 'retryAt', 'halted'];
  if (!state || Object.keys(state).length !== keys.length || Object.keys(state).some(k => !keys.includes(k)) ||
      state.version !== 1 || state.binding !== binding || !Number.isSafeInteger(state.search) || state.search < 0 || state.search >= plan.length ||
      !Number.isSafeInteger(state.page) || state.page < 1 || !Number.isFinite(state.notBefore) || state.notBefore < 0 ||
      !(state.retryAt === null || Number.isFinite(state.retryAt) && state.retryAt >= 0) ||
      !(state.halted === null || fecHalts.includes(state.halted)) || !(state.previous === null || typeof state.previous === 'string' && /^[a-f0-9]{64}$/.test(state.previous))) throw new Error();
  if (!state.indexes || Array.isArray(state.indexes) || typeof state.indexes !== 'object') throw new Error();
  if (Object.keys(state.indexes).length) {
    if (JSON.stringify(nativeFecIndexes(state.indexes)) !== JSON.stringify(state.indexes) || state.page === 1 || state.previous === null) throw new Error();
  } else if (state.page !== 1 || state.previous !== null) throw new Error();
  const guard = state.guard;
  if (!guard || typeof guard.anchor !== 'string' || Object.keys(guard).sort().join(',') !== 'anchor,distance,power' || !/^[a-f0-9]{64}$/.test(guard.anchor) ||
      !Number.isSafeInteger(guard.power) || guard.power < 1 || !Number.isSafeInteger(guard.distance) || guard.distance < 0 || guard.distance >= guard.power) throw new Error();
  return state;
}

export async function acquireFecPages({ terms, range, binding, cursor, key, runtime }) {
  const plan = fecPlan(terms, range);
  let state;
  try { state = readFecCursor(cursor ?? startFecCursor(binding), binding, plan); }
  catch { return { invalidCursor: true }; }
  const ctx = context(runtime, 150);
  if (state.notBefore) ctx.lastRequest = state.notBefore - ctx.intervalMs;
  const items = [], searched = new Set(); let pagesRead = 0, queryPages = 0, reason = null;
  let seen = new Set(), cursors = new Set();
  if (state.halted) reason = state.halted;
  else if (state.retryAt !== null && state.retryAt > ctx.now()) reason = 'provider_cooldown';
  while (!reason && state.search < plan.length) {
    const spec = plan.at(state.search), details = { filter: spec.filter, year: spec.cycle, page: state.page, pageKind: 'ordinal' };
    if (queryPages >= ctx.budget.pages) { reason = 'page_budget'; recordDiagnostic(ctx, details, reason); break; }
    const currentKey = hash(state.indexes);
    if (cursors.has(currentKey)) { reason = 'pagination_stalled'; state.halted = reason; recordDiagnostic(ctx, details, 'repeated_cursor'); break; }
    cursors.add(currentKey);
    const url = new URL('https://api.open.fec.gov/v1/schedules/schedule_a/');
    url.search = new URLSearchParams({ api_key: key || 'DEMO_KEY', per_page: '100', sort: '-contribution_receipt_date',
      min_date: range.startIso, max_date: range.endIso, two_year_transaction_period: String(spec.cycle), [spec.filter]: spec.term, sort_hide_null: 'false' });
    for (const [name, value] of Object.entries(state.indexes)) url.searchParams.set(name, String(value));
    try {
      const data = await request(ctx, url, {}, true, details);
      searched.add(state.search);
      if (!data || !Array.isArray(data.results) || data.results.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid_shape');
      const batch = data.results; pagesRead++; queryPages++;
      // Preserve everything fetched before any guard. Normalization removes only
      // exact repeated observations in this mode, not changed receipt versions.
      items.push(...batch);
      const ids = batch.map(identity).map(String), fingerprint = hash([...ids].sort());
      const added = ids.filter(id => !seen.has(id)); ids.forEach(id => seen.add(id));
      annotateDiagnostic(ctx, { rowCount: batch.length, newIdentityCount: added.length, identityHash: fingerprint });
      if (batch.length && ((queryPages > 1 && !added.length) || fingerprint === state.previous)) {
        annotateDiagnostic(ctx, { branch: 'no_new_identities' }); throw new Error('pagination_stalled');
      }
      if (!data.pagination || typeof data.pagination !== 'object' || Array.isArray(data.pagination)) throw new Error('missing_pagination');
      if (!batch.length) {
        state = { ...state, search: state.search + 1, page: 1, indexes: {}, previous: null, guard: fecGuard() };
        queryPages = 0; seen = new Set(); cursors = new Set();
        continue;
      }
      if (data.pagination.last_indexes?.last_index == null) throw new Error('missing_cursor');
      const next = nativeFecIndexes(data.pagination.last_indexes), nextKey = hash(next);
      if (nextKey === currentKey || cursors.has(nextKey) || nextKey === state.guard.anchor) {
        annotateDiagnostic(ctx, { branch: nextKey === currentKey ? 'nonadvancing_native_cursor' : 'repeated_cursor' });
        throw new Error('pagination_stalled');
      }
      // Brent's constant-space cycle detector survives serialization without an
      // ever-growing history/total-page cap. Within-call cursor/identity guards
      // remain exact; longer cross-call cycles can require another bounded batch.
      const guard = { ...state.guard, distance: state.guard.distance + 1 };
      if (guard.distance === guard.power) { guard.anchor = nextKey; guard.power = Math.min(Number.MAX_SAFE_INTEGER, guard.power * 2); guard.distance = 0; }
      state = { ...state, indexes: next, page: state.page + 1, previous: fingerprint, guard, retryAt: null };
    } catch (error) {
      paginationFailure(ctx, error); reason = error.message;
      if (fecHalts.includes(reason)) state.halted = reason;
      // Keep the input seek state on failure so the exact unfinished page is
      // replayed. Returned rows may repeat; callers must deduplicate observations.
    }
  }
  const complete = state.search === plan.length;
  state.notBefore = Math.max(state.notBefore, ctx.lastRequest === null ? 0 : ctx.lastRequest + ctx.intervalMs, Date.parse(ctx.retryAt) || 0);
  state.retryAt = Date.parse(ctx.retryAt) || (state.retryAt > ctx.now() ? state.retryAt : null);
  const error = reason && !['page_budget', 'request_budget', 'deadline', 'provider_cooldown'].includes(reason) ? reason : null;
  const blocked = Boolean(state.halted || ctx.blocked || reason === 'provider_cooldown');
  return { items, error, retryAfterSeconds: state.retryAt ? Math.max(0, Math.ceil((state.retryAt - ctx.now()) / 1000)) : ctx.retryAfterSeconds,
    retryAt: state.retryAt ? new Date(state.retryAt).toISOString() : null,
    coverage: { status: complete ? 'complete_for_queries' : (pagesRead || !error ? 'partial' : 'unavailable'), complete,
      reasons: reason ? [reason] : [], pages: pagesRead, requests: ctx.requests, searchesPlanned: plan.length, searchesRun: searched.size,
      scope: 'Bounded Schedule A traversal batch; frozen cycle/filter plan. Completion is query exhaustion, not a snapshot, reconciliation or historical recovery.',
      cycles: fecCycles(range.startIso, range.endIso), diagnostics: diagnosticSnapshot(ctx) },
    traversal: { complete, blocked, requiresRestart: Boolean(state.halted), searchesPlanned: plan.length, searchesCompleted: state.search,
      page: state.page, nextRequestAt: state.notBefore, cursor: complete ? null : encodeFecCursor(state) } };
}
