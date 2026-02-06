import http from 'http';
import { mkdirSync, readFile, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = normalize(join(__dirname, 'public'));
const DATA = normalize(join(__dirname, 'data', 'feeds.json'));
const GEO_CACHE_PATH = normalize(join(__dirname, 'analysis', 'geo', 'geocode_cache.json'));

const feedsConfig = JSON.parse(readFileSync(DATA, 'utf8'));
const appConfig = feedsConfig.app || { defaultRefreshMinutes: 60, userAgent: 'TheSituationRoom/0.1' };
const cache = new Map();
const energyMapCache = { data: null, fetchedAt: 0 };
let geoCache = {};
let lastGeocodeAt = 0;
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENSKY_CLIENTID = process.env.OPENSKY_CLIENTID;
const OPENSKY_CLIENTSECRET = process.env.OPENSKY_CLIENTSECRET;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
let openSkyToken = null;
let openSkyTokenExpiresAt = 0;
const FETCH_TIMEOUT_MS = feedsConfig.app?.fetchTimeoutMs || 12000;
const GPSJAM_ID = 'gpsjam';
const GPSJAM_CACHE_KEY = 'gpsjam:data';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function loadLocalFeed(feed) {
  if (!feed.localPath) return null;
  const filePath = normalize(join(__dirname, feed.localPath));
  if (!filePath.startsWith(__dirname)) return null;
  if (!existsSync(filePath)) return null;
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'text/plain; charset=utf-8';
  const body = readFileSync(filePath, 'utf8');
  return {
    id: feed.id,
    fetchedAt: Date.now(),
    contentType,
    body,
    httpStatus: 200
  };
}

function decodeMaybeGzip(buffer) {
  if (!buffer || buffer.length < 2) return Buffer.from(buffer || []);
  const signature = buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!signature) return Buffer.from(buffer);
  try {
    return gunzipSync(Buffer.from(buffer));
  } catch (err) {
    return Buffer.from(buffer);
  }
}

function parseGpsJamManifest(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  let latest = null;
  lines.forEach((line) => {
    const [date, suspect, bad] = line.split(',');
    if (!date || date === 'date') return;
    if (!latest || Date.parse(date) > Date.parse(latest.date)) {
      latest = { date: date.trim(), suspect, bad };
    }
  });
  return latest;
}

