const DEFAULT_STATES_BBOX = {
  lamin: '46.5',
  lamax: '49.9',
  lomin: '-1.4',
  lomax: '6.8'
};

function applyDefaultStatesBbox(pathname, requestedUrl) {
  const boundedUrl = new URL(requestedUrl.toString());
  if (pathname !== '/api/opensky/states') return boundedUrl;
  for (const [key, value] of Object.entries(DEFAULT_STATES_BBOX)) {
    if (!boundedUrl.searchParams.get(key)) boundedUrl.searchParams.set(key, value);
  }
  return boundedUrl;
}

function buildOpenSkyRequestCandidates({ pathname, requestedUrl, token, timeouts }) {
  const boundedUrl = applyDefaultStatesBbox(pathname, requestedUrl);
  const candidates = [
    {
      label: 'bounded-anonymous',
      targetUrl: boundedUrl.toString(),
      headers: {},
      timeoutMs: timeouts.bounded
    },
    {
      label: 'requested-anonymous',
      targetUrl: requestedUrl.toString(),
      headers: {},
      timeoutMs: timeouts.requested
    }
  ];
  if (token) {
    candidates.push({
      label: 'bounded-authenticated',
      targetUrl: boundedUrl.toString(),
      headers: {
        Authorization: `Bearer ${token}`
      },
      timeoutMs: timeouts.auth
    });
    candidates.push({
      label: 'requested-authenticated',
      targetUrl: requestedUrl.toString(),
      headers: {
        Authorization: `Bearer ${token}`
      },
      timeoutMs: timeouts.auth
    });
  }
  return candidates;
}

export {
  DEFAULT_STATES_BBOX,
  applyDefaultStatesBbox,
  buildOpenSkyRequestCandidates
};
