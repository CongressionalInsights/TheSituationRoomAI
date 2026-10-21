import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TOOL_NAMES = ['catalog.sources', 'raw.fetch', 'raw.history', 'money.flows', 'signals.list', 'signals.get', 'search.smart'];
// Canonical names/schemas/annotations from the retained SDK 1.32.1 serving baseline.
const TOOL_CONTRACT_SHA256 = '1be3e00aa404732b6e27f127f55b13acba837f524365a9d18310cf768a9daceb';
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const metadataDigest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const requireContract = (condition, message) => { if (!condition) throw new Error(message); };

export async function verifyMcpMetadataCandidate(endpoint, { fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(endpoint);
  requireContract(['/mcp', '/mcp/'].includes(url.pathname) && !url.search && !url.hash, 'Expected an exact /mcp endpoint');
  const base = url.origin;
  const read = async (target, options = {}) => {
    const response = await fetchImpl(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
    requireContract(response.ok, `Metadata HTTP ${response.status}`);
    const text = await response.text();
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
      requireContract(data.length === 1, 'Expected one metadata JSON-RPC response');
      return data[0];
    }
    return JSON.parse(text);
  };
  let id = 0;
  const invoke = async (method, params) => {
    const requestId = ++id;
    const message = await read(url.href, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-11-25'
    }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    requireContract(message.jsonrpc === '2.0' && message.id === requestId && !message.error && message.result && !message.result.isError, `${method} metadata failed`);
    return message.result;
  };
  const health = await read(`${base}/health`);
  requireContract(health.ok === true, 'Unhealthy MCP endpoint');
  const discovery = await read(`${base}/.well-known/mcp.json`);
  requireContract(discovery.endpoint === `${base}/mcp` && JSON.stringify(discovery.tools) === JSON.stringify(TOOL_NAMES), 'MCP discovery contract changed');
  const initialization = await invoke('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tsr-metadata-release', version: '1.0.0' }
  });
  requireContract(initialization.protocolVersion === '2025-11-25' && initialization.capabilities?.tools, 'MCP initialization contract changed');
  const { tools } = await invoke('tools/list', {});
  requireContract(Array.isArray(tools) && JSON.stringify(tools.map(tool => tool.name)) === JSON.stringify(TOOL_NAMES), 'Seven-tool contract changed');
  const toolContract = tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations }));
  const toolContractSha256 = metadataDigest(toolContract);
  requireContract(toolContractSha256 === TOOL_CONTRACT_SHA256, 'Tool schemas or annotations changed');
  // These are the only tools this verifier may invoke. Catalog is local registry/config metadata.
  const catalog = await invoke('tools/call', { name: 'catalog.sources', arguments: { state: 'NC' } });
  const sources = catalog.structuredContent?.sources;
  requireContract(Array.isArray(sources) && sources.length > 0, 'Empty MCP catalogue');
  requireContract(new Set(sources.map(source => source.id)).size === sources.length, 'Duplicate catalogue identities');
  for (const source of sources) {
    requireContract(typeof source.id === 'string' && source.id.length > 0
      && typeof source.configured === 'boolean' && source.configuration?.configured === source.configured
      && Array.isArray(source.configuration.requiredEnv) && Array.isArray(source.configuration.optionalEnv), 'Catalogue configuration contract changed');
  }
  for (const name of ['state-rulemaking', 'state-executive-orders']) {
    const source = sources.find(entry => entry.id === name);
    requireContract(source?.configured === true && source.coverageStatus === 'SUPPORTED'
      && source.coveredStates?.includes('NC') && source.configuration.coveredStates?.includes('NC'), `${name} NC metadata coverage unavailable`);
  }
  const { endpoint: ignoredEndpoint, ...discoveryMetadata } = discovery;
  // Deliberately omit endpoint, serverInfo and clocks; retain all source/config metadata.
  const fingerprint = metadataDigest({ discovery: discoveryMetadata, protocolVersion: initialization.protocolVersion,
    capabilities: initialization.capabilities, toolContract, sources: [...sources].sort((a, b) => a.id.localeCompare(b.id)) });
  return { mode: 'metadata_only', fingerprint, toolContractSha256, toolCount: tools.length, catalogSourceCount: sources.length,
    ncCoverage: { 'state-rulemaking': 'SUPPORTED', 'state-executive-orders': 'SUPPORTED' }, providerToolsCalled: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyMcpMetadataCandidate(String(process.argv[2] || '').trim()), null, 2));
}