async function fetchGpsJam(force = false) {
  const feed = feedsConfig.feeds.find((entry) => entry.id === GPSJAM_ID);
  if (!feed) {
    return { error: 'missing_feed', message: 'GPSJam feed missing.' };
  }
  const ttlMs = (feed.ttlMinutes || appConfig.defaultRefreshMinutes) * 60 * 1000;
  const cached = cache.get(GPSJAM_CACHE_KEY);
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  const manifestRes = await fetchWithTimeout(feed.url, {
    headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'text/plain,*/*' }
  }, FETCH_TIMEOUT_MS);
  const manifestBuf = Buffer.from(await manifestRes.arrayBuffer());
  const manifestText = decodeMaybeGzip(manifestBuf).toString('utf8');
  const manifest = parseGpsJamManifest(manifestText);
  if (!manifest?.date) {
    return { error: 'manifest_empty', message: 'No GPSJam date found.' };
  }

  const dataUrl = `https://gpsjam.org/data/${manifest.date}-h3_4.csv`;
  const dataRes = await fetchWithTimeout(dataUrl, {
    headers: { 'User-Agent': appConfig.userAgent, 'Accept': 'text/plain,*/*' }
  }, FETCH_TIMEOUT_MS);
  const dataBuf = Buffer.from(await dataRes.arrayBuffer());
  const dataText = decodeMaybeGzip(dataBuf).toString('utf8');
  const payload = {
    fetchedAt: Date.now(),
    httpStatus: dataRes.status,
    date: manifest.date,
    body: dataText
  };
  cache.set(GPSJAM_CACHE_KEY, payload);
  return payload;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function safePath(urlPath) {
  const cleaned = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = normalize(join(ROOT, cleaned));
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
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

function summarizeBy(items, keyFn, amountFn = (item) => item.amount) {
  const totals = new Map();
  items.forEach((item) => {
    const raw = keyFn(item);
    const name = normalizeEntityName(raw || '');
    if (!name) return;
    const current = totals.get(name) || { name, amount: 0, count: 0, sample: raw };
    current.count += 1;
    const amount = amountFn(item);
    if (Number.isFinite(amount)) current.amount += amount;
    totals.set(name, current);
  });
  return [...totals.values()].sort((a, b) => (b.amount || 0) - (a.amount || 0));
}

function summarizeMoneyBuckets(items) {
  const buckets = {
    contributions: { count: 0, totalAmount: 0 },
    spending: { count: 0, totalAmount: 0 },
    lobbying: { count: 0, totalAmount: 0 },
    registry: { count: 0, totalAmount: 0 }
  };
  items.forEach((item) => {
    const bucket = item.bucket;
    if (!bucket || !buckets[bucket]) return;
    buckets[bucket].count += 1;
    if (Number.isFinite(item.amount)) buckets[bucket].totalAmount += item.amount;
  });
  return buckets;
}

function summarizeMoneyTop(items) {
  const byBucket = (bucket) => items.filter((item) => item.bucket === bucket);
  const contributions = byBucket('contributions');
  const spending = byBucket('spending');
  const lobbying = byBucket('lobbying');
  const registry = byBucket('registry');

  const topDonors = summarizeBy(contributions, (item) => item.donor);
  const topRecipients = summarizeBy(contributions, (item) => item.recipient);
  const topSpendingRecipients = summarizeBy(spending, (item) => item.recipient);
  const topLobbyClients = summarizeBy(lobbying, (item) => item.client);
  const topLobbyRegistrants = summarizeBy(lobbying, (item) => item.registrant);
  const topRegistry = summarizeBy(registry, (item) => item.registryEntity || item.entity);

  return {
    contributions: {
      donor: topDonors[0]?.name || null,
      donorAmount: topDonors[0]?.amount || 0,
      recipient: topRecipients[0]?.name || null,
      recipientAmount: topRecipients[0]?.amount || 0
    },
    spending: {
      recipient: topSpendingRecipients[0]?.name || null,
      recipientAmount: topSpendingRecipients[0]?.amount || 0
    },
    lobbying: {
      client: topLobbyClients[0]?.name || null,
      clientAmount: topLobbyClients[0]?.amount || 0,
      registrant: topLobbyRegistrants[0]?.name || null,
      registrantAmount: topLobbyRegistrants[0]?.amount || 0
    },
    registry: {
      entity: topRegistry[0]?.name || null,
      entityAmount: topRegistry[0]?.amount || 0
    }
  };
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

async function fetchMoneyFlows({ query, start, end, limit }) {
  if (!query) {
    return { error: 'missing_query', message: 'Query parameter q is required.' };
  }
  const safeLimit = Math.min(MONEY_FLOW_MAX_LIMIT, Math.max(20, Number(limit) || 60));
  const perSourceLimit = Math.max(10, Math.floor(safeLimit / 4));
  const range = resolveMoneyFlowRange(start, end);
  const dataGovKey = process.env.DATA_GOV || '';
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
    bucket: 'lobbying',
    donor: null,
    entity: item.client?.name,
    recipient: item.registrant?.name,
    client: item.client?.name,
    registrant: item.registrant?.name,
    committee: null,
    registryEntity: null,
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
      bucket: 'contributions',
      donor: entry.contributor_name || item.registrant?.name,
      entity: entry.contributor_name || item.registrant?.name,
      recipient: entry.payee_name,
      client: null,
      registrant: item.registrant?.name,
      committee: null,
      registryEntity: null,
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
    bucket: 'spending',
    donor: entry['Awarding Agency'] || null,
    entity: entry['Recipient Name'],
    recipient: entry['Recipient Name'],
    client: null,
    registrant: null,
    committee: null,
    registryEntity: null,
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
    bucket: 'contributions',
    donor: entry.contributor_name || null,
    entity: entry.contributor_name,
    recipient: entry.committee_name || entry.candidate_name,
    committee: entry.committee_name,
    client: null,
    registrant: null,
    registryEntity: null,
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
    bucket: 'registry',
    donor: null,
    entity: entry?.legalBusinessName || entry?.entityName || entry?.name,
    recipient: null,
    client: null,
    registrant: null,
    committee: null,
    registryEntity: entry?.legalBusinessName || entry?.entityName || entry?.name,
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

  results.items = merged;
  results.entities = summarizeMoneyEntities(merged);
  const buckets = summarizeMoneyBuckets(merged);
  const top = summarizeMoneyTop(merged);
  results.summary = {
    totalItems: merged.length,
    buckets,
    top
  };

  results.sources = {
    lda: { count: normalizedLda.length + normalizedLdaContrib.length, error: lda.status !== 'fulfilled' ? 'fetch_failed' : null },
    usaspending: { count: normalizedUsa.length, error: usa.status !== 'fulfilled' ? 'fetch_failed' : usa.value?.error || null },
    fec: { count: normalizedFec.length, error: fec.status !== 'fulfilled' ? 'fetch_failed' : fec.value?.error || null },
    sam: { count: normalizedSam.length, error: sam.status !== 'fulfilled' ? 'fetch_failed' : sam.value?.error || null }
  };

  return results;
}

function loadGeoCache() {
  if (existsSync(GEO_CACHE_PATH)) {
    try {
      geoCache = JSON.parse(readFileSync(GEO_CACHE_PATH, 'utf8'));
    } catch (err) {
      geoCache = {};
    }
  }
}

function saveGeoCache() {
  mkdirSync(join(__dirname, 'analysis', 'geo'), { recursive: true });
  writeFileSync(GEO_CACHE_PATH, JSON.stringify(geoCache, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function getOpenSkyToken() {
  if (!OPENSKY_CLIENTID || !OPENSKY_CLIENTSECRET) return null;
  if (openSkyToken && Date.now() < openSkyTokenExpiresAt) {
    return openSkyToken;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OPENSKY_CLIENTID,
    client_secret: OPENSKY_CLIENTSECRET
  });
  const response = await fetch(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.access_token) return null;
  const ttl = Number(data.expires_in) || 1800;
  openSkyToken = data.access_token;
  openSkyTokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
  return openSkyToken;
}

async function geocodeQuery(query) {
  const key = query.toLowerCase();
  if (geoCache[key]) {
    return { ...geoCache[key], cached: true };
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
    geoCache[key] = payload;
    saveGeoCache();
    return payload;
  }

  const payload = {
    query,
    lat: Number(result.lat),
    lon: Number(result.lon),
    displayName: result.display_name
  };
  geoCache[key] = payload;
  saveGeoCache();
  return payload;
}

async function handleChat(payload, apiKey) {
  if (!apiKey) {
    return { status: 401, body: { error: 'missing_api_key', message: 'Provide an OpenAI API key.' } };
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const model = payload.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
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

function resolveServerKey(feed) {
  if (feed.keySource !== 'server') return null;
  if (feed.keyGroup === 'api.data.gov') return process.env.DATA_GOV;
  if (feed.keyGroup === 'eia') return process.env.EIA;
  if (feed.keyGroup === 'earthdata') return process.env.EARTHDATA_NASA;
  if (feed.id === 'openaq-api') return process.env.OPEN_AQ;
  if (feed.id === 'nasa-firms') return process.env.NASA_FIRMS;
  return null;
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEnergyMap() {
  const apiKey = process.env.EIA;
  if (!apiKey) {
    return { error: 'missing_server_key', message: 'Server EIA key required for energy map.' };
  }

  const ttlMs = 60 * 60 * 1000;
  if (energyMapCache.data && Date.now() - energyMapCache.fetchedAt < ttlMs) {
    return { data: energyMapCache.data };
  }

  const url = new URL('https://api.eia.gov/v2/electricity/retail-sales/data/');
  url.searchParams.set('api_key', apiKey);
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

async function fetchFeed(feed, { query, force = false, key, keyParam, keyHeader } = {}) {
  const cacheKey = `${feed.id}:${query || ''}`;
  const ttlMs = (feed.ttlMinutes || appConfig.defaultRefreshMinutes) * 60 * 1000;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  const localPayload = loadLocalFeed(feed);
  if (localPayload) {
    cache.set(cacheKey, localPayload);
    return localPayload;
  }

  const serverKey = resolveServerKey(feed);
  const effectiveKey = key || serverKey;
  if (feed.requiresKey && !effectiveKey) {
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

  if (feed.requiresConfig && !feed.url) {
    return {
      id: feed.id,
      fetchedAt: Date.now(),
      contentType: 'application/json',
      body: JSON.stringify({ error: 'requires_config', message: 'Feed URL not configured.' })
    };
  }

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
  if (feed.id === 'transport-opensky') {
    const token = await getOpenSkyToken();
    if (!token) {
      return {
        id: feed.id,
        fetchedAt: Date.now(),
        contentType: 'application/json',
        body: JSON.stringify({ error: 'missing_server_key', message: 'OpenSky OAuth token unavailable.' })
      };
    }
    headers.Authorization = `Bearer ${token}`;
  }
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/feeds') {
    const sanitized = feedsConfig.feeds.map((feed) => ({
      ...feed,
      url: feed.requiresKey ? feed.url : feed.url
    }));
    return sendJson(res, 200, { app: feedsConfig.app, feeds: sanitized });
  }

  if (url.pathname === '/api/gpsjam') {
    const force = url.searchParams.get('force') === '1';
    try {
      const payload = await fetchGpsJam(force);
      if (payload.error) {
        return sendJson(res, 502, payload);
      }
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/congress-detail') {
    const target = url.searchParams.get('url');
    if (!target) {
      return sendJson(res, 400, { error: 'missing_url' });
    }
    let parsed;
    try {
      parsed = new URL(target);
    } catch (error) {
      return sendJson(res, 400, { error: 'invalid_url', message: error.message });
    }
    if (parsed.hostname !== 'api.congress.gov') {
      return sendJson(res, 400, { error: 'invalid_host' });
    }
    const key = process.env.DATA_GOV;
    if (!key) {
      return sendJson(res, 502, { error: 'missing_key', message: 'Server API key required.' });
    }
    parsed.searchParams.set('api_key', key);
    try {
      const response = await fetchWithTimeout(parsed.toString(), {
        headers: {
          'User-Agent': appConfig.userAgent,
          'Accept': 'application/json'
        }
      }, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        return sendJson(res, 502, { error: 'fetch_failed', status: response.status });
      }
      const data = await response.json();
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/govinfo-detail') {
    const target = url.searchParams.get('url');
    if (!target) {
      return sendJson(res, 400, { error: 'missing_url' });
    }
    let parsed;
    try {
      parsed = new URL(target);
    } catch (error) {
      return sendJson(res, 400, { error: 'invalid_url', message: error.message });
    }
    if (parsed.hostname !== 'api.govinfo.gov') {
      return sendJson(res, 400, { error: 'invalid_host' });
    }
    if (!parsed.pathname.startsWith('/packages/') || !parsed.pathname.endsWith('/summary')) {
      return sendJson(res, 400, { error: 'invalid_path' });
    }
    const key = process.env.DATA_GOV;
    if (!key) {
      return sendJson(res, 502, { error: 'missing_key', message: 'Server API key required.' });
    }
    parsed.searchParams.set('api_key', key);
    try {
      const response = await fetchWithTimeout(parsed.toString(), {
        headers: {
          'User-Agent': appConfig.userAgent,
          'Accept': 'application/json'
        }
      }, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        return sendJson(res, 502, { error: 'fetch_failed', status: response.status });
      }
      const data = await response.json();
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/federal-register-detail') {
    const documentNumber = url.searchParams.get('documentNumber');
    if (!documentNumber) {
      return sendJson(res, 400, { error: 'missing_documentNumber' });
    }
    if (!/^\d{4}-\d{5}$/.test(documentNumber)) {
      return sendJson(res, 400, { error: 'invalid_documentNumber' });
    }
    const target = `https://www.federalregister.gov/api/v1/documents/${documentNumber}.json`;
    try {
      const response = await fetchWithTimeout(target, {
        headers: {
          'User-Agent': appConfig.userAgent,
          'Accept': 'application/json'
        }
      }, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        return sendJson(res, 502, { error: 'fetch_failed', status: response.status });
      }
      const data = await response.json();
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/regulations-comments') {
    const docketId = url.searchParams.get('docketId');
    if (!docketId) {
      return sendJson(res, 400, { error: 'missing_docketId' });
    }
    const key = process.env.DATA_GOV;
    if (!key) {
      return sendJson(res, 502, { error: 'missing_key', message: 'Server API key required.' });
    }
    const searchTerm = url.searchParams.get('searchTerm') || '';
    const sort = url.searchParams.get('sort') || '-postedDate';
    const pageNumberRaw = url.searchParams.get('pageNumber') || '1';
    let pageNumber = Number(pageNumberRaw);
    if (!Number.isFinite(pageNumber)) pageNumber = 1;
    pageNumber = Math.max(1, Math.min(250, Math.round(pageNumber)));
    const pageSizeRaw = url.searchParams.get('pageSize') || '20';
    let pageSize = Number(pageSizeRaw);
    if (!Number.isFinite(pageSize)) pageSize = 20;
    pageSize = Math.max(5, Math.min(50, Math.round(pageSize)));
    const allowedSort = new Set(['postedDate', '-postedDate', 'lastModifiedDate', '-lastModifiedDate']);
    const effectiveSort = allowedSort.has(sort) ? sort : '-postedDate';
    const target = new URL('https://api.regulations.gov/v4/comments');
    target.searchParams.set('api_key', key);
    target.searchParams.set('filter[docketId]', docketId);
    if (searchTerm) {
      target.searchParams.set('filter[searchTerm]', searchTerm);
    }
    target.searchParams.set('page[size]', String(pageSize));
    target.searchParams.set('page[number]', String(pageNumber));
    target.searchParams.set('sort', effectiveSort);
    try {
      const response = await fetchWithTimeout(target.toString(), {
        headers: {
          'User-Agent': appConfig.userAgent,
          'Accept': 'application/json'
        }
      }, FETCH_TIMEOUT_MS);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return sendJson(res, 502, { error: 'fetch_failed', status: response.status, data });
      }
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/regulations-comment-detail') {
    const commentId = url.searchParams.get('commentId');
    if (!commentId) {
      return sendJson(res, 400, { error: 'missing_commentId' });
    }
    const key = process.env.DATA_GOV;
    if (!key) {
      return sendJson(res, 502, { error: 'missing_key', message: 'Server API key required.' });
    }
    const safeId = String(commentId).trim();
    if (!/^[A-Za-z0-9_.:-]+$/.test(safeId)) {
      return sendJson(res, 400, { error: 'invalid_commentId' });
    }
    const target = new URL(`https://api.regulations.gov/v4/comments/${encodeURIComponent(safeId)}`);
    target.searchParams.set('api_key', key);
    try {
      const response = await fetchWithTimeout(target.toString(), {
        headers: {
          'User-Agent': appConfig.userAgent,
          'Accept': 'application/json'
        }
      }, FETCH_TIMEOUT_MS);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return sendJson(res, 502, { error: 'fetch_failed', status: response.status, data });
      }
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/feed') {
    let body = {};
    if (req.method === 'POST') {
      try {
        const raw = await readRequestBody(req);
        body = JSON.parse(raw || '{}');
      } catch (error) {
        return sendJson(res, 400, { error: 'invalid_json', message: error.message });
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
      return sendJson(res, 404, { error: 'unknown_feed', id });
    }

    try {
      const payload = await fetchFeed(feed, { query, force, key, keyParam, keyHeader });
      return sendJson(res, 200, payload);
    } catch (error) {
      const extra = error?.cause?.code || error?.code;
      const message = [error?.message, extra].filter(Boolean).join(' ');
      return sendJson(res, 502, { error: 'fetch_failed', message: message || 'fetch failed' });
    }
  }

  if (url.pathname === '/api/money-flows') {
    const query = url.searchParams.get('q') || '';
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    const limit = url.searchParams.get('limit') || '';
    try {
      const result = await fetchMoneyFlows({ query, start, end, limit });
      if (result.error) {
        return sendJson(res, 400, result);
      }
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/energy-map') {
    try {
      const result = await fetchEnergyMap();
      if (result.error) {
        return sendJson(res, 200, result);
      }
      return sendJson(res, 200, result.data);
    } catch (error) {
      return sendJson(res, 502, { error: 'fetch_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/geocode') {
    const query = url.searchParams.get('q');
    if (!query) {
      return sendJson(res, 400, { error: 'missing_query' });
    }
    try {
      const payload = await geocodeQuery(query);
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, { error: 'geocode_failed', message: error.message });
    }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw || '{}');
      const apiKey = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY || process.env.OPEN_AI;
      const result = await handleChat(payload, apiKey);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      return sendJson(res, 400, { error: 'invalid_request', message: error.message });
    }
  }

  if (url.pathname === '/api/snapshot' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const dir = join(__dirname, 'analysis', 'denario', 'snapshots');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = join(dir, `snapshot-${stamp}.json`);
        writeFileSync(filePath, JSON.stringify(parsed, null, 2));
        return sendJson(res, 200, { saved: true, path: filePath });
      } catch (error) {
        return sendJson(res, 400, { error: 'invalid_json', message: error.message });
      }
    });
    return;
  }

  let filePath = safePath(url.pathname);
  if (!filePath) return notFound(res);
  if (url.pathname === '/app.bundle.js' && !existsSync(filePath)) {
    const fallback = safePath('/app.js');
    if (fallback && existsSync(fallback)) {
      filePath = fallback;
    }
  }

  readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = 5173;
const HOST = '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`The Situation Room running at http://localhost:${PORT}`);
});

loadGeoCache();
