const DEFAULT_TIMEOUT_MS = 12000;

const rawConfig = typeof window !== 'undefined' ? (window.SR_CONFIG || {}) : {};
const isGithubPages = typeof window !== 'undefined' && window.location.hostname.endsWith('.github.io');

function normalizeBase(value) {
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function resolveApiBase() {
  const configured = normalizeBase(rawConfig.apiBase);
  if (!configured) return window.location.origin;
  if (/^https?:\/\//i.test(configured)) return configured;
  if (configured.startsWith('/')) return `${window.location.origin}${configured}`;
  return configured;
}

function resolveBasePath() {
  const configured = normalizeBase(rawConfig.basePath);
  if (configured) return configured;
  const path = window.location.pathname || '';
  if (!path || path === '/') return '';
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSegment = trimmed.split('/').pop() || '';
  if (!lastSegment.includes('.')) return trimmed;
  return trimmed.replace(/\/[^/]*$/, '');
}

const API_BASE = resolveApiBase();
const BASE_PATH = resolveBasePath();
const STATIC_MODE = typeof rawConfig.staticMode === 'boolean' ? rawConfig.staticMode : (isGithubPages && !rawConfig.apiBase);
const STATIC_BASE = `${BASE_PATH}/data`;

export function isStaticMode() {
  return STATIC_MODE;
}

export function getOpenAiProxy() {
  return rawConfig.openAiProxy || '';
}

export function getOpenSkyProxy() {
  return rawConfig.openSkyProxy || '';
}

function mapStatic(path) {
  if (path.startsWith('/api/feeds')) {
    return `${STATIC_BASE}/feeds.json`;
  }
  if (path.startsWith('/api/energy-map')) {
    return `${STATIC_BASE}/energy-map.json`;
  }
  if (path.startsWith('/api/feed')) {
    const parsed = new URL(path, 'http://local');
    const id = parsed.searchParams.get('id');
    if (id) return `${STATIC_BASE}/feeds/${id}.json`;
    return `${STATIC_BASE}/feeds.json`;
  }
  if (path.startsWith('/api/geocode') || path.startsWith('/api/chat') || path.startsWith('/api/snapshot')) {
    return `${STATIC_BASE}/unavailable.json`;
  }
  return `${STATIC_BASE}/unavailable.json`;
}

export function getApiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (STATIC_MODE) return mapStatic(path);
  return new URL(path, API_BASE).toString();
}

export function getAssetUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}

export async function apiFetch(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = getApiUrl(path);
    if (STATIC_MODE && (!options.method || options.method.toUpperCase() === 'GET')) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}_ts=${Date.now()}`;
    }
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiJson(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await apiFetch(path, options, timeoutMs);
  let data = null;
  let error = null;
  try {
    data = await response.json();
  } catch (err) {
    error = err;
  }
  return { response, data, error };
}
