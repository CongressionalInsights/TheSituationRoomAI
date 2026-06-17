import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './catalog.mjs';

export const DEFAULT_FEED_BASE = 'https://situation-room-feed-382918878290.us-central1.run.app';
export const DEFAULT_MCP_ENDPOINT = 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';
export const DEFAULT_STATIC_BASE = 'https://congressionalinsights.github.io/TheSituationRoomAI';
export const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'analysis', 'monitor');

const RETRY_BACKOFF_MS = [500, 1200];

function normalizeBase(value) {
  if (!value) return '';
  return String(value).replace(/\/+$/, '');
}

function parseValue(raw) {
  if (raw === undefined || raw === '') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  return Number.isFinite(num) && String(num) === raw ? num : raw;
}

export function parseCliArgs(argv = []) {
  const options = {
    base: normalizeBase(process.env.SR_MONITOR_BASE || process.env.SR_BASE || DEFAULT_FEED_BASE),
    mcp: normalizeBase(process.env.SR_MONITOR_MCP || process.env.SR_MCP || DEFAULT_MCP_ENDPOINT),
    staticBase: normalizeBase(process.env.SR_MONITOR_STATIC || process.env.SR_STATIC_BASE || DEFAULT_STATIC_BASE),
    outputDir: path.resolve(process.env.SR_MONITOR_OUTPUT_DIR || DEFAULT_OUTPUT_DIR),
    timeoutMs: Number(process.env.SR_MONITOR_TIMEOUT_MS || 30000),
    includeDocs: true,
    includeStatic: true,
    writeLatest: true,
    allowAlerts: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [flag, inlineValue] = arg.split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    const consumeNext = inlineValue === undefined && argv[index + 1] && !argv[index + 1].startsWith('--');
    switch (flag) {
      case '--base':
        options.base = normalizeBase(String(nextValue || ''));
        break;
      case '--mcp':
        options.mcp = normalizeBase(String(nextValue || ''));
        break;
      case '--static':
        options.staticBase = normalizeBase(String(nextValue || ''));
        break;
      case '--output-dir':
        options.outputDir = path.resolve(String(nextValue || DEFAULT_OUTPUT_DIR));
        break;
      case '--timeout':
        options.timeoutMs = Number(nextValue || options.timeoutMs);
        break;
      case '--no-docs':
        options.includeDocs = false;
        break;
      case '--no-static':
        options.includeStatic = false;
        break;
      case '--no-write':
        options.writeLatest = false;
        break;
      case '--allow-alerts':
        options.allowAlerts = true;
        break;
      default: {
        const key = flag.replace(/^--/, '');
        options[key] = parseValue(nextValue);
        break;
      }
    }
    if (consumeNext) index += 1;
  }

  return options;
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(value));
}

export function hashContent(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function sanitizeObservedUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    ['api_key', 'key', 'token', 'apikey'].forEach((param) => {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, 'REDACTED');
      }
    });
    parsed.pathname = parsed.pathname.replace(/\/api\/area\/json\/[^/]+/i, '/api/area/json/REDACTED');
    return parsed.toString();
  } catch {
    return String(rawUrl)
      .replace(/(api_key=)[^&]+/gi, '$1REDACTED')
      .replace(/(\/api\/area\/json\/)[^/]+/i, '$1REDACTED');
  }
}

export async function fetchResponse(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 30000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, headers: response.headers };
  } catch (error) {
    return { ok: false, status: null, text: '', error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'fetch_failed'), headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}) {
  const result = await fetchText(url, options);
  if (result.error) return { ...result, data: null };
  try {
    return { ...result, data: result.text ? JSON.parse(result.text) : null };
  } catch (error) {
    return { ...result, data: null, error: `json_parse_error: ${error.message}` };
  }
}

function parseMcpStream(text) {
  if (!text) return null;
  const lines = text.split('\n').map((line) => line.trim());
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!dataLines.length) return null;
  const raw = dataLines[dataLines.length - 1].replace(/^data:\s*/, '');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readFirstMcpEvent(response) {
  if (!response?.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const delimiter = buffer.match(/\r?\n\r?\n/);
      if (!delimiter) continue;
      const chunk = buffer.slice(0, delimiter.index);
      const parsed = parseMcpStream(chunk);
      if (parsed) {
        try { await reader.cancel(); } catch {}
        return parsed;
      }
      buffer = buffer.slice((delimiter.index || 0) + delimiter[0].length);
    }
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return null;
}

function parseMcpText(text) {
  if (!text) return null;
  const streamed = parseMcpStream(text);
  if (streamed) return streamed;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function callMcpTool(endpoint, name, args = {}, timeoutMs = 30000) {
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  };

  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      let parsed = null;
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        parsed = await readFirstMcpEvent(response);
      }
      if (!parsed) {
        parsed = parseMcpText(await response.text());
      }
      if (!parsed) {
        lastError = { error: 'invalid_response', message: 'Unable to parse MCP response.' };
      } else if (parsed.error) {
        lastError = {
          error: parsed.error.message || 'mcp_error',
          message: parsed.error.message || 'MCP error.',
          status: response.status
        };
      } else {
        const result = parsed.result || parsed;
        return {
          ok: response.ok,
          status: response.status,
          data: result.structuredContent ?? null,
          raw: result
        };
      }
    } catch (error) {
      lastError = {
        error: error?.name === 'AbortError' ? 'timeout' : 'network_error',
        message: error?.message || 'MCP request failed.'
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRY_BACKOFF_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
    }
  }
  return { ok: false, status: null, data: null, ...lastError };
}

export async function callFeedProxy(base, feedId, sampleParams = {}, timeoutMs = 30000) {
  const { query, ...params } = sampleParams || {};
  return fetchJson(`${normalizeBase(base)}/api/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      id: feedId,
      force: true,
      ...(query ? { query } : {}),
      ...(Object.keys(params).length ? { params } : {})
    }),
    timeoutMs
  });
}

export async function callCongressDetail(base, targetUrl, timeoutMs = 30000) {
  const url = `${normalizeBase(base)}/api/congress-detail?url=${encodeURIComponent(targetUrl)}`;
  return fetchJson(url, {
    headers: { 'Accept': 'application/json' },
    timeoutMs
  });
}

export async function fetchStaticFeed(staticBase, feedId, timeoutMs = 30000) {
  const url = `${normalizeBase(staticBase)}/data/feeds/${encodeURIComponent(feedId)}.json?ts=${Date.now()}`;
  return fetchJson(url, {
    headers: { 'Accept': 'application/json' },
    timeoutMs
  });
}
