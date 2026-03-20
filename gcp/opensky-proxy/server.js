import http from 'http';

const PORT = process.env.PORT || 8080;
const OPENSKY_BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const DEFAULT_STATES_BBOX = {
  lamin: '46.5',
  lamax: '49.9',
  lomin: '-1.4',
  lomax: '6.8'
};

function buildConfig(env = process.env) {
  return {
    clientId: env.OPENSKY_CLIENTID,
    clientSecret: env.OPENSKY_CLIENTSECRET,
    allowedOrigins: (env.ALLOWED_ORIGINS || 'https://congressionalinsights.github.io,http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    tokenTimeoutMs: Number(env.OPENSKY_TOKEN_TIMEOUT_MS || 4000),
    boundedTimeoutMs: Number(env.OPENSKY_BOUNDED_TIMEOUT_MS || 5000),
    requestedTimeoutMs: Number(env.OPENSKY_REQUESTED_TIMEOUT_MS || 5000),
    authTimeoutMs: Number(env.OPENSKY_AUTH_TIMEOUT_MS || 6000)
  };
}

function setCors(res, origin, allowedOrigins) {
  const allowed = allowedOrigins.includes(origin) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin', allowed || allowedOrigins[0] || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function logRequest(req, res, start) {
  const status = res.statusCode || 0;
  const log = {
    severity: status >= 500 ? 'ERROR' : 'INFO',
    message: 'request',
    method: req.method,
    path: req.url,
    status,
    durationMs: Date.now() - start
  };
  console.log(JSON.stringify(log));
}

function sendJson(res, status, payload, origin, allowedOrigins) {
  setCors(res, origin, allowedOrigins);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function logUpstreamAttempt(logger, attempt) {
  logger.log(JSON.stringify({
    severity: attempt.ok ? 'INFO' : 'ERROR',
    message: 'opensky_upstream_attempt',
    ...attempt
  }));
}

function buildErrorDetails(error, timeoutMs = 0) {
  const message = error?.message || 'fetch failed';
  const code = error?.code || error?.cause?.code || null;
  const timedOut = message === 'This operation was aborted' || code === 'ABORT_ERR';
  return {
    error: timedOut ? `timeout after ${timeoutMs}ms` : message,
    code: timedOut ? 'TIMEOUT' : code,
    timedOut
  };
}

async function fetchWithTimeout(fetchImpl, targetUrl, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(targetUrl, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function resolveEndpoint(pathname) {
  if (pathname === '/api/opensky/states') return '/states/all';
  if (pathname === '/api/opensky/tracks') return '/tracks/all';
  if (pathname === '/api/opensky/flights/aircraft') return '/flights/aircraft';
  if (pathname === '/api/opensky/flights/arrival') return '/flights/arrival';
  if (pathname === '/api/opensky/flights/departure') return '/flights/departure';
  if (pathname === '/api/opensky/flights/all') return '/flights/all';
  return null;
}

export function createOpenSkyServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  const config = buildConfig(env);
  const {
    clientId,
    clientSecret,
    allowedOrigins,
    tokenTimeoutMs,
    boundedTimeoutMs,
    requestedTimeoutMs,
    authTimeoutMs
  } = config;

  let tokenCache = null;
  let tokenExpiresAt = 0;
  let tokenInFlight = null;

  async function getToken() {
    if (!clientId || !clientSecret) return null;
    if (tokenCache && Date.now() < tokenExpiresAt) return tokenCache;
    if (tokenInFlight) return tokenInFlight;

    tokenInFlight = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret
        });
        const response = await fetchWithTimeout(fetchImpl, TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        }, tokenTimeoutMs);
        if (!response.ok) {
          tokenInFlight = null;
          return null;
        }
        const data = await response.json();
        if (!data?.access_token) {
          tokenInFlight = null;
          return null;
        }
        const ttl = Number(data.expires_in) || 1800;
        tokenCache = data.access_token;
        tokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
        tokenInFlight = null;
        return tokenCache;
      } catch (error) {
        const details = buildErrorDetails(error, tokenTimeoutMs);
        logger.log(JSON.stringify({
          severity: 'ERROR',
          message: 'opensky_token_fetch_failed',
          timeoutMs: tokenTimeoutMs,
          ...details
        }));
        tokenInFlight = null;
        return null;
      }
    })();
    return tokenInFlight;
  }

  async function proxyOpenSky(req, res, origin) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const endpoint = resolveEndpoint(url.pathname);
    if (!endpoint) {
      return sendJson(res, 404, { error: 'not_found' }, origin, allowedOrigins);
    }
    const requestedUrl = new URL(`${OPENSKY_BASE}${endpoint}${url.search}`);
    const boundedUrl = new URL(requestedUrl.toString());
    if (url.pathname === '/api/opensky/states') {
      for (const [key, value] of Object.entries(DEFAULT_STATES_BBOX)) {
        if (!boundedUrl.searchParams.get(key)) boundedUrl.searchParams.set(key, value);
      }
    }

    async function fetchUpstream(targetUrl, headers, timeoutMs) {
      return fetchWithTimeout(fetchImpl, targetUrl, {
        headers: {
          'Accept': 'application/json',
          ...headers
        }
      }, timeoutMs);
    }

    try {
      const token = await getToken();
      const attempts = [];
      const candidates = [
        {
          label: 'bounded-anonymous',
          targetUrl: boundedUrl.toString(),
          headers: {},
          timeoutMs: boundedTimeoutMs
        },
        {
          label: 'requested-anonymous',
          targetUrl: requestedUrl.toString(),
          headers: {},
          timeoutMs: requestedTimeoutMs
        }
      ];
      if (token) {
        candidates.push({
          label: 'requested-authenticated',
          targetUrl: requestedUrl.toString(),
          headers: {
            'Authorization': `Bearer ${token}`
          },
          timeoutMs: authTimeoutMs
        });
      }

      let response = null;
      let selectedAttempt = null;
      for (const candidate of candidates) {
        const startedAt = Date.now();
        try {
          const attemptResponse = await fetchUpstream(candidate.targetUrl, candidate.headers, candidate.timeoutMs);
          const attemptInfo = {
            label: candidate.label,
            targetUrl: candidate.targetUrl,
            authenticated: Boolean(candidate.headers.Authorization),
            timeoutMs: candidate.timeoutMs,
            durationMs: Date.now() - startedAt,
            status: attemptResponse.status,
            ok: attemptResponse.ok
          };
          attempts.push(attemptInfo);
          logUpstreamAttempt(logger, attemptInfo);
          if (attemptResponse.ok) {
            response = attemptResponse;
            selectedAttempt = attemptInfo;
            break;
          }
        } catch (error) {
          const details = buildErrorDetails(error, candidate.timeoutMs);
          const attemptInfo = {
            label: candidate.label,
            targetUrl: candidate.targetUrl,
            authenticated: Boolean(candidate.headers.Authorization),
            timeoutMs: candidate.timeoutMs,
            durationMs: Date.now() - startedAt,
            ok: false,
            ...details
          };
          attempts.push(attemptInfo);
          logUpstreamAttempt(logger, attemptInfo);
        }
      }
      if (!response) {
        return sendJson(res, 502, {
          error: 'proxy_error',
          message: 'OpenSky upstream fetch failed.',
          attempts
        }, origin, allowedOrigins);
      }
      const body = await response.text();
      setCors(res, origin, allowedOrigins);
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-OpenSky-Upstream-Attempt': selectedAttempt?.label || 'unknown'
      });
      res.end(body);
    } catch (err) {
      sendJson(res, 500, { error: 'proxy_error', message: err.message || 'OpenSky proxy error.' }, origin, allowedOrigins);
    }
  }

  return http.createServer(async (req, res) => {
    const start = Date.now();
    res.on('finish', () => logRequest(req, res, start));
    const origin = req.headers.origin || '';
    if (req.method === 'OPTIONS') {
      setCors(res, origin, allowedOrigins);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      return sendJson(res, 200, { ok: true }, origin, allowedOrigins);
    }

    if (req.method === 'GET' && req.url.startsWith('/api/opensky/')) {
      return proxyOpenSky(req, res, origin);
    }

    return sendJson(res, 404, { error: 'not_found' }, origin, allowedOrigins);
  });
}

const server = createOpenSkyServer();

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  server.listen(PORT, () => {
    console.log(`OpenSky proxy listening on ${PORT}`);
  });
}
