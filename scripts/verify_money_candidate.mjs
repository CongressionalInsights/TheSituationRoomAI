// Finite review allowance, not a product acquisition limit or a release-gate substitute.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const FIXED = Object.freeze({ query: 'CVS Health', entities: Object.freeze(['CVS Health']), start: '2026-01-01', end: '2026-11-03', limit: 120 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const code = value => /^(?:HTTP [1-5]\d\d|missing_key|deadline|page_budget|request_budget|search_budget|fetch_failed|invalid_json|invalid_shape|missing_pagination|pagination_stalled|invalid_next|changed_query)$/.test(value || '') ? value : value ? 'provider_error' : null;
const statuses = new Set(['complete_for_queries', 'partial', 'unavailable', 'not_requested', 'page']);
const sourceNames = ['lda', 'ldaContributions', 'fec', 'sam', 'usaspending'];
function receipt(data, mode) {
  const valid = data?.schemaVersion === 2 && Array.isArray(data.items) && data.summary?.basis === 'returned_rows_only'
    && data.coverage?.status === (mode === 'sample' ? 'discovery_sample' : 'lda_page')
    && data.query === FIXED.query && data.range?.start === FIXED.start && data.range?.end === FIXED.end
    && sourceNames.every(name => statuses.has(data.sources?.[name]?.coverage?.status));
  return { valid, mode, returnedCount: Array.isArray(data?.items) ? data.items.length : null,
    complete: data?.coverage?.complete === true, outputTruncated: data?.coverage?.outputTruncated === true,
    identities: Array.isArray(data?.items) ? data.items.map(item => digest(`${item.source}:${item.sourceId}`)) : [],
    sources: Object.fromEntries(sourceNames.map(name => {
      const source = data?.sources?.[name];
      return [name, { count: number(source?.count), returnedCount: number(source?.returnedCount), error: code(source?.error),
        status: statuses.has(source?.coverage?.status) ? source.coverage.status : 'invalid', complete: source?.coverage?.complete === true,
        pages: number(source?.coverage?.pages), requests: number(source?.coverage?.requests),
        reasons: Array.isArray(source?.coverage?.reasons) ? source.coverage.reasons.map(code) : [], retryAfterSeconds: number(source?.retryAfterSeconds),
        retryAt: Number.isFinite(Date.parse(source?.retryAt)) ? new Date(source.retryAt).toISOString() : null }];
    })) };
}

export async function verifyMoneyCandidate(kind, base, { fetchImpl = globalThis.fetch, sleep = pause, now = Date.now } = {}) {
  const url = new URL(base);
  if (!['mcp', 'feed'].includes(kind) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !new RegExp(`^gha-\\d+-\\d+---situation-room-${kind}-.+\\.run\\.app$`).test(url.hostname)) throw new Error('Expected an isolated candidate origin');
  const report = { kind, request: FIXED, allowance: { aggregate: 1, ldaPages: 3 }, calls: [], status: 'incomplete',
    complete: false, note: 'Finite candidate observations only. Standard release gates are separate; no historical or source-wide completeness claim.' };
  let id = 0;
  const call = async args => {
    const target = new URL(kind === 'mcp' ? '/mcp' : '/api/money-flows', url);
    let init = { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Accept: 'application/json, text/event-stream' } };
    if (kind === 'mcp') init = { ...init, method: 'POST', headers: { ...init.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'money.flows', arguments: args } }) };
    else for (const [key, value] of Object.entries(args)) {
      if (Array.isArray(value)) value.forEach(item => target.searchParams.append(key, item));
      else target.searchParams.set(key === 'query' ? 'q' : key, value);
    }
    const response = await fetchImpl(target.toString(), init);
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = retry === null ? NaN : /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - now()) / 1000);
      report.transport = { httpStatus: response.status, retryAfterSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : null };
      await response.body?.cancel(); throw new Error('candidate_request_failed');
    }
    // Bound transport bytes; never retain unsanitized responses in diagnostics.
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('candidate_response_too_large');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (kind === 'feed') return JSON.parse(text);
    const payloads = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
    const payload = payloads.find(value => value.jsonrpc === '2.0' && value.id === id);
    if (!payload?.result || payload.error || payload.result.isError) throw new Error('candidate_rpc_failed');
    return payload.result.structuredContent;
  };
  try {
    let data = await call(FIXED);
    report.calls.push(receipt(data, 'sample'));
    for (let page = 0; page < 3; page++) {
      if (!report.calls.at(-1).valid) { report.status = 'invalid_contract'; break; }
      const lda = [data.sources.lda, data.sources.ldaContributions];
      if (lda.some(source => source.error)) { report.stopReason = 'lda_provider_error'; break; }
      const next = data.ldaTraversal?.next;
      if (!next) { report.stopReason = 'no_continuation'; break; }
      if (next.query !== FIXED.query || next.start !== FIXED.start || next.end !== FIXED.end || next.mode !== 'lda_pages'
          || JSON.stringify(next.entities) !== JSON.stringify(FIXED.entities) || !/^[A-Za-z0-9_-]{1,2048}$/.test(next.cursor || '')
          || (next.matchMode && next.matchMode !== 'normal') || next.minScore != null) { report.status = 'invalid_continuation'; break; }
      const retryAt = Math.max(0, ...lda.map(source => Date.parse(source.retryAt) || 0), data.ldaTraversal?.nextRequestAt || 0,
        ...lda.map(source => number(source.retryAfterSeconds) === null ? 0 : now() + source.retryAfterSeconds * 1000));
      const delay = Math.max(4100, retryAt - now());
      // Defer long Retry-After windows instead of retrying or blocking this finite check.
      if (delay > 55000) { report.stopReason = 'retry_after_deferred'; break; }
      await sleep(delay);
      data = await call({ ...FIXED, mode: 'lda_pages', matchMode: 'normal', cursor: next.cursor });
      report.calls.push(receipt(data, 'lda_pages'));
    }
    if (!report.calls.at(-1).valid) report.status = 'invalid_contract';
    report.ldaTraversalComplete = data?.ldaTraversal?.complete === true;
  } catch { report.status = 'request_failed'; }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await verifyMoneyCandidate(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'incomplete') process.exitCode = 1;
  } catch { console.log(JSON.stringify({ status: 'invalid_candidate_origin' })); process.exitCode = 1; }
}
