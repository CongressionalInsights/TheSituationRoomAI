import { randomUUID } from 'node:crypto';
import { readRpcResponse, safeResponseHeaders } from './openaq-mcp.js';
import { BLS_CPI_URL, inspectBlsPayload, sanitizeBlsBody } from './bls.js';

const MCP_ENDPOINT = 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';

export async function fetchBlsMcp(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const failure = (error, httpStatus = 502, details = {}) => ({
    id: 'bls-cpi', fetchedAt: Date.now(), contentType: 'application/json', httpStatus,
    httpStatusSource: 'mcp-transport', sourceTransport: 'mcp', transportUrl: MCP_ENDPOINT,
    error, message: 'BLS MCP acquisition failed.',
    body: JSON.stringify({ error, message: 'BLS MCP acquisition failed.' }), ...details
  });
  try {
    const id = randomUUID();
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'raw.fetch', arguments: { sourceId: 'bls-cpi', format: 'json' } } })
    });
    if (!response.ok) return failure('bls_mcp_http_error', response.status);
    const rpc = await readRpcResponse(response, id);
    const source = rpc?.result?.structuredContent;
    if (rpc?.jsonrpc === '2.0' && rpc.id === id && !rpc.error && (rpc.result?.isError || source?.error)) {
      const upstream = Number(source?.upstreamStatus || source?.httpStatus);
      return failure('bls_mcp_source_failed', 502, { httpStatusSource: 'mcp-tool-error',
        mcpHttpStatus: response.status, upstreamHttpStatus: Number.isInteger(upstream) && upstream >= 100 && upstream <= 599 ? upstream : null });
    }
    if (rpc?.jsonrpc !== '2.0' || rpc.id !== id || rpc.error || rpc.method
      || rpc.result?.isError || source?.error || source?.sourceId !== 'bls-cpi'
      || source.url !== BLS_CPI_URL || typeof source.fetchedUrl !== 'string'
      || !/^application\/(?:[a-z0-9.+-]*\+)?json$/i.test(String(source.contentType || '').split(';')[0].trim())
      || typeof source.fallbackUsed !== 'boolean') {
      return failure('invalid_bls_mcp_response');
    }
    const fallback = source.fallbackUsed;
    const snapshotUrl = 'https://congressionalinsights.github.io/TheSituationRoomAI/data/feeds/bls-cpi.json';
    if (fallback ? source.proxyUsed !== 'live-cache' || source.fetchedUrl !== snapshotUrl
      : source.proxyUsed !== null || source.fetchedUrl !== BLS_CPI_URL || source.stale || source.warning) {
      return failure('invalid_bls_source_identity');
    }
    const inspection = inspectBlsPayload(source.data, 'CUUR0000SA0');
    if (inspection.error) return failure(inspection.error);
    return {
      id: 'bls-cpi', fetchedAt: Date.now(), contentType: source.contentType,
      httpStatus: 200, httpStatusSource: 'mcp-tool-success', sourceTransport: 'mcp',
      transportUrl: MCP_ENDPOINT, upstreamUrl: BLS_CPI_URL,
      body: sanitizeBlsBody(source.data, 'CUUR0000SA0'), fallbackUsed: fallback,
      fallback: fallback ? 'live-cache' : null, stale: fallback || Boolean(source.stale),
      proxyUsed: source.proxyUsed, responseHeaders: safeResponseHeaders(source.responseHeaders),
      acquiredAt: source.acquiredAt || null, cacheHit: Boolean(source.cacheHit),
      upstreamHttpStatus: source.upstreamHttpStatus || null, upstreamError: source.upstreamError || null,
      ...(fallback ? { warning: 'Published BLS snapshot; not a current upstream acquisition.' } : {})
    };
  } catch (error) {
    return failure(error.name === 'AbortError' ? 'timeout' : 'bls_mcp_fetch_failed');
  } finally { clearTimeout(timer); controller.abort(); }
}
