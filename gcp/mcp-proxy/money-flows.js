// Canonical money-flow implementation. scripts/sync-feeds.mjs mirrors this file to Feed Proxy.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireMoneySources, acquireLdaPage, startLdaCursor } from './money-sources.js';
const MONEY_ENTITY_ALIASES_PATH = process.env.MONEY_ENTITY_ALIASES_PATH || fileURLToPath(new URL('./entity-aliases.json', import.meta.url));
const MONEY_FLOW_DEFAULT_DAYS = 180;
const MONEY_FLOW_MAX_LIMIT = 120;
const MONEY_QUERY_VARIANT_LIMIT = 8;
const MONEY_MATCH_THRESHOLDS = {
  strict: 0.9,
  normal: 0.66,
  loose: 0.5
};
const ENTITY_SUFFIX_TOKENS = new Set([
  'CO',
  'COMPANY',
  'CORP',
  'CORPORATION',
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'LTD',
  'PLC',
  'THE'
]);

function formatIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function parseDateParam(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function resolveMoneyFlowRange(start, end, fallbackDays = MONEY_FLOW_DEFAULT_DAYS) {
  const endDate = parseDateParam(end) || new Date();
  const startDate = parseDateParam(start) || new Date(endDate);
  if (!parseDateParam(start)) {
    startDate.setDate(endDate.getDate() - fallbackDays);
  }
  const startIso = formatIsoDate(startDate);
  const endIso = formatIsoDate(endDate);
  const years = [];
  for (let year = startDate.getFullYear(); year <= endDate.getFullYear(); year += 1) {
    years.push(year);
  }
  return { startDate, endDate, startIso, endIso, years };
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

function tokenizeEntityName(value) {
  return normalizeEntityName(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token && !ENTITY_SUFFIX_TOKENS.has(token));
}

function uniqueStrings(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value) return false;
      const key = normalizeEntityName(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function uniqueItemsBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item, index) => {
    const key = String(keyFn(item) || index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMoneyMatchMode(value) {
  const mode = String(value || 'normal').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MONEY_MATCH_THRESHOLDS, mode) ? mode : 'normal';
}

function normalizeMoneyMinScore(value, mode = 'normal') {
  const fallback = MONEY_MATCH_THRESHOLDS[normalizeMoneyMatchMode(mode)] || MONEY_MATCH_THRESHOLDS.normal;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0.01, Math.min(1, ratio));
}

function hasMoneyMinScoreOverride(value) {
  if (value === undefined || value === null || value === '') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function getMoneyAliasEntries(rawConfig) {
  if (Array.isArray(rawConfig)) return rawConfig;
  if (Array.isArray(rawConfig?.moneyFlows)) return rawConfig.moneyFlows;
  if (Array.isArray(rawConfig?.entities)) return rawConfig.entities;
  if (Array.isArray(rawConfig?.aliases)) return rawConfig.aliases;
  return [];
}

function normalizeMoneyAliasEntry(entry) {
  const umbrella = String(entry?.umbrella || entry?.name || '').trim();
  const expandedTo = uniqueStrings(entry?.expandedTo || entry?.entities || entry?.legalEntities || []);
  if (!umbrella || !expandedTo.length) return null;
  const aliases = uniqueStrings([umbrella, ...(entry?.aliases || [])]);
  return {
    umbrella,
    normalizedAliases: aliases.map((alias) => normalizeEntityName(alias)).filter(Boolean),
    expandedTo
  };
}

function loadMoneyEntityAliases(aliasPath = MONEY_ENTITY_ALIASES_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(aliasPath, 'utf8'));
    return getMoneyAliasEntries(parsed).map(normalizeMoneyAliasEntry).filter(Boolean);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'money_entity_aliases_unavailable',
      path: aliasPath,
      message: error?.message || 'Unable to load entity aliases.'
    }));
    return [];
  }
}

const moneyEntityAliases = loadMoneyEntityAliases();

