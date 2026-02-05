const DEFAULT_MCP_ENDPOINT = 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';
const DEFAULT_TIMEOUT_MS = 12000;

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

function parseMcpResponse(text) {
  if (!text) return null;
  const streamed = parseMcpStream(text);
  if (streamed) return streamed;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createMcpClient(endpoint) {
  const resolved = endpoint || DEFAULT_MCP_ENDPOINT;

  async function callTool(name, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!resolved) {
      return { error: 'missing_endpoint', message: 'MCP endpoint not configured.' };
    }
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(resolved, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        return { error: 'timeout', message: 'MCP request timed out.' };
      }
      return { error: 'network_error', message: err?.message || 'MCP request failed.' };
    }
    clearTimeout(timer);

    const text = await response.text();
    const parsed = parseMcpResponse(text);
    if (!parsed) {
      return { error: 'invalid_response', message: 'Unable to parse MCP response.' };
    }
    if (parsed.error) {
      return { error: parsed.error.message || 'mcp_error', message: parsed.error.message || 'MCP error.' };
    }
    const result = parsed.result || parsed;
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, message: result?.error?.message || 'MCP request failed.' };
    }
    const structured = result.structuredContent ?? null;
    return { data: structured, raw: result };
  }

  async function searchRelated({ title, summary, category } = {}) {
    const parts = [title, summary].filter(Boolean);
    const query = parts.length ? parts.join(' ') : (category ? `${category} signals` : 'top signals');
    const result = await callTool('search.smart', { query, limit: 12 });
    return result;
  }

  return { callTool, searchRelated };
}
