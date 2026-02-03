const DEFAULT_MCP_ENDPOINT = 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';

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

export function createMcpClient(endpoint) {
  const resolved = endpoint || DEFAULT_MCP_ENDPOINT;

  async function callTool(name, args = {}) {
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

    const response = await fetch(resolved, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    const parsed = parseMcpStream(text);
    if (!parsed) {
      return { error: 'invalid_response', message: 'Unable to parse MCP response.' };
    }
    if (parsed.error) {
      return { error: parsed.error.message || 'mcp_error', message: parsed.error.message || 'MCP error.' };
    }
    const result = parsed.result || {};
    const structured = result.structuredContent ?? null;
    return { data: structured, raw: result };
  }

  return { callTool };
}
