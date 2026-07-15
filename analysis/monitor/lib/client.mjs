import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './catalog.mjs';
import { defaultMonitorBaselineDir, isCredentialScopeQueryKey } from './baseline.mjs';

export const DEFAULT_FEED_BASE = 'https://situation-room-feed-382918878290.us-central1.run.app';
export const DEFAULT_MCP_ENDPOINT = 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';
export const DEFAULT_STATIC_BASE = 'https://congressionalinsights.github.io/TheSituationRoomAI';
export const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'analysis', 'monitor');

const RETRY_BACKOFF_MS = [500, 1200];
const MAX_MCP_EVENT_BUFFER_CHARS = 2 * 1024 * 1024;
const MAX_MCP_RESPONSE_BYTES = 16 * 1024 * 1024;

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
    baselineDir: defaultMonitorBaselineDir(),
    timeoutMs: Number(process.env.SR_MONITOR_TIMEOUT_MS || 30000),
    includeDocs: true,
    includeStatic: true,
    writeLatest: true,
    allowAlerts: false,
    allowLegacyBaseline: false,
    scopeTag: String(process.env.SR_MONITOR_SCOPE_TAG || '')
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
      case '--baseline-dir':
        options.baselineDir = path.resolve(String(nextValue || defaultMonitorBaselineDir()));
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
      case '--allow-legacy-baseline':
        options.allowLegacyBaseline = true;
        break;
      case '--scope-tag':
        options.scopeTag = String(nextValue || '');
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

function writeFileAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, value, { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

export function writeJson(filePath, value) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export function writeText(filePath, value) {
  writeFileAtomic(filePath, String(value));
}

export function hashContent(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function sanitizeObservedUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = 'REDACTED';
    if (parsed.password) parsed.password = 'REDACTED';
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, 'REDACTED');
    }
    parsed.pathname = parsed.pathname.replace(/\/api\/area\/json\/[^/]+/i, '/api/area/json/REDACTED');
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(rawUrl)
      .replace(/^([^:/?#]+:\/\/)[^@/\s]+@/i, '$1REDACTED@')
      .replace(/([?&])([^=&#\s]+)=([^&\s]*)/g, '$1$2=REDACTED')
      .replace(/(\/api\/area\/json\/)[^/]+/i, '$1REDACTED')
      .replace(/#.*$/, '');
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
    return {
      ok: false,
      status: null,
      text: '',
      error: error?.name === 'AbortError' ? 'timeout' : 'fetch_failed',
      headers: new Headers()
    };
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

async function readMatchingMcpEvent(response, requestId) {
  if (!response?.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_MCP_EVENT_BUFFER_CHARS) {
        const error = new Error('MCP event exceeded the monitor response limit.');
        error.code = 'MCP_RESPONSE_TOO_LARGE';
        throw error;
      }
      while (true) {
        const delimiter = buffer.match(/\r?\n\r?\n/);
        if (!delimiter) break;
        const chunk = buffer.slice(0, delimiter.index);
        buffer = buffer.slice((delimiter.index || 0) + delimiter[0].length);
        const parsed = parseMcpStream(chunk);
        if (parsed && parsed.id === requestId) {
          try { await reader.cancel(); } catch {}
          return parsed;
        }
      }
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
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

async function readMcpResponseText(response) {
  const declaredLength = Number(response?.headers?.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_RESPONSE_BYTES) {
    const error = new Error('MCP response exceeded the monitor response limit.');
    error.code = 'MCP_RESPONSE_TOO_LARGE';
    throw error;
  }
  if (!response?.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value?.byteLength || 0;
      if (bytesRead > MAX_MCP_RESPONSE_BYTES) {
        const error = new Error('MCP response exceeded the monitor response limit.');
        error.code = 'MCP_RESPONSE_TOO_LARGE';
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function replaceCredentialToken(message, token, replacement) {
  let cursor = 0;
  let result = '';
  while (cursor < message.length) {
    const index = message.indexOf(token, cursor);
    if (index < 0) return result + message.slice(cursor);
    const before = index > 0 ? message[index - 1] : '';
    const afterIndex = index + token.length;
    const after = afterIndex < message.length ? message[afterIndex] : '';
    const boundedBefore = !before || !/[A-Za-z0-9]/.test(before);
    const boundedAfter = !after || !/[A-Za-z0-9]/.test(after);
    if (boundedBefore && boundedAfter) {
      result += message.slice(cursor, index) + replacement;
      cursor = afterIndex;
    } else {
      result += message.slice(cursor, index + 1);
      cursor = index + 1;
    }
  }
  return result;
}

function redactEndpointValues(message, endpoint, { redactBareCredentials = true } = {}) {
  const redacted = 'REDACTED';
  const credentialTokens = new Set();
  const queryPairs = new Set();
  try {
    const parsed = new URL(String(endpoint || ''));
    const variants = (value) => {
      if (!value) return;
      const values = new Set([String(value)]);
      try { values.add(decodeURIComponent(String(value))); } catch {}
      try { values.add(encodeURIComponent(String(value))); } catch {}
      return [...values].filter(Boolean);
    };
    for (const value of [parsed.username, parsed.password]) {
      for (const token of variants(value) || []) credentialTokens.add(token);
    }
    for (const [key, value] of parsed.searchParams.entries()) {
      const keyVariants = variants(key) || [];
      const valueVariants = variants(value) || [];
      for (const keyVariant of keyVariants) {
        for (const valueVariant of valueVariants) {
          queryPairs.add(`${keyVariant}=${valueVariant}`);
        }
      }
      if (isCredentialScopeQueryKey(key)) {
        for (const token of valueVariants) credentialTokens.add(token);
      }
    }
    for (const pair of parsed.search.slice(1).split('&')) {
      const separator = pair.indexOf('=');
      if (separator >= 0) queryPairs.add(pair);
    }
  } catch {}

  let safeMessage = String(message || '');
  for (const pair of [...queryPairs].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const separator = pair.indexOf('=');
    safeMessage = safeMessage.split(pair).join(`${pair.slice(0, separator + 1)}${redacted}`);
  }
  if (redactBareCredentials) {
    for (const token of [...credentialTokens].filter(Boolean).sort((a, b) => b.length - a.length)) {
      safeMessage = replaceCredentialToken(safeMessage, token, redacted);
    }
  }
  return safeMessage.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => sanitizeObservedUrl(value));
}

function isSensitiveMcpResultField(key) {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return /(?:^|_)(?:error|message|url|uri|endpoint|href|request)(?:_|$)/.test(normalized);
}

function redactEndpointPayload(value, endpoint, { errorContext = false } = {}) {
  if (typeof value === 'string') {
    return redactEndpointValues(value, endpoint, { redactBareCredentials: errorContext });
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEndpointPayload(item, endpoint, { errorContext }));
  }
  if (!value || typeof value !== 'object') return value;
  const objectErrorContext = errorContext || Boolean(value.isError) || Boolean(value.error);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const safeKey = redactEndpointValues(key, endpoint, { redactBareCredentials: false });
    if (isCredentialScopeQueryKey(key)) return [safeKey, 'REDACTED'];
    return [safeKey, redactEndpointPayload(item, endpoint, {
      errorContext: objectErrorContext || isSensitiveMcpResultField(key)
    })];
  }));
}

function normalizeMcpToolError(result) {
  const structuredError = result?.structuredContent?.error;
  const structuredMessage = result?.structuredContent?.message;
  const contentMessage = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === 'text' && String(item?.text || '').trim())?.text
    : null;
  return {
    error: typeof structuredError === 'string' && structuredError.trim()
      ? structuredError
      : 'mcp_tool_error',
    message: typeof structuredMessage === 'string' && structuredMessage.trim()
      ? structuredMessage
      : (contentMessage || 'MCP tool call failed.')
  };
}

function isMatchingMcpResponse(parsed, requestId) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(parsed, 'error');
  return parsed.jsonrpc === '2.0'
    && Object.prototype.hasOwnProperty.call(parsed, 'id')
    && parsed.id === requestId
    && (hasResult || hasError);
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
        parsed = await readMatchingMcpEvent(response, payload.id);
      } else {
        parsed = parseMcpText(await readMcpResponseText(response));
      }
      if (!isMatchingMcpResponse(parsed, payload.id)) {
        lastError = { error: 'invalid_response', message: 'Unable to parse MCP response.' };
      } else if (parsed.error) {
        const safeMessage = redactEndpointValues(parsed.error.message || 'MCP error.', endpoint);
        lastError = {
          error: parsed.error.message ? safeMessage : 'mcp_error',
          message: safeMessage,
          status: response.status
        };
      } else {
        const result = parsed.result || parsed;
        const isToolError = Boolean(result.isError || result.structuredContent?.error);
        const safeResult = redactEndpointPayload(result, endpoint, { errorContext: isToolError });
        const transportError = response.ok ? {} : {
          error: `http_${response.status}`,
          message: `MCP request failed with HTTP ${response.status}.`
        };
        return {
          ok: response.ok && !isToolError,
          status: response.status,
          data: safeResult.structuredContent ?? null,
          raw: safeResult,
          ...transportError,
          ...(isToolError ? normalizeMcpToolError(safeResult) : {})
        };
      }
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      const responseTooLarge = error?.code === 'MCP_RESPONSE_TOO_LARGE';
      lastError = {
        error: timedOut ? 'timeout' : (responseTooLarge ? 'response_too_large' : 'network_error'),
        message: timedOut
          ? 'MCP request timed out.'
          : (responseTooLarge ? error.message : 'MCP request failed.')
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