export function resolveMoneyAliasExpansion(query, explicitEntities = []) {
  const providedEntities = uniqueStrings(explicitEntities);
  if (providedEntities.length) {
    return {
      umbrella: String(query || '').trim() || null,
      expandedTo: providedEntities,
      explicit: true
    };
  }
  const normalized = normalizeEntityName(query);
  if (!normalized) return null;
  const match = moneyEntityAliases.find((entry) => entry.normalizedAliases.includes(normalized));
  if (!match) return null;
  return {
    umbrella: match.umbrella,
    expandedTo: match.expandedTo
  };
}

export function buildUsaspendingTransactionKey(item = {}) {
  if (item.transaction_id != null || item.generated_unique_transaction_id != null) return JSON.stringify(['transaction', item.transaction_id ?? item.generated_unique_transaction_id]);
  // internal_id is an award ID on this endpoint, not a transaction ID.
  return JSON.stringify([
    item.generated_internal_id ?? item['Award ID'] ?? null,
    item['Mod'] ?? null, item['Action Date'] ?? null, item['Action Type'] ?? null,
    item['Recipient UEI'] ?? item['Recipient Name'] ?? null,
    item['Transaction Amount'] ?? null, item['Transaction Description'] ?? null
  ]);
}

export async function settleMoneyTasks(tasks) {
  const settled = await Promise.allSettled(tasks);
  return settled.map((entry) => (
    entry.status === 'fulfilled'
      ? entry.value
      : { items: [], error: entry.reason?.message || 'fetch_failed' }
  ));
}

export function buildMoneyQueryProfile(query, options = {}) {
  const normalized = normalizeEntityName(query);
  const matchMode = normalizeMoneyMatchMode(options.matchMode);
  const matchThreshold = normalizeMoneyMinScore(options.minScore, matchMode);
  const minScoreOverride = hasMoneyMinScoreOverride(options.minScore);
  const aliasExpansion = resolveMoneyAliasExpansion(query, options.entities);
  const searchTerms = uniqueStrings([
    ...(aliasExpansion?.expandedTo?.length ? [] : [query]),
    ...(aliasExpansion?.expandedTo || [])
  ]);
  const variants = searchTerms
    .map((term) => ({
      term,
      normalized: normalizeEntityName(term),
      tokens: tokenizeEntityName(term)
    }))
    .filter((variant) => variant.tokens.length);
  return {
    original: query,
    normalized,
    searchTerms: searchTerms.length ? searchTerms : [query],
    variants,
    matchMode,
    matchThreshold,
    minScoreOverride,
    aliasExpansion
  };
}

