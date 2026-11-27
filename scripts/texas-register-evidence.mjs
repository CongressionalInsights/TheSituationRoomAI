import { officialSearchUrl, pagesIssueUrl, parsePagesIssue } from '../gcp/state-connector/adapters/tx-search-issue.js';

export const searchUrl = officialSearchUrl;
export const schema = 'tsr-texas-register-search/v1';
export const shiftDate = (date, offset) => new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

export function isDate(date) {
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

export function searchWindow(now) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return { start: shiftDate(day, -8), end: shiftDate(day, 1) };
}

export function newestObserved({ start, end }, result) {
  const dates = result?.issueDates;
  if (!Array.isArray(dates) || !dates.length || dates.length > 20 || result?.officialRowCount !== dates.length
    || dates.some(date => !isDate(date) || date < start || date > end)) return null;
  return dates.reduce((latest, date) => date > latest ? date : latest);
}

export async function discoverIssue(window, readSearch) {
  const issue = await readSearch(window);
  const issueDate = newestObserved(window, issue);
  if (!issueDate) return null;
  if (issueDate === window.end) return { issueDate, latestProof: 'upper_bound_row', sampleRows: issue.issueDates.length };

  const newerWindow = { start: shiftDate(issueDate, 1), end: window.end };
  const newer = await readSearch(newerWindow);
  const latest = newestObserved(newerWindow, newer);
  if (latest === window.end) return { issueDate: latest, latestProof: 'upper_bound_row', sampleRows: newer.issueDates.length };
  if (newer?.explicitEmpty === true && newer?.issueDates?.length === 0 && newer?.officialRowCount === 0) {
    return { issueDate, latestProof: 'explicit_empty_newer_window', sampleRows: issue.issueDates.length };
  }
  return null;
}

export async function readPublishedIssue(fetchImpl = fetch) {
  const response = await fetchImpl(pagesIssueUrl, {
    redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
  });
  if (!response.ok || response.redirected || !response.body) {
    void response.body?.cancel().catch(() => {});
    return '';
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 4096) return '';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function retainVerifiedIssue(failure, readPrevious, clock) {
  try {
    const previousBody = await readPrevious();
    if (!parsePagesIssue(previousBody, clock())) return failure;
    const { sourceSha, observedAt, window, issueDate, latestProof, sampleRows } = JSON.parse(previousBody);
    return {
      schema, sourceUrl: searchUrl, sourceSha, observedAt, window, issueDate, latestProof, sampleRows,
      status: 'available', observationStatus: 'retained',
      acquisition: { status: 'failed', reason: failure.reason, attemptedAt: failure.observedAt, sourceSha: failure.sourceSha }
    };
  } catch {
    return failure;
  }
}

export async function observeIssue({ now, sourceSha, readSearch, readPrevious, clock = Date.now }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('invalid source commit');
  const window = searchWindow(now);
  const envelope = { schema, sourceUrl: searchUrl, sourceSha, observedAt: now.toISOString(), window };
  try {
    const issue = await discoverIssue(window, readSearch);
    if (issue) return { ...envelope, status: 'available', ...issue };
  } catch {
    const failure = { ...envelope, status: 'unavailable', reason: 'search_read_failed' };
    return readPrevious ? retainVerifiedIssue(failure, readPrevious, clock) : failure;
  }
  return { ...envelope, status: 'unavailable', reason: 'current_issue_unverified' };
}
