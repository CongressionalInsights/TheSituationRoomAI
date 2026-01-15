import http from 'http';

const PORT = process.env.PORT || 8080;
const OPENSKY_BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const CLIENT_ID = process.env.OPENSKY_CLIENTID;
const CLIENT_SECRET = process.env.OPENSKY_CLIENTSECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://congressionalinsights.github.io,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

let tokenCache = null;
let tokenExpiresAt = 0;
let tokenInFlight = null;

function setCors(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin', allowed || ALLOWED_ORIGINS[0] || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload, origin) {
  setCors(res, origin);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  if (tokenCache && Date.now() < tokenExpiresAt) return tokenCache;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
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
  })();

  return tokenInFlight;
}

function resolveEndpoint(pathname) {
  if (pathname === '/api/opensky/states') return '/states/all';
  if (pathname === '/api/opensky/tracks') return '/tracks';
  if (pathname === '/api/opensky/flights/aircraft') return '/flights/aircraft';
  if (pathname === '/api/opensky/flights/arrival') return '/flights/arrival';
  if (pathname === '/api/opensky/flights/departure') return '/flights/departure';
  if (pathname === '/api/opensky/flights/all') return '/flights/all';
  return null;
}

async function proxyOpenSky(req, res, origin) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const endpoint = resolveEndpoint(url.pathname);
  if (!endpoint) {
    return sendJson(res, 404, { error: 'not_found' }, origin);
  }
  const token = await getToken();
  if (!token) {
    return sendJson(res, 401, { error: 'missing_api_key', message: 'OpenSky credentials missing.' }, origin);
  }
  const upstream = `${OPENSKY_BASE}${endpoint}${url.search}`;
  try {
    const response = await fetch(upstream, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    const body = await response.text();
    setCors(res, origin);
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch (err) {
    sendJson(res, 500, { error: 'proxy_error', message: err.message || 'OpenSky proxy error.' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true }, origin);
  }

  if (req.method === 'GET' && req.url.startsWith('/api/opensky/')) {
    return proxyOpenSky(req, res, origin);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

server.listen(PORT, () => {
  console.log(`OpenSky proxy listening on ${PORT}`);
});
