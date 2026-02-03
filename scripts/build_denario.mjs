import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputDir = path.join(root, 'public', 'data');
const outputPath = path.join(outputDir, 'denario.json');
const minHours = Number(process.env.DENARIO_MIN_HOURS || 6);

function readExistingStamp() {
  if (!fs.existsSync(outputPath)) return null;
  try {
    const raw = fs.readFileSync(outputPath, 'utf8');
    const data = JSON.parse(raw);
    const stamp = Date.parse(data.generatedAt || data.generated_at || data.timestamp || '');
    return Number.isFinite(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

function getDefaultMcpProxy() {
  const configPath = path.join(root, 'public', 'config.js');
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  const match = raw.match(/mcpProxy\s*=\s*window\.SR_CONFIG\.mcpProxy\s*\|\|\s*'([^']+)'/);
  return match ? match[1] : null;
}

function parseMcpResponse(text) {
  const lines = text.split('\n').map((line) => line.trim());
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!dataLines.length) return null;
  const payload = dataLines[dataLines.length - 1].replace(/^data:\s*/, '');
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function callMcpTool(endpoint, name, args) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = parseMcpResponse(text);
  if (!payload) throw new Error('Unable to parse MCP response');
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  return payload.result?.structuredContent ?? payload.result ?? null;
}

function normalizeItems(data) {
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.signals)
        ? data.signals
        : [];
  return items.map((item) => ({
    title: item.title || item.name || item.label || 'Signal',
    summary: item.summary || item.detailSummary || item.description || '',
    source: item.source || item.provider || item.feed || '',
    url: item.url || item.link || '',
    category: item.category || item.type || '',
    publishedAt: item.publishedAt || item.updatedAt || item.timestamp || null
  }));
}

async function main() {
  const lastStamp = readExistingStamp();
  if (lastStamp) {
    const ageHours = (Date.now() - lastStamp) / (1000 * 60 * 60);
    if (ageHours < minHours) {
      console.log(`Denario build skipped: last generated ${ageHours.toFixed(2)} hours ago.`);
      return;
    }
  }

  const endpoint = process.env.MCP_PROXY || getDefaultMcpProxy();
  if (!endpoint) {
    throw new Error('MCP proxy endpoint not configured. Set MCP_PROXY env or update public/config.js.');
  }

  const data = await callMcpTool(endpoint, 'search.smart', {
    query: 'top signals',
    limit: 40
  });
  const items = normalizeItems(data).slice(0, 12);
  const summary = data?.summary || data?.overview || `Top signals across ${items.length} items.`;

  const payload = {
    summary,
    items,
    generatedAt: new Date().toISOString()
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(`Denario insights written to ${outputPath}`);
}

main().catch((error) => {
  console.error('Denario build failed:', error.message);
  process.exit(1);
});
