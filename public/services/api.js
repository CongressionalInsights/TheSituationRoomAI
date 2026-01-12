const DEFAULT_TIMEOUT_MS = 12000;

const rawConfig = typeof window !== 'undefined' ? (window.SR_CONFIG || {}) : {};

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
  if (path.endsWith('/')) return path.slice(0, -1);
  return path.replace(/\/[^/]*$/, '');
}

const API_BASE = resolveApiBase();
const BASE_PATH = resolveBasePath();

export function getApiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
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
    const response = await fetch(getApiUrl(path), { ...options, signal: controller.signal });
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
