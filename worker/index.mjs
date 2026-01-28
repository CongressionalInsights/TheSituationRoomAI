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

const MONEY_FLOW_DEFAULT_DAYS = 180;
const MONEY_FLOW_MAX_LIMIT = 120;

function parseDateParam(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatIsoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function resolveMoneyFlowRange(start, end, fallbackDays = MONEY_FLOW_DEFAULT_DAYS) {
  const endDate = parseDateParam(end) || new Date();
  const startDate = parseDateParam(start)
    || new Date(endDate.getTime() - fallbackDays * 24 * 60 * 60 * 1000);
  if (startDate > endDate) {
    return resolveMoneyFlowRange(end, start, fallbackDays);
  }
  const years = new Set([endDate.getFullYear(), startDate.getFullYear()]);
  return {
    startDate,
    endDate,
    startIso: formatIsoDay(startDate),
    endIso: formatIsoDay(endDate),
    years: [...years]
  };
}

function normalizeEntityName(value) {
  if (!value) return '';
  return String(value)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesQuery(query, ...fields) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => String(field || '').toLowerCase().includes(needle));
}

function scoreMoneyItem(item) {
  let score = 0;
  const amount = Number.isFinite(item.amount) ? item.amount : 0;
  if (amount > 0) {
    score += Math.min(50, Math.log10(amount + 1) * 15);
  }
  const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
  if (publishedAt && !Number.isNaN(publishedAt.getTime())) {
    const ageDays = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 30) score += 20;
    else if (ageDays <= 90) score += 12;
    else if (ageDays <= 180) score += 6;
  }
  const sourceBoost = {
    'LDA': 18,
    'USAspending': 20,
    'OpenFEC': 20,
    'SAM.gov': 10
  };
  score += sourceBoost[item.source] || 8;
  if (item.type && /registration|filing/i.test(item.type)) score += 4;
  if (item.type && /contribution|donation/i.test(item.type)) score += 6;
  return Math.round(Math.min(100, score));
}

function summarizeMoneyEntities(items) {
  const totals = new Map();
  items.forEach((item) => {
    const name = normalizeEntityName(item.entity || item.recipient || item.committee || item.contributor || '');
    if (!name) return;
    const current = totals.get(name) || { name, amount: 0, count: 0, sample: item.entity || item.recipient || item.committee || item.contributor };
    current.count += 1;
    if (Number.isFinite(item.amount)) current.amount += item.amount;
    totals.set(name, current);
  });
  return [...totals.values()]
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 8);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, data, text };
}

