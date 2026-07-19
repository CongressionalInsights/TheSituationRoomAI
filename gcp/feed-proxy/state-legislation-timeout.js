export const STATE_LEGISLATION_SCOPED_TIMEOUT_MS = 45000;

export function isStateLegislationScopedRequest(feed, params = {}) {
  return feed?.id === 'state-legislation' && Boolean(params.jurisdiction || params.q);
}

export async function fetchStateLegislationScoped(url, {
  headers = {},
  timeoutMs = STATE_LEGISLATION_SCOPED_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { response: await fetchImpl(url, { headers, signal: controller.signal }), timedOut: false };
  } catch (error) {
    return { response: null, timedOut: error?.name === 'AbortError', error };
  } finally {
    clearTimeout(timer);
  }
}

export function buildStateLegislationTimeoutPayload(feed, timeoutMs) {
  const message = `State legislation upstream did not respond within ${timeoutMs}ms.`;
  return {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType: 'application/json',
    httpStatus: 504,
    error: 'upstream_timeout',
    message,
    body: JSON.stringify({ error: 'upstream_timeout', message })
  };
}
