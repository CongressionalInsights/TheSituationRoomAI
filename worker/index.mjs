import feedsConfig from '../data/feeds.json' assert { type: 'json' };

const appConfig = feedsConfig.app || { defaultRefreshMinutes: 60, userAgent: 'TheSituationRoom/0.1' };
const cache = new Map();
const energyMapCache = { data: null, fetchedAt: 0 };
const geoCache = new Map();
let lastGeocodeAt = 0;
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const FETCH_TIMEOUT_MS = feedsConfig.app?.fetchTimeoutMs || 12000;

function corsHeaders(env = {}) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-OpenAI-Key'
  };
}

function jsonResponse(payload, status = 200, env = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(env)
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

function buildUrl(template, params = {}) {
  let url = template;
  Object.entries(params).forEach(([key, value]) => {
    url = url.replaceAll(`{{${key}}}`, encodeURIComponent(value ?? ''));
  });
  return url;
}

function applyKey(url, feed, key, keyParam, keyHeader) {
  if (!key) return { url, headers: {} };
  const header = keyHeader || feed.keyHeader;
  if (header) {
    return { url, headers: { [header]: key } };
  }
  const param = keyParam || feed.keyParam;
  if (param) {
    const parsed = new URL(url);
    parsed.searchParams.set(param, key);
    return { url: parsed.toString(), headers: {} };
  }
  return { url, headers: {} };
}

function applyProxy(url, proxy) {
  if (!proxy) return url;
  if (proxy === 'allorigins') {
    return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  }
  if (proxy === 'jina') {
    const stripped = url.replace(/^https?:\/\//, '');
    return `https://r.jina.ai/http://${stripped}`;
  }
  return url;
}

function resolveServerKey(feed, env) {
  if (feed.keySource !== 'server') return null;
  if (feed.keyGroup === 'api.data.gov') return env.DATA_GOV;
  if (feed.keyGroup === 'eia') return env.EIA;
  if (feed.keyGroup === 'earthdata') return env.EARTHDATA_NASA;
  if (feed.id === 'openaq-api') return env.OPEN_AQ;
  if (feed.id === 'nasa-firms') return env.NASA_FIRMS;
  return null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallbacks(url, headers, proxies = []) {
  let primaryResponse = null;
  try {
    primaryResponse = await fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);
    if (primaryResponse.ok) return primaryResponse;
  } catch (err) {
    primaryResponse = null;
  }

  const fallbackUrls = [];
  if (url.startsWith('https://')) {
    fallbackUrls.push(`http://${url.slice('https://'.length)}`);
  }
  proxies.forEach((proxy) => {
    fallbackUrls.push(applyProxy(url, proxy));
  });

  let lastResponse = primaryResponse;
  let lastError = null;
  for (const fallbackUrl of fallbackUrls) {
    try {
      const response = await fetchWithTimeout(fallbackUrl, { headers }, FETCH_TIMEOUT_MS);
      if (response.ok) return response;
      lastResponse = lastResponse || response;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResponse) return lastResponse;
  if (lastError) throw lastError;
  throw new Error('fetch_failed');
}

async function fetchFeed(feed, env, { query, force = false, key, keyParam, keyHeader } = {}) {
  const cacheKey = `${feed.id}:${query || ''}`;
  const ttlMs = (feed.ttlMinutes || appConfig.defaultRefreshMinutes) * 60 * 1000;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  if (feed.requiresKey) {
    const serverKey = resolveServerKey(feed, env);
    const effectiveKey = key || serverKey;
    if (!effectiveKey) {
      return {
        id: feed.id,
        fetchedAt: Date.now(),
        contentType: 'application/json',
        body: JSON.stringify({
          error: feed.keySource === 'server' ? 'missing_server_key' : 'requires_key',
          message: feed.keySource === 'server' ? 'Server API key required for this feed.' : 'API key required for this feed.'
        })
      };
    }
  }

  if (feed.requiresConfig && !feed.url) {
    return {
      id: feed.id,
      fetchedAt: Date.now(),
      contentType: 'application/json',
      body: JSON.stringify({ error: 'requires_config', message: 'Feed URL not configured.' })
    };
  }

  const serverKey = resolveServerKey(feed, env);
  const effectiveKey = key || serverKey;
  const finalQuery = feed.supportsQuery ? (query || feed.defaultQuery || '') : undefined;
  const baseUrl = feed.supportsQuery
    ? buildUrl(feed.url, { query: finalQuery, key: effectiveKey })
    : buildUrl(feed.url, { key: effectiveKey });
  const useClientKey = Boolean(key);
  const applied = applyKey(baseUrl, feed, effectiveKey, useClientKey ? keyParam : undefined, useClientKey ? keyHeader : undefined);
  const headers = {
    'User-Agent': appConfig.userAgent,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
  const response = await fetchWithFallbacks(applied.url, { ...headers, ...applied.headers }, proxyList);
  const contentType = response.headers.get('content-type') || 'text/plain';
  const body = await response.text();

  const payload = {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: response.status
  };
  cache.set(cacheKey, payload);
  return payload;
}

async function geocodeQuery(query) {
  const key = query.toLowerCase();
  if (geoCache.has(key)) {
    return { ...geoCache.get(key), cached: true };
  }

  const now = Date.now();
  const delta = now - lastGeocodeAt;
  if (delta < 1100) {
    await new Promise((resolve) => setTimeout(resolve, 1100 - delta));
  }
  lastGeocodeAt = Date.now();

  const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
  geoUrl.searchParams.set('format', 'json');
  geoUrl.searchParams.set('limit', '1');
  geoUrl.searchParams.set('q', query);

  const response = await fetchWithTimeout(geoUrl.toString(), {
    headers: {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }
  }, FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Geocode failed (${response.status})`);
  }

  const data = await response.json();
  const result = data?.[0];
  if (!result) {
    const payload = { query, notFound: true };
    geoCache.set(key, payload);
    return payload;
  }

  const payload = {
    query,
    lat: Number(result.lat),
    lon: Number(result.lon),
    displayName: result.display_name
  };
  geoCache.set(key, payload);
  return payload;
}

async function handleChat(payload, apiKey, env) {
  if (!apiKey) {
    return { status: 401, body: { error: 'missing_api_key', message: 'Provide an OpenAI API key.' } };
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const model = payload.model || env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.2;
  const context = payload.context ? JSON.stringify(payload.context) : '';

  const input = [
    {
      role: 'system',
      content: 'You are the Situation Room assistant. Use only the provided context. Keep responses concise, actionable, and include feed/source names when referencing signals. If data is missing, say so explicitly.'
    }
  ];

  if (context) {
    input.push({
      role: 'system',
      content: `Context snapshot: ${context}`
    });
  }

  input.push(...messages);

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input, temperature })
  });

  const data = await response.json();
  if (!response.ok) {
    return { status: response.status, body: { error: 'openai_error', message: data.error?.message || 'OpenAI request failed.' } };
  }

  const text = data.output_text
    || data.output?.map((item) => item.content?.map((c) => c.text).join('')).join('')
    || '';

  return {
    status: 200,
    body: {
      id: data.id,
      model: data.model,
      text,
      usage: data.usage || null
    }
  };
}

async function fetchEnergyMap(env) {
  if (!env.EIA) {
    return { error: 'missing_server_key', message: 'Server EIA key required for energy map.' };
  }

  const ttlMs = 60 * 60 * 1000;
  if (energyMapCache.data && Date.now() - energyMapCache.fetchedAt < ttlMs) {
    return { data: energyMapCache.data };
  }

  const url = new URL('https://api.eia.gov/v2/electricity/retail-sales/data/');
  url.searchParams.set('api_key', env.EIA);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'price');
  url.searchParams.set('facets[sectorid][]', 'RES');
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('offset', '0');
  url.searchParams.set('length', '200');

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }
  }, FETCH_TIMEOUT_MS);

  if (!response.ok) {
    return { error: 'fetch_failed', message: `EIA energy map request failed (${response.status})` };
  }

  const data = await response.json();
  const rows = Array.isArray(data?.response?.data) ? data.response.data : [];
  const latestByState = {};
  rows.forEach((row) => {
    if (!row.stateid || latestByState[row.stateid]) return;
    const value = Number(row.price);
    if (!Number.isFinite(value)) return;
    latestByState[row.stateid] = {
      value,
      period: row.period,
      state: row.stateDescription || row.stateid
    };
  });
  const values = Object.values(latestByState).map((entry) => entry.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const payload = {
    period: rows[0]?.period || '',
    units: rows[0]?.['price-units'] || 'cents/kWh',
    values: latestByState,
    min,
    max
  };

  energyMapCache.data = payload;
  energyMapCache.fetchedAt = Date.now();
  return { data: payload };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/feeds') {
      return jsonResponse({ app: feedsConfig.app, feeds: feedsConfig.feeds }, 200, env);
    }

    if (url.pathname === '/api/feed') {
      let body = {};
      if (request.method === 'POST') {
        try {
          const raw = await request.text();
          body = JSON.parse(raw || '{}');
        } catch (error) {
          return jsonResponse({ error: 'invalid_json', message: error.message }, 400, env);
        }
      }
      const id = body.id || url.searchParams.get('id');
      const query = body.query || url.searchParams.get('query') || undefined;
      const force = body.force === true || url.searchParams.get('force') === '1';
      const key = body.key || url.searchParams.get('key') || undefined;
      const keyParam = body.keyParam || url.searchParams.get('keyParam') || undefined;
      const keyHeader = body.keyHeader || url.searchParams.get('keyHeader') || undefined;
      const feed = feedsConfig.feeds.find((f) => f.id === id);
      if (!feed) {
        return jsonResponse({ error: 'unknown_feed', id }, 404, env);
      }
      try {
        const payload = await fetchFeed(feed, env, { query, force, key, keyParam, keyHeader });
        return jsonResponse(payload, 200, env);
      } catch (error) {
        const extra = error?.cause?.code || error?.code;
        const message = [error?.message, extra].filter(Boolean).join(' ');
        return jsonResponse({ error: 'fetch_failed', message: message || 'fetch failed' }, 502, env);
      }
    }

    if (url.pathname === '/api/energy-map') {
      try {
        const result = await fetchEnergyMap(env);
        if (result.error) {
          return jsonResponse(result, 200, env);
        }
        return jsonResponse(result.data, 200, env);
      } catch (error) {
        return jsonResponse({ error: 'fetch_failed', message: error.message }, 502, env);
      }
    }

    if (url.pathname === '/api/geocode') {
      const query = url.searchParams.get('q');
      if (!query) {
        return jsonResponse({ error: 'missing_query' }, 400, env);
      }
      try {
        const payload = await geocodeQuery(query);
        return jsonResponse(payload, 200, env);
      } catch (error) {
        return jsonResponse({ error: 'geocode_failed', message: error.message }, 502, env);
      }
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const raw = await request.text();
        const payload = JSON.parse(raw || '{}');
        const apiKey = request.headers.get('x-openai-key') || env.OPENAI_API_KEY || env.OPEN_AI;
        const result = await handleChat(payload, apiKey, env);
        return jsonResponse(result.body, result.status, env);
      } catch (error) {
        return jsonResponse({ error: 'invalid_request', message: error.message }, 400, env);
      }
    }

    if (url.pathname === '/api/snapshot' && request.method === 'POST') {
      const raw = await request.text();
      if (env.SNAPSHOT_KV) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const key = `snapshot-${stamp}.json`;
        await env.SNAPSHOT_KV.put(key, raw);
        return jsonResponse({ saved: true, key }, 200, env);
      }
      return jsonResponse({ saved: false, reason: 'no_kv' }, 200, env);
    }

    return jsonResponse({ error: 'not_found' }, 404, env);
  }
};
