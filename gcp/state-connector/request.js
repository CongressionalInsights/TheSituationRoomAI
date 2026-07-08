import { DEFAULT_LIMIT, MAX_LIMIT } from './constants.js';

function toLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(parsed)));
}

export function parseSignalsRequest(url) {
  const params = url.searchParams;
  const signalType = String(params.get('signalType') || 'rulemaking').trim().toLowerCase();
  const state = String(params.get('state') || '').trim().toUpperCase();
  const limit = toLimit(params.get('limit'));
  const sort = String(params.get('sort') || 'updated_desc').trim();
  return { signalType, state, limit, sort };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortAndLimitSignals(items, limit) {
  return [...items]
    .filter((item) => item?.title)
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
    .slice(0, limit);
}

export function signalFetchStatus({ adapterCount = 0, resultCount = 0, errorCount = 0 } = {}) {
  if (adapterCount > 0 && resultCount === 0 && errorCount >= adapterCount) return 502;
  return 200;
}
