import { pathToFileURL } from 'node:url';

import { callMcpTool } from '../analysis/monitor/lib/client.mjs';

export async function verifyMcpCandidate(endpoint, { callTool = callMcpTool } = {}) {
  const invoke = async (name, args) => {
    const result = await callTool(endpoint, name, args, 60000);
    if (!result?.ok) {
      throw new Error(`${name} failed: ${result?.error || result?.message || 'unknown error'}`);
    }
    return result.data;
  };

  await invoke('catalog.sources', {});
  const raw = await invoke('raw.fetch', { sourceId: 'swpc-json', limit: 20 });
  if (raw?.fallbackUsed || !Array.isArray(raw?.data) || raw.data.length === 0) {
    throw new Error('raw.fetch did not return parsed, non-fallback SWPC data.');
  }

  const signals = await invoke('signals.list', { sourceId: 'swpc-json', limit: 20 });
  if (signals?.fallbackUsed || !Array.isArray(signals?.items) || signals.items.length === 0) {
    throw new Error('signals.list did not return non-fallback SWPC signals.');
  }
  if (signals.items.some((item) => !String(item?.title || '').trim())) {
    throw new Error('signals.list returned an untitled SWPC signal.');
  }

  return { rawRows: raw.data.length, signals: signals.items.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const endpoint = String(process.argv[2] || '').trim();
  if (!endpoint) throw new Error('MCP endpoint is required.');
  console.log(JSON.stringify(await verifyMcpCandidate(endpoint), null, 2));
}
