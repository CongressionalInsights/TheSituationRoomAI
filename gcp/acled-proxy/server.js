import http from 'http';

const PORT = process.env.PORT || 8080;
const ACLED_NAME = process.env.ACLED_NAME;
const ACLED_PASS = process.env.ACLED_PASS;
const DEFAULT_LOOKBACK_DAYS = Number(process.env.ACLED_LOOKBACK_DAYS || 30);
const TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_ENDPOINT = 'https://acleddata.com/api/acled/read';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://congressionalinsights.github.io,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

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

function formatIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

async function requestToken(params) {
  const body = new URLSearchParams(params);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `token_error_${response.status}`);
  }
  return response.json();
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  if (refreshToken) {
    try {
      const refreshed = await requestToken({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        client_id: 'acled'
      });
      accessToken = refreshed.access_token || null;
      refreshToken = refreshed.refresh_token || refreshToken;
      const ttl = Number(refreshed.expires_in) || 86400;
      tokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
      if (accessToken) return accessToken;
    } catch (err) {
      // fall through to password grant
    }
  }
  if (!ACLED_NAME || !ACLED_PASS) {
    throw new Error('missing_acled_credentials');
  }
  const token = await requestToken({
    username: ACLED_NAME,
    password: ACLED_PASS,
    grant_type: 'password',
    client_id: 'acled'
  });
  accessToken = token.access_token || null;
  refreshToken = token.refresh_token || null;
  const ttl = Number(token.expires_in) || 86400;
  tokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
  if (!accessToken) throw new Error('missing_access_token');
  return accessToken;
}

function buildAcledUrl(params) {
  const query = new URLSearchParams();
  query.set('_format', 'json');
  if (params.limit) query.set('limit', params.limit);
  if (params.page) query.set('page', params.page);
  if (params.country) query.set('country', params.country);
  if (params.event_date) query.set('event_date', params.event_date);
  if (params.fields) query.set('fields', params.fields);
  return `${ACLED_ENDPOINT}?${query.toString()}`;
}

async function handleEvents(req, res) {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const country = url.searchParams.get('country');
  const limit = url.searchParams.get('limit') || '500';
  const page = url.searchParams.get('page');

  const event_date = start && end ? `${start}|${end}` : (start || end || '');
  const fields = url.searchParams.get('fields') || [
    'event_id_cnty',
    'event_date',
    'disorder_type',
    'event_type',
    'sub_event_type',
    'actor1',
    'actor2',
    'fatalities',
    'latitude',
    'longitude',
    'country',
    'admin1',
    'admin2',
    'location',
    'notes',
    'source'
  ].join('|');

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    return sendJson(res, 401, { error: 'auth_error', message: err.message }, origin);
  }

  const apiUrl = buildAcledUrl({
    limit,
    page,
    country: country || '',
    event_date: event_date || '',
    fields
  });

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      return sendJson(res, response.status, { error: 'acled_error', message: text || 'ACLED request failed.' }, origin);
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      return sendJson(res, 500, { error: 'parse_error', message: 'Invalid ACLED response.' }, origin);
    }
    if (payload?.count === 0 && Array.isArray(payload?.data) && payload.data.length === 0) {
      const recency = payload?.data_query_restrictions?.date_recency?.date;
      if (recency && (!event_date || !event_date.includes(recency))) {
        const recencyEnd = new Date(recency);
        if (!Number.isNaN(recencyEnd.getTime())) {
          const recencyStart = new Date(recencyEnd);
          recencyStart.setDate(recencyEnd.getDate() - DEFAULT_LOOKBACK_DAYS);
          const fallbackEventDate = `${formatIsoDate(recencyStart)}|${formatIsoDate(recencyEnd)}`;
          const fallbackUrl = buildAcledUrl({
            limit,
            page,
            country: country || '',
            event_date: fallbackEventDate,
            fields
          });
          if (fallbackUrl && fallbackUrl !== apiUrl) {
            const fallbackResponse = await fetch(fallbackUrl, {
              headers: { Authorization: `Bearer ${token}` }
            });
            const fallbackText = await fallbackResponse.text();
            if (fallbackResponse.ok) {
              try {
                const fallbackPayload = JSON.parse(fallbackText);
                fallbackPayload.acled_lag_date = recency;
                return sendJson(res, 200, fallbackPayload, origin);
              } catch (err) {
                // ignore parse errors and return original payload
              }
            }
          }
        }
      }
    }
    return sendJson(res, 200, payload, origin);
  } catch (err) {
    return sendJson(res, 500, { error: 'proxy_error', message: err.message || 'Proxy error' }, origin);
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

  if (req.url?.startsWith('/api/acled/events')) {
    return handleEvents(req, res);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

server.listen(PORT, () => {
  console.log(`ACLED proxy listening on ${PORT}`);
});