function scoreTokenMatch(queryTokens, candidateTokens, mode = 'normal') {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  const overlap = queryTokens.filter((token) => candidateSet.has(token)).length;
  const recall = overlap / queryTokens.length;
  if (mode === 'loose') {
    const requiredOverlap = queryTokens.length > 1 ? 2 : 1;
    if (overlap < requiredOverlap) return 0;
  } else if (recall < 1) {
    return 0;
  }
  const precision = overlap / candidateTokens.length;
  if (precision <= 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function findBestMoneyNameMatch(profile, ...fields) {
  if (!profile?.variants?.length) return null;
  let best = null;
  fields.flat(Infinity).forEach((field) => {
    const name = String(field || '').trim();
    if (!name) return;
    const normalizedName = normalizeEntityName(name);
    const candidateTokens = tokenizeEntityName(name);
    profile.variants.forEach((variant) => {
      let score = scoreTokenMatch(variant.tokens, candidateTokens, profile.matchMode);
      if (normalizedName === variant.normalized) score = 1;
      if (score > (best?.score || 0)) {
        best = {
          name,
          normalizedName,
          score: Number(score.toFixed(3)),
          query: variant.term
        };
      }
    });
  });
  return best && best.score >= (profile.matchThreshold || MONEY_MATCH_THRESHOLDS.normal) ? best : null;
}

function findMoneyKeywordMatch(profile, ...fields) {
  if (!profile?.variants?.length) return null;
  let best = null;
  fields.flat(Infinity).forEach((field) => {
    const text = normalizeSearchField(field);
    if (!text) return;
    const candidateTokens = tokenizeEntityName(text);
    profile.variants.forEach((variant) => {
      if (!variant.tokens.length) return;
      const candidateSet = new Set(candidateTokens);
      const overlap = variant.tokens.filter((token) => candidateSet.has(token)).length;
      if (overlap !== variant.tokens.length) return;
      const score = Number(Math.min(0.65, overlap / Math.max(candidateTokens.length, variant.tokens.length)).toFixed(3));
      if (score > (best?.score || 0)) {
        best = {
          name: text,
          normalizedName: normalizeEntityName(text),
          score,
          query: variant.term
        };
      }
    });
  });
  if (!best) return null;
  if ((profile.minScoreOverride || profile.matchMode !== 'normal')
    && best.score < (profile.matchThreshold || MONEY_MATCH_THRESHOLDS.normal)) {
    return null;
  }
  return best;
}

export function attachMoneyMatch(profile, item) {
  const { moneyMatchFields, keywordMatchFields, ...publicItem } = item;
  const match = findBestMoneyNameMatch(
    profile,
    publicItem.entity,
    publicItem.recipient,
    publicItem.client,
    publicItem.registrant,
    publicItem.donor,
    publicItem.committee,
    publicItem.registryEntity,
    publicItem.employer, publicItem.contributorId, publicItem.committeeId, publicItem.recipientUei,
    moneyMatchFields
  );
  const keywordMatch = match ? null : findMoneyKeywordMatch(profile, keywordMatchFields);
  const resolvedMatch = match || keywordMatch;
  if (!resolvedMatch) return null;
  return {
    ...publicItem,
    matchedName: resolvedMatch.name,
    matchScore: Math.round(resolvedMatch.score * 100),
    matchType: match ? 'entity' : 'keyword',
    matchRole: match && publicItem.employer && normalizeEntityName(match.name) === normalizeEntityName(publicItem.employer) ? 'reported_employer' : (match ? 'named_party' : 'keyword')
  };
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/[$,]/g, '');
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSearchField(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSearchField(entry))
      .filter(Boolean)
      .join(' ');
  }
  return String(value).trim();
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
    LDA: 18,
    USAspending: 20,
    OpenFEC: 20,
    'SAM.gov': 10
  };
  score += sourceBoost[item.source] || 8;
  if (item.type && /registration|filing/i.test(item.type)) score += 4;
  if (item.type && /contribution|donation/i.test(item.type)) score += 6;
  return Math.round(Math.min(100, score));
}

function buildUsaspendingUrl(awardId) {
  if (!awardId) return 'https://www.usaspending.gov';
  return `https://www.usaspending.gov/award/${encodeURIComponent(awardId)}`;
}

