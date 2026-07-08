import http from 'http';
import { pathToFileURL } from 'url';
import { adaptersForState } from './adapters/index.js';
import { coveredStates, SIGNAL_TYPES } from './constants.js';
import { parseSignalsRequest, signalFetchStatus, sortAndLimitSignals } from './request.js';

const PORT = process.env.PORT || 8080;
const API_KEY = String(process.env.API_KEY || '').trim();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const USER_AGENT = process.env.USER_AGENT || 'TheSituationRoomStateConnector/0.1 (+https://congressionalinsights.github.io/TheSituationRoomAI)';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((value) => value.trim()).filter(Boolean);

const upstreamCache = new Map();
const upstreamHeadCache = new Map();

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
    ? (origin || '*')
    : ALLOWED_ORIGINS[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

function sendJson(req, res, status, payload) {
  setCors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  if (!API_KEY) return false;
  return String(req.headers['x-api-key'] || '').trim() === API_KEY;
}

async function fetchText(url) {
  const cached = upstreamCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.text;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, text/html, application/xhtml+xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    upstreamCache.set(url, { fetchedAt: Date.now(), text });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHead(url) {
  const cached = upstreamHeadCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.metadata;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const metadata = {
      url: response.url || url,
      lastModified: response.headers.get('last-modified') || '',
      contentType: response.headers.get('content-type') || ''
    };
    upstreamHeadCache.set(url, { fetchedAt: Date.now(), metadata });
    return metadata;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSignals({ signalType, state, limit }) {
  const selectedAdapters = adaptersForState(state);
  const results = [];
  const errors = [];
  await Promise.all(selectedAdapters.map(async (adapter) => {
    try {
      const rows = signalType === 'executive_order'
        ? await adapter.fetchExecutiveOrders({ fetchText, fetchHead })
        : await adapter.fetchRulemaking({ fetchText, fetchHead });
      rows.forEach((row) => {
        if (row?.signalType === signalType) results.push(row);
      });
    } catch (error) {
      errors.push({
        state: adapter.state,
        message: error?.message || 'adapter_failed'
      });
    }
  }));
  return {
    results: sortAndLimitSignals(results, limit),
    errors,
    adapterCount: selectedAdapters.length
  };
}

async function handleSignals(req, res, url) {
  if (!isAuthorized(req)) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  const request = parseSignalsRequest(url);
  if (!SIGNAL_TYPES.has(request.signalType)) {
    sendJson(req, res, 400, { error: 'invalid_signal_type', allowed: [...SIGNAL_TYPES] });
    return;
  }
  if (request.state && !coveredStates.includes(request.state)) {
    sendJson(req, res, 400, { error: 'state_not_covered', state: request.state, coveredStates });
    return;
  }
  if (request.sort && request.sort !== 'updated_desc') {
    sendJson(req, res, 400, { error: 'invalid_sort', allowed: ['updated_desc'] });
    return;
  }

  const { results, errors, adapterCount } = await fetchSignals(request);
  const status = signalFetchStatus({ adapterCount, resultCount: results.length, errorCount: errors.length });
  sendJson(req, res, status, {
    ...(status >= 500 ? { error: 'upstream_unavailable', message: 'State connector adapters failed.' } : {}),
    results,
    meta: {
      coveredStates,
      generatedAt: new Date().toISOString(),
      signalType: request.signalType,
      state: request.state || null,
      count: results.length,
      partial: errors.length > 0,
      adapterCount,
      errors
    }
  });
}

export async function handleRequest(req, res) {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') {
      setCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(req, res, 200, { ok: true, coveredStates });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/signals') {
      await handleSignals(req, res, url);
      return;
    }
    sendJson(req, res, 404, { error: 'not_found' });
  } catch (error) {
    sendJson(req, res, 500, { error: 'server_error', message: error?.message || 'Unknown error' });
  } finally {
    console.log(JSON.stringify({
      severity: res.statusCode >= 500 ? 'ERROR' : 'INFO',
      message: 'request',
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      durationMs: Date.now() - started
    }));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(JSON.stringify({ severity: 'INFO', message: 'state connector listening', port: PORT, coveredStates }));
  });
}
