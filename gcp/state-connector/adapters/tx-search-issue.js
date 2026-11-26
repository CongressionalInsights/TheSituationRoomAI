export const pagesIssueUrl = 'https://congressionalinsights.github.io/TheSituationRoomAI/data/feeds/texas-register-current-issue.json';
export const officialSearchUrl = 'https://texas-sos.appianportalsgov.com/rules-and-meetings?interface=SEARCH_TEXAS_REGISTER';
const maxObservationAge = 3 * 60 * 60 * 1000;
const centralDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
});
const offset = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

function validDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function parsePagesIssue(body, now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || raw.schema !== 'tsr-texas-register-search/v1' || raw.status !== 'available'
    || raw.sourceUrl !== officialSearchUrl || typeof raw.sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(raw.sourceSha)
    || !Number.isInteger(raw.sampleRows) || raw.sampleRows < 1 || raw.sampleRows > 20 || !validDate(raw.issueDate)) return null;
  if (typeof raw.observedAt !== 'string') return null;
  const observed = Date.parse(raw.observedAt);
  if (!Number.isFinite(observed) || raw.observedAt !== new Date(observed).toISOString()
    || observed > now || now - observed > maxObservationAge) return null;
  const day = centralDay.format(observed);
  if (raw.window?.start !== offset(day, -8) || raw.window?.end !== offset(day, 1)) return null;
  if (raw.issueDate < raw.window.start || raw.issueDate > raw.window.end
    || raw.issueDate < offset(centralDay.format(now), -8)) return null;
  const proof = raw.issueDate === raw.window.end ? 'upper_bound_row' : 'explicit_empty_newer_window';
  return raw.latestProof === proof ? raw.issueDate : null;
}