function buildFecUrl(item, query) {
  const base = 'https://www.fec.gov/data/receipts/individual-contributions/';
  const params = new URLSearchParams();
  if (item?.sub_id) params.set('sub_id', String(item.sub_id));
  if (item?.committee?.committee_id || item?.committee_id) {
    params.set('committee_id', item.committee?.committee_id || item.committee_id);
  }
  if (item?.contributor_name) params.set('contributor_name', item.contributor_name);
  if (item?.contribution_receipt_date) {
    const year = new Date(item.contribution_receipt_date).getUTCFullYear();
    params.set('two_year_transaction_period', String(item.two_year_transaction_period ?? (year + year % 2)));
  }
  if (!params.toString() && query) params.set('contributor_name', query);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function buildLdaFilingUrl(filingId) {
  if (!filingId) return 'https://lda.gov';
  return `https://lda.gov/filings/public/filing/${encodeURIComponent(filingId)}`;
}

function buildSamUrl(uei, entityName) {
  if (uei) return `https://sam.gov/entity/${encodeURIComponent(uei)}`;
  const params = new URLSearchParams();
  params.set('index', 'entity');
  params.set('page', '1');
  params.set('sort', '-relevance');
  if (entityName) params.set('keyword', entityName);
  return `https://sam.gov/search/?${params.toString()}`;
}

export function summarizeMoneyEntities(items) {
  const totals = new Map();
  items.forEach((item) => {
    const rawName = item.matchType === 'entity' && item.matchRole !== 'reported_employer'
      ? (item.matchedName || item.entity || item.recipient || item.committee || item.contributor)
      : (item.entity || item.recipient || item.committee || item.contributor);
    const name = normalizeEntityName(rawName || '');
    if (!name) return;
    const current = totals.get(name) || {
      name,
      amount: null,
      count: 0,
      sample: rawName
    };
    current.count += 1;
    if (item.includeInSubtotal !== false && Number.isFinite(item.amount)) current.amount = (current.amount ?? 0) + item.amount;
    totals.set(name, current);
  });
  return [...totals.values()]
    .sort((a, b) => (b.amount ?? -Infinity) - (a.amount ?? -Infinity))
    .slice(0, 8);
}

function summarizeBy(items, keyFn, amountFn = (item) => item.amount) {
  const totals = new Map();
  items.forEach((item) => {
    const raw = keyFn(item);
    const name = normalizeEntityName(raw || '');
    if (!name) return;
    const current = totals.get(name) || { name, amount: null, count: 0, sample: raw };
    current.count += 1;
    const amount = amountFn(item);
    if (item.includeInSubtotal !== false && Number.isFinite(amount)) current.amount = (current.amount ?? 0) + amount;
    totals.set(name, current);
  });
  return [...totals.values()].sort((a, b) => (b.amount ?? -Infinity) - (a.amount ?? -Infinity));
}

function summarizeMoneyBuckets(items) {
  const buckets = {
    contributions: { count: 0, totalAmount: null, knownAmountCount: 0, unknownAmountCount: 0 },
    spending: { count: 0, totalAmount: null, knownAmountCount: 0, unknownAmountCount: 0 },
    lobbying: { count: 0, totalAmount: null, knownAmountCount: 0, unknownAmountCount: 0 },
    registry: { count: 0, totalAmount: null, knownAmountCount: 0, unknownAmountCount: 0 }
  };
  items.forEach((item) => {
    const bucket = item.bucket;
    if (!bucket || !buckets[bucket]) return;
    buckets[bucket].count += 1;
    if (item.includeInSubtotal !== false && Number.isFinite(item.amount)) {
      buckets[bucket].totalAmount = (buckets[bucket].totalAmount ?? 0) + item.amount;
      buckets[bucket].knownAmountCount++;
    } else if (bucket !== 'registry' && item.includeInSubtotal !== false) buckets[bucket].unknownAmountCount++;
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
      donorAmount: topDonors[0]?.amount ?? null,
      recipient: topRecipients[0]?.name || null,
      recipientAmount: topRecipients[0]?.amount ?? null
    },
    spending: {
      recipient: topSpendingRecipients[0]?.name || null,
      recipientAmount: topSpendingRecipients[0]?.amount ?? null
    },
    lobbying: {
      client: topLobbyClients[0]?.name || null,
      clientAmount: topLobbyClients[0]?.amount ?? null,
      registrant: topLobbyRegistrants[0]?.name || null,
      registrantAmount: topLobbyRegistrants[0]?.amount ?? null
    },
    registry: {
      entity: topRegistry[0]?.name || null,
      entityAmount: topRegistry[0]?.amount ?? null
    }
  };
}

export async function fetchMoneyFlows({ query, start, end, limit, matchMode, minScore, entities, mode = 'sample', cursor }, runtime = {}) {
  if (!['sample', 'lda_pages'].includes(mode) || (cursor && mode !== 'lda_pages')) return { error: 'invalid_mode', message: 'Use mode lda_pages for LDA cursors.' };
  if (!query) {
    return { error: 'missing_query', message: 'Query parameter q is required.' };
  }
  if ((start && !parseDateParam(start)) || (end && !parseDateParam(end))) return { error: 'invalid_range', message: 'Dates must be valid.' };
  const safeLimit = Math.min(MONEY_FLOW_MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || 60)));
  const range = resolveMoneyFlowRange(start, end);
  if (range.startIso > range.endIso || range.years.length > 10) return { error: 'invalid_range', message: 'Use an ordered range of at most ten calendar years.' };
  const queryProfile = buildMoneyQueryProfile(query, { matchMode, minScore, entities });
  const pageMode = mode === 'lda_pages';
  const queryVariants = pageMode ? queryProfile.searchTerms : queryProfile.searchTerms.slice(0, MONEY_QUERY_VARIANT_LIMIT);
  const binding = createHash('sha256').update(JSON.stringify([range.startIso, range.endIso, queryProfile])).digest('hex');
  const nextArgs = { query, start: range.startIso, end: range.endIso, mode: 'lda_pages' };
  nextArgs.matchMode = queryProfile.matchMode;
  if (queryProfile.minScoreOverride) nextArgs.minScore = Number(minScore);
  if (entities != null) nextArgs.entities = entities;
  const results = {
    query,
    range: { start: range.startIso, end: range.endIso },
    generatedAt: new Date().toISOString(),
    matchMode: queryProfile.matchMode,
    minScore: Math.round(queryProfile.matchThreshold * 100),
    aliasExpansion: queryProfile.aliasExpansion || null,
    sources: {},
    items: [],
    entities: [],
    summary: null
  };

  let acquired;
  if (pageMode) {
    const page = await acquireLdaPage({ terms: queryVariants, range, binding, cursor, runtime });
    if (page.invalidCursor) return { error: 'invalid_cursor', message: 'LDA cursor is invalid or its query, date window, aliases or matching options changed. Restart the traversal explicitly.' };
    acquired = Object.fromEntries(['lda', 'ldaContributions', 'fec', 'usaspending', 'sam'].map((name) => [name, {
      items: [], error: null, coverage: { status: 'not_requested', complete: false, reasons: [], pages: 0, requests: 0 }
    }]));
    acquired[page.source] = page;
    const { cursor: nextCursor, ...progress } = page.traversal;
    results.ldaTraversal = { ...progress, startsFromBeginning: false, next: nextCursor ? { ...nextArgs, cursor: nextCursor } : null };
  } else {
    acquired = await acquireMoneySources({ terms: queryVariants, range, runtime });
    // Ranked samples can discard any acquired row. Start the full traversal at
    // the beginning, explicitly, instead of skipping rows hidden by ranking.
    const notBefore = acquired.lda.coverage.nextRequestAt || 0;
    results.ldaTraversal = { complete: false, startsFromBeginning: true,
      note: 'Separate full LDA traversal starts at the beginning. Deduplicate source/sourceId across pages and any prior sample; follow next until complete.',
      next: { ...nextArgs, cursor: startLdaCursor(binding, notBefore) } };
  }
  for (const [source, result] of Object.entries(acquired)) {
    results.sources[source] = { count: result.items.length, countBasis: 'acquired_rows_before_deduplication_and_matching', error: result.error, coverage: result.coverage, retryAfterSeconds: result.retryAfterSeconds ?? null, retryAt: result.retryAt ?? null };
  }
  const ldaResults = [acquired.lda];
  const ldaContribResults = [acquired.ldaContributions];
  const usaResults = [acquired.usaspending];
  const fecResults = [acquired.fec];
  const samResults = [acquired.sam];

  const items = [];
  const usaItems = uniqueItemsBy(
    usaResults.flatMap((entry) => entry.items || []),
    buildUsaspendingTransactionKey
  );
  const fecItems = uniqueItemsBy(
    fecResults.flatMap((entry) => entry.items || []),
    (item) => item.sub_id || item.contribution_receipt_id
  );
  const samItems = uniqueItemsBy(
    samResults.flatMap((entry) => entry.items || []),
    (item) => item.entityRegistration?.ueiSAM || item.entityRegistration?.uei || item.entityRegistration?.cageCode || item.entityRegistration?.legalBusinessName
  );

  uniqueItemsBy(ldaResults.flatMap((entry) => entry.items || []), (item) => item.filing_uuid || item.id).forEach((item) => {
    const income = toNumber(item.income);
    const expenses = toNumber(item.expenses);
    const amount = income ?? expenses;
    const filingId = item.filing_uuid || item.id;
    const registrant = item.registrant?.name || 'Unknown';
    const client = item.client?.name || 'Lobbying Filing';
    const canonicalUrl = buildLdaFilingUrl(filingId);
    items.push({
      source: 'LDA',
      sourceId: filingId,
      type: 'Lobbying Filing',
      title: client,
      summary: `Registrant: ${registrant} · Filed ${item.filing_year || ''}`,
      amount,
      bucket: 'lobbying',
      income, expenses, amountBasis: income !== null ? 'reported_income' : 'reported_expenses',
      filingType: item.filing_type ?? null, filingPeriod: item.filing_period ?? null,
      amendment: item.filing_type_display?.toLowerCase().includes('amendment') ?? null,
      donor: null,
      entity: client,
      recipient: registrant,
      client,
      registrant,
      committee: null,
      registryEntity: null,
      keywordMatchFields: item.lobbying_activities?.map((act) => act.description),
      publishedAt: item.filing_deadline || item.dt_posted || item.filing_date || null,
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Client', value: client },
        { label: 'Registrant', value: registrant },
        { label: 'Filing year', value: item.filing_year || '—' },
        { label: income !== null ? 'Reported income' : 'Reported expenses', value: formatAmount(amount) }
      ],
      detailLinkLabel: 'Open LDA filing'
    });
  });

  uniqueItemsBy(ldaContribResults.flatMap((entry) => entry.items || []), (item) => item.filing_uuid || item.id).forEach((item) => {
    (item.contribution_items || []).forEach((contribution, childIndex) => {
      if (contribution.date && (contribution.date.slice(0, 10) < range.startIso || contribution.date.slice(0, 10) > range.endIso)) return;
      const amount = toNumber(contribution?.amount);
      const filingId = item.filing_uuid || item.filing_id || item.id;
      const contributor = contribution?.contributor_name || 'Unknown';
      const payee = contribution?.payee_name || item.registrant?.name || 'Lobbying Contribution';
      const canonicalUrl = `https://lda.gov/filings/public/contribution/${encodeURIComponent(filingId)}/`;
      items.push({
        source: 'LDA',
        sourceId: `${filingId}:${contribution.id ?? childIndex}`,
        filingId, childId: contribution.id ?? null,
        type: 'Lobbying Contribution',
        title: payee,
        summary: `Contributor: ${contributor} · Filed ${item.filing_year || ''}`,
        amount,
        bucket: 'contributions',
        donor: contributor,
        entity: contributor,
        recipient: payee,
        client: null,
        registrant: item.registrant?.name || null,
        committee: null,
        registryEntity: null,
        moneyMatchFields: [
          item.registrant?.name,
          item.lobbyist?.last_name,
          [contribution.contributor_name, contribution.payee_name]
        ],
        publishedAt: contribution?.date || item.filing_deadline || item.filing_date || null,
        externalUrl: canonicalUrl,
        canonicalUrl,
        detailFields: [
          { label: 'Contributor', value: contributor },
          { label: 'Payee', value: payee },
          { label: 'Filing year', value: item.filing_year || '—' },
          { label: 'Amount', value: formatAmount(amount) }
        ],
        detailLinkLabel: 'Open LDA filing'
      });
    });
  });

  usaItems.forEach((item) => {
    const amount = toNumber(item['Transaction Amount']);
    const awardId = item['Award ID'];
    const recipient = item['Recipient Name'] || awardId || 'Federal Award';
    const agency = item['Awarding Agency'] || 'Agency';
    const canonicalUrl = buildUsaspendingUrl(item.generated_internal_id);
    const transactionKey = buildUsaspendingTransactionKey(item);
    items.push({
      source: 'USAspending',
      sourceId: createHash('sha256').update(transactionKey).digest('hex'),
      identityBasis: item.transaction_id != null || item.generated_unique_transaction_id != null ? 'provider_transaction_id' : 'award_modification_action_composite',
      awardId, generatedAwardId: item.generated_internal_id ?? null,
      modificationNumber: item.Mod ?? null, actionType: item['Action Type'] ?? null,
      recipientUei: item['Recipient UEI'] ?? null,
      amountBasis: 'transaction_obligation',
      loanValue: toNumber(item['Loan Value']), subsidyCost: toNumber(item['Subsidy Cost']),
      type: 'Federal Transaction',
      title: recipient,
      summary: `${agency} · ${item['Transaction Description'] || 'Award'}`,
      amount,
      bucket: 'spending',
      donor: agency,
      entity: recipient,
      recipient,
      client: null,
      registrant: null,
      committee: null,
      registryEntity: null,
      keywordMatchFields: [item['Transaction Description']],
      publishedAt: item['Action Date'] || null,
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Award ID', value: awardId || '—' },
        { label: 'Modification', value: item.Mod ?? '—' },
        { label: 'Amount basis', value: 'Transaction obligation; not award total' },
        { label: 'Recipient', value: recipient || '—' },
        { label: 'Agency', value: agency || '—' },
        { label: 'Action date', value: item['Action Date'] || '—' },
        { label: 'Amount', value: formatAmount(amount) }
      ],
      detailLinkLabel: 'Open USAspending record'
    });
  });

  fecItems.forEach((item) => {
    const amount = toNumber(item.contribution_receipt_amount);
    const committee = item.committee?.name || item.committee_name || 'Campaign Committee';
    const contributor = item.contributor_name || 'Contributor';
    const canonicalUrl = buildFecUrl(item, query);
    items.push({
      source: 'OpenFEC',
      sourceId: item.sub_id || item.contribution_receipt_id,
      type: 'Campaign Receipt',
      employer: item.contributor_employer ?? null,
      contributorId: item.contributor_id ?? null, committeeId: item.committee?.committee_id ?? item.committee_id ?? null,
      entityType: item.entity_type ?? null, memoCode: item.memo_code ?? null,
      amendmentIndicator: item.amendment_indicator ?? null,
      twoYearTransactionPeriod: item.two_year_transaction_period ?? null,
      amountBasis: 'reported_receipt',
      includeInSubtotal: !['X', 'Y', true].includes(item.memo_code) && item.memoed_subtotal !== true,
      attribution: 'Contributor is donor; reported employer is affiliation only. Committee is recipient.',
      title: committee,
      summary: `${contributor} · ${item.contributor_employer || item.contributor_occupation || 'Employer unknown'}`,
      amount,
      bucket: 'contributions',
      donor: contributor,
      entity: contributor,
      committee,
      recipient: committee,
      client: null,
      registrant: null,
      registryEntity: null,
      publishedAt: item.contribution_receipt_date || null,
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'Contributor', value: contributor },
        { label: 'Committee', value: committee },
        { label: 'Amount', value: formatAmount(amount) },
        { label: 'Date', value: item.contribution_receipt_date || '—' },
        { label: 'Employer', value: item.contributor_employer || '—' }
      ],
      detailLinkLabel: 'Open FEC record'
    });
  });

  samItems.forEach((item) => {
    const amount = null;
    const registration = item.entityRegistration || {};
    const state = item.coreData?.physicalAddress?.stateOrProvinceCode ?? null;
    const entityName = item.entityRegistration?.legalBusinessName || item.entityRegistration?.dbaName;
    const uei = item.entityRegistration?.ueiSAM || item.entityRegistration?.uei || item.entityRegistration?.ueiSAM || '';
    const canonicalUrl = buildSamUrl(uei, entityName);
    items.push({
      source: 'SAM.gov',
      sourceId: uei || item.entityRegistration?.cageCode,
      type: 'SAM Entity',
      title: entityName || 'SAM Entity',
      summary: `${registration.registrationStatus || 'Entity'} · ${state || ''}`,
      amount,
      bucket: 'registry',
      amountBasis: 'not_applicable',
      registrationStatus: registration.registrationStatus ?? null,
      registrationDate: registration.registrationDate ?? null,
      registrationExpirationDate: registration.registrationExpirationDate ?? null,
      state, uei, dateBasis: 'current_registration_snapshot',
      donor: null,
      entity: entityName,
      recipient: null,
      client: null,
      registrant: null,
      committee: null,
      registryEntity: entityName,
      publishedAt: item.entityRegistration?.lastUpdateDate || null,
      externalUrl: canonicalUrl,
      canonicalUrl,
      detailFields: [
        { label: 'UEI', value: uei || '—' },
        { label: 'Status', value: registration.registrationStatus || '—' },
        { label: 'State', value: state || '—' },
        { label: 'Last update', value: item.entityRegistration?.lastUpdateDate || '—' },
        { label: 'CAGE', value: item.entityRegistration?.cageCode || '—' }
      ],
      detailLinkLabel: 'Open SAM record'
    });
  });

  const matchedItems = items
    .map((item) => attachMoneyMatch(queryProfile, item))
    .filter(Boolean)
    .map((item) => ({
      ...item,
      score: scoreMoneyItem(item)
    }))
    .sort((a, b) => (b.matchScore - a.matchScore) || (b.score - a.score));
  results.items = pageMode ? matchedItems : matchedItems.slice(0, safeLimit);
  results.schemaVersion = 2;
  results.coverage = {
    status: pageMode ? 'lda_page' : 'discovery_sample', complete: pageMode && results.ldaTraversal.complete,
    outputTruncated: !pageMode && matchedItems.length > safeLimit,
    matchedItems: matchedItems.length, returnedItems: results.items.length,
    queryVariantsTruncated: queryProfile.searchTerms.length > queryVariants.length,
    note: pageMode ? 'All matching normalized rows from one LDA provider page, including all relevant LD-203 children; limit is not applied. Follow ldaTraversal.next until complete. Deduplicate by source/sourceId across pages and prior samples. Completion covers requested filters, not a historical snapshot or net ledger. Subtotals cover this response only.' : 'Ranked discovery sample. Subtotals cover returned rows only, not source-wide or net totals. Source completeness applies only to executed filters. LDA covers filing years; SAM is current identity data.'
  };
  for (const [source, info] of Object.entries(results.sources)) {
    info.returnedCount = results.items.filter((item) => source === 'ldaContributions' ? item.type === 'Lobbying Contribution' : source === 'lda' ? item.type === 'Lobbying Filing' : item.source === ({ fec: 'OpenFEC', usaspending: 'USAspending', sam: 'SAM.gov' })[source]).length;
  }

  results.entities = summarizeMoneyEntities(results.items);
  const buckets = summarizeMoneyBuckets(results.items);
  const top = summarizeMoneyTop(results.items);
  results.summary = {
    totalItems: results.items.length,
    basis: 'returned_rows_only',
    note: results.coverage.note,
    buckets,
    top
  };

  return results;
}


function formatAmount(amount) { return amount === null ? '—' : `$${amount.toLocaleString('en-US')}`; }
