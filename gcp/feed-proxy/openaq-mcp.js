import { randomUUID } from 'node:crypto';

const SOURCE_URL = 'https://api.openaq.org/v3/locations?limit=20';
const MCP_ENDPOINT = 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function isDefaultOpenAqRequest(feed, { key, keyParam, keyHeader, query, params } = {}) {
  return feed.id === 'openaq-api' && feed.url === SOURCE_URL
    && feed.keySource === 'server' && feed.keyHeader === 'X-API-Key'
    && !key && !keyParam && !keyHeader && !query
    && (!params || Object.keys(params).length === 0);
}

function failure(error, httpStatus = 502, httpStatusSource = 'mcp-transport', upstreamError = null) {
  const message = httpStatusSource === 'mcp-tool-error'
    ? `OpenAQ MCP source request failed (${error}).`
    : `OpenAQ MCP request failed (${error}).`;
  return {
    id: 'openaq-api', fetchedAt: Date.now(), contentType: 'application/json',
    httpStatus, httpStatusSource, error, message, upstreamError,
    sourceTransport: 'mcp', transportUrl: MCP_ENDPOINT,
    body: JSON.stringify({ error, message, upstreamError })
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRpc(text) {
  try { return JSON.parse(text); } catch { throw new Error('invalid_mcp_response'); }
}

async function readRpcResponse(response, requestId) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/event-stream') throw new Error('invalid_mcp_response');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('mcp_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_mcp_response');
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('mcp_response_too_large');
      buffer += decoder.decode(value, { stream: true });
      if (type === 'application/json') continue;
      // Match a complete event, not a notification or a response to another call.
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const parsed = parseRpc(data);
        if (parsed?.id === requestId) return parsed;
      }
    }
    if (type === 'application/json') return parseRpc(buffer + decoder.decode());
    throw new Error('invalid_mcp_response');
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

function safeResponseHeaders(headers) {
  const allowed = new Set([
    'cache-control', 'content-type', 'etag', 'last-modified',
    'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'
  ]);
  const selected = Object.fromEntries(Object.entries(isRecord(headers) ? headers : {})
    .filter(([key, value]) => allowed.has(key) && typeof value === 'string'));
  return Object.keys(selected).length ? selected : null;
}

export async function fetchOpenAqMcp(timeoutMs) {
  const requestId = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name: 'raw.fetch', arguments: { sourceId: 'openaq-api', format: 'json' } }
      })
    });
    if (!response.ok) return failure(`mcp_http_${response.status}`, response.status);
    const rpc = await readRpcResponse(response, requestId);
    if (!isRecord(rpc) || rpc.jsonrpc !== '2.0' || rpc.id !== requestId
      || Object.hasOwn(rpc, 'method')
      || Object.hasOwn(rpc, 'result') === Object.hasOwn(rpc, 'error')) {
      return failure('invalid_mcp_response');
    }
    if (rpc.error) return failure('mcp_rpc_error');
    if (!isRecord(rpc.result)) return failure('invalid_mcp_response');
    const source = rpc.result.structuredContent;
    if (!isRecord(source)) return failure('invalid_mcp_response');
    if (rpc.result.isError || source.error) {
      const status = Number(source.upstreamStatus || source.httpStatus);
      const upstreamError = /^[a-z0-9_]{1,64}$/.test(source.error || '') ? source.error : 'source_failed';
      const validStatus = Number.isInteger(status) && status >= 300 && status <= 599;
      return failure(validStatus ? `http_${status}` : upstreamError,
        validStatus ? status : 502, 'mcp-tool-error', upstreamError);
    }
    const type = String(source.contentType || '').split(';')[0].trim().toLowerCase();
    const data = source.data;
    if (source.sourceId !== 'openaq-api' || source.url !== SOURCE_URL || source.fetchedUrl !== SOURCE_URL
      || source.fallbackUsed !== false || source.proxyUsed !== null
      || source.stale === true || source.warning
      || (type !== 'application/json' && !type.endsWith('+json'))
      || !isRecord(data) || !isRecord(data.meta) || data.error || data.errors || !Array.isArray(data.results)
      || data.results.some(row => !isRecord(row) || row.id === undefined || row.id === null)) {
      return failure('invalid_source_payload');
    }
    return {
      id: 'openaq-api', fetchedAt: Date.now(), contentType: source.contentType,
      body: JSON.stringify(data), httpStatus: 200, httpStatusSource: 'mcp-tool-success',
      sourceTransport: 'mcp', transportUrl: MCP_ENDPOINT, upstreamUrl: SOURCE_URL,
      stale: false, fallbackUsed: false, proxyUsed: null,
      responseHeaders: safeResponseHeaders(source.responseHeaders)
    };
  } catch (error) {
    const code = error.name === 'AbortError' ? 'timeout'
      : ['invalid_mcp_response', 'mcp_response_too_large'].includes(error.message)
        ? error.message : 'mcp_fetch_failed';
    return failure(code);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