async function fetchMoneyFlows({ query, start, end, limit }, env) {
  if (!query) {
    return { error: 'missing_query', message: 'Query parameter q is required.' };
  }
  const safeLimit = Math.min(MONEY_FLOW_MAX_LIMIT, Math.max(20, Number(limit) || 60));
  const perSourceLimit = Math.max(10, Math.floor(safeLimit / 4));
  const range = resolveMoneyFlowRange(start, end);
  const dataGovKey = env.DATA_GOV || '';
  const fecKey = dataGovKey || 'DEMO_KEY';

  const results = {
    query,
    range: { start: range.startIso, end: range.endIso },
    generatedAt: new Date().toISOString(),
    sources: {},
    items: [],
    entities: [],
    summary: null
  };

  const ldaTasks = range.years.map(async (year) => {
    const url = `https://lda.senate.gov/api/v1/filings/?filing_year=${encodeURIComponent(year)}`;
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'application/json' }
    });
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    const items = (data.results || []).filter((item) => matchesQuery(query,
      item.client?.name,
      item.registrant?.name,
      item.lobbying_activities?.map((act) => act.description).join(' ')
    ));
    return { items };
  });

  const ldaContribTasks = range.years.map(async (year) => {
    const url = `https://lda.senate.gov/api/v1/contributions/?filing_year=${encodeURIComponent(year)}`;
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'application/json' }
    });
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    const items = (data.results || []).filter((item) => matchesQuery(query,
      item.registrant?.name,
      item.lobbyist?.last_name,
      item.contribution_items?.map((entry) => `${entry.contributor_name} ${entry.payee_name}`).join(' ')
    ));
    return { items };
  });

  const usaTask = (async () => {
    const url = 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/';
    const awardCodes = ['A', 'B', 'C', 'D', 'IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'];
    const payload = {
      filters: {
        keywords: [query],
        time_period: [{ start_date: range.startIso, end_date: range.endIso }],
        award_type_codes: awardCodes
      },
      fields: ['Recipient Name', 'Award ID', 'Action Date', 'Transaction Amount', 'Awarding Agency', 'Transaction Description'],
      limit: perSourceLimit,
      page: 1,
      sort: 'Action Date',
      order: 'desc'
    };
    const { response, data } = await fetchJsonWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': appConfig.userAgent },
      body: JSON.stringify(payload)
    });
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    return { items: data.results || [] };
  })();

  const fecTask = (async () => {
    const url = new URL('https://api.open.fec.gov/v1/schedules/schedule_a/');
    url.searchParams.set('api_key', fecKey);
    url.searchParams.set('per_page', String(perSourceLimit));
    url.searchParams.set('sort', '-contribution_receipt_amount');
    url.searchParams.set('contributor_name', query);
    url.searchParams.set('min_date', range.startIso);
    url.searchParams.set('max_date', range.endIso);
    const { response, data } = await fetchJsonWithTimeout(url.toString(), {
      headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'application/json' }
    });
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    return { items: data.results || [] };
  })();

  const samTask = (async () => {
    if (!dataGovKey) return { error: 'missing_key' };
    const url = new URL('https://api.sam.gov/entity-information/v4/entities');
    url.searchParams.set('api_key', dataGovKey);
    url.searchParams.set('q', query);
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', String(perSourceLimit));
    const { response, data } = await fetchJsonWithTimeout(url.toString(), {
      headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'application/json' }
    });
    if (!response.ok || !data) {
      return { error: `HTTP ${response.status}` };
    }
    const items = data?.entityData || data?.entities || data?.data || data?.results || [];
    return { items };
  })();

  const [lda, ldaContrib, usa, fec, sam] = await Promise.allSettled([
    Promise.all(ldaTasks),
    Promise.all(ldaContribTasks),
    usaTask,
    fecTask,
    samTask
  ]);

  const ldaItems = [];
  if (lda.status === 'fulfilled') {
    lda.value.forEach((entry) => {
      if (entry.error || !entry.items) return;
      ldaItems.push(...entry.items);
    });
  }
  const ldaContribItems = [];
  if (ldaContrib.status === 'fulfilled') {
    ldaContrib.value.forEach((entry) => {
      if (entry.error || !entry.items) return;
      ldaContribItems.push(...entry.items);
    });
  }

  const normalizedLda = ldaItems.slice(0, perSourceLimit).map((item) => ({
    source: 'LDA',
    sourceId: 'lda-filings',
    type: item.filing_type_display || 'Filing',
    title: `${item.client?.name || 'Unknown client'} — ${item.filing_type_display || 'Filing'}`,
    summary: [item.registrant?.name, item.filing_period_display].filter(Boolean).join(' • '),
    amount: toNumber(item.income) || toNumber(item.expenses),
    entity: item.client?.name,
    recipient: item.registrant?.name,
    publishedAt: item.dt_posted,
    externalUrl: item.filing_document_url,
    detailFields: [
      { label: 'Client', value: item.client?.name },
      { label: 'Registrant', value: item.registrant?.name },
      { label: 'Filing Period', value: item.filing_period_display },
      { label: 'Income', value: item.income },
      { label: 'Expenses', value: item.expenses }
    ].filter((field) => field.value)
  }));

  const normalizedLdaContrib = ldaContribItems
    .filter((item) => Array.isArray(item.contribution_items) && item.contribution_items.length)
    .flatMap((item) => item.contribution_items.map((entry) => ({
      source: 'LDA',
      sourceId: 'lda-contributions',
      type: entry.contribution_type_display || 'Contribution',
      title: `${entry.contributor_name || item.registrant?.name || 'Contributor'} → ${entry.payee_name || 'Recipient'}`,
      summary: [entry.honoree_name, item.filing_period_display].filter(Boolean).join(' • '),
      amount: toNumber(entry.amount),
      entity: entry.contributor_name || item.registrant?.name,
      recipient: entry.payee_name,
      publishedAt: entry.date || item.dt_posted,
      externalUrl: item.filing_document_url,
      detailFields: [
        { label: 'Contributor', value: entry.contributor_name },
        { label: 'Recipient', value: entry.payee_name },
        { label: 'Honoree', value: entry.honoree_name },
        { label: 'Amount', value: entry.amount },
        { label: 'Date', value: entry.date }
      ].filter((field) => field.value)
    }))).slice(0, perSourceLimit);

  const usaItems = usa.status === 'fulfilled' && !usa.value.error ? (usa.value.items || []) : [];
  const normalizedUsa = usaItems.map((entry) => ({
    source: 'USAspending',
    sourceId: 'usaspending-transactions',
    type: 'Federal Award',
    title: entry['Recipient Name'] ? `${entry['Recipient Name']} — ${entry['Awarding Agency'] || 'Award'}` : (entry['Award ID'] || 'Federal Award'),
    summary: entry['Transaction Description'] || '',
    amount: toNumber(entry['Transaction Amount']),
    entity: entry['Recipient Name'],
    recipient: entry['Recipient Name'],
    publishedAt: entry['Action Date'],
    externalUrl: entry['Award ID'] ? `https://www.usaspending.gov/award/${encodeURIComponent(entry['Award ID'])}` : null,
    detailFields: [
      { label: 'Recipient', value: entry['Recipient Name'] },
      { label: 'Award ID', value: entry['Award ID'] },
      { label: 'Agency', value: entry['Awarding Agency'] },
      { label: 'Amount', value: entry['Transaction Amount'] },
      { label: 'Date', value: entry['Action Date'] }
    ].filter((field) => field.value)
  }));

  const fecItems = fec.status === 'fulfilled' && !fec.value.error ? (fec.value.items || []) : [];
  const normalizedFec = fecItems.map((entry) => ({
    source: 'OpenFEC',
    sourceId: 'fec-schedule-a',
    type: entry.receipt_type_desc || 'Contribution',
    title: `${entry.contributor_name || 'Contributor'} → ${entry.committee_name || entry.candidate_name || 'Committee'}`,
    summary: [entry.candidate_name, entry.report_year].filter(Boolean).join(' • '),
    amount: toNumber(entry.contribution_receipt_amount),
    entity: entry.contributor_name,
    recipient: entry.committee_name || entry.candidate_name,
    committee: entry.committee_name,
    publishedAt: entry.contribution_receipt_date,
    externalUrl: entry.pdf_url,
    detailFields: [
      { label: 'Contributor', value: entry.contributor_name },
      { label: 'Committee', value: entry.committee_name },
      { label: 'Candidate', value: entry.candidate_name },
      { label: 'Amount', value: entry.contribution_receipt_amount },
      { label: 'Date', value: entry.contribution_receipt_date }
    ].filter((field) => field.value)
  }));

  const samItems = sam.status === 'fulfilled' && !sam.value.error ? (sam.value.items || []) : [];
  const normalizedSam = samItems.map((entry) => ({
    source: 'SAM.gov',
    sourceId: 'sam-entities',
    type: 'Entity',
    title: entry?.legalBusinessName || entry?.entityName || entry?.name || 'SAM.gov Entity',
    summary: [entry?.uei, entry?.cageCode, entry?.entityStatus].filter(Boolean).join(' • '),
    amount: null,
    entity: entry?.legalBusinessName || entry?.entityName || entry?.name,
    publishedAt: entry?.registrationDate || entry?.lastUpdateDate,
    externalUrl: entry?.entityRegistrationURL || null,
    detailFields: [
      { label: 'UEI', value: entry?.uei },
      { label: 'CAGE', value: entry?.cageCode },
      { label: 'Status', value: entry?.entityStatus },
      { label: 'Registration Date', value: entry?.registrationDate }
    ].filter((field) => field.value)
  }));

  const merged = [...normalizedLda, ...normalizedLdaContrib, ...normalizedUsa, ...normalizedFec, ...normalizedSam]
    .map((item) => ({ ...item, score: scoreMoneyItem(item) }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, safeLimit);

  const totalAmount = merged.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0);
  const entities = summarizeMoneyEntities(merged);
  results.items = merged;
  results.entities = entities;
  results.summary = {
    totalAmount,
    totalItems: merged.length,
    topEntity: entities[0] || null
  };

  results.sources = {
    lda: { count: normalizedLda.length + normalizedLdaContrib.length, error: lda.status !== 'fulfilled' ? 'fetch_failed' : null },
    usaspending: { count: normalizedUsa.length, error: usa.status !== 'fulfilled' ? 'fetch_failed' : usa.value?.error || null },
    fec: { count: normalizedFec.length, error: fec.status !== 'fulfilled' ? 'fetch_failed' : fec.value?.error || null },
    sam: { count: normalizedSam.length, error: sam.status !== 'fulfilled' ? 'fetch_failed' : sam.value?.error || null }
  };

  return results;
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

  try {
    const response = await fetchWithTimeout(geoUrl.toString(), {
      headers: {
        'User-Agent': appConfig.userAgent,
        'Accept': 'application/json'
      }
    }, FETCH_TIMEOUT_MS);

    if (response.ok) {
      const data = await response.json();
      const result = data?.[0];
      if (result) {
        const payload = {
          query,
          lat: Number(result.lat),
          lon: Number(result.lon),
          displayName: result.display_name
        };
        geoCache.set(key, payload);
        return payload;
      }
    }
  } catch (error) {
    // fall through to secondary provider
  }

  const fallbackUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  fallbackUrl.searchParams.set('name', query);
  fallbackUrl.searchParams.set('count', '1');
  fallbackUrl.searchParams.set('language', 'en');
  fallbackUrl.searchParams.set('format', 'json');

  const fallbackResponse = await fetchWithTimeout(fallbackUrl.toString(), {
    headers: {
      'User-Agent': appConfig.userAgent,
      'Accept': 'application/json'
    }
  }, FETCH_TIMEOUT_MS);

  if (!fallbackResponse.ok) {
    throw new Error(`Geocode failed (${fallbackResponse.status})`);
  }

  const fallbackData = await fallbackResponse.json();
  const fallback = fallbackData?.results?.[0];
  if (!fallback) {
    const payload = { query, notFound: true };
    geoCache.set(key, payload);
    return payload;
  }

  const parts = [fallback.name, fallback.admin1, fallback.country].filter(Boolean);
  const payload = {
    query,
    lat: Number(fallback.latitude),
    lon: Number(fallback.longitude),
    displayName: parts.join(', ')
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

    if (url.pathname === '/api/money-flows') {
      const query = url.searchParams.get('q');
      const start = url.searchParams.get('start') || undefined;
      const end = url.searchParams.get('end') || undefined;
      const limit = url.searchParams.get('limit') || undefined;
      if (!query) {
        return jsonResponse({ error: 'missing_query' }, 400, env);
      }
      try {
        const payload = await fetchMoneyFlows({
          query,
          start,
          end,
          limit
        }, env);
        return jsonResponse(payload, 200, env);
      } catch (error) {
        return jsonResponse({ error: 'fetch_failed', message: error?.message || 'fetch failed' }, 502, env);
      }
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

    if (url.pathname === '/api/congress-detail') {
      const target = url.searchParams.get('url');
      if (!target) {
        return jsonResponse({ error: 'missing_url' }, 400, env);
      }
      let parsed;
      try {
        parsed = new URL(target);
      } catch (error) {
        return jsonResponse({ error: 'invalid_url', message: error.message }, 400, env);
      }
      if (parsed.hostname !== 'api.congress.gov') {
        return jsonResponse({ error: 'invalid_host' }, 400, env);
      }
      if (!env.DATA_GOV) {
        return jsonResponse({ error: 'missing_key', message: 'Server API key required.' }, 502, env);
      }
      parsed.searchParams.set('api_key', env.DATA_GOV);
      try {
        const response = await fetchWithTimeout(parsed.toString(), {
          headers: {
            'User-Agent': appConfig.userAgent,
            'Accept': 'application/json'
          }
        }, FETCH_TIMEOUT_MS);
        if (!response.ok) {
          return jsonResponse({ error: 'fetch_failed', status: response.status }, 502, env);
        }
        const data = await response.json();
        return jsonResponse(data, 200, env);
      } catch (error) {
        return jsonResponse({ error: 'fetch_failed', message: error.message }, 502, env);
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
