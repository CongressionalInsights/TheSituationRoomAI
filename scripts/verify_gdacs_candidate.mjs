import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { callMcpTool, readMcpResponseText } from '../analysis/monitor/lib/client.mjs';
import { gdacsMachineMime, gdacsMachineFallback, parseGdacsMachineBody, sourceUrl } from '../gcp/mcp-proxy/gdacs-machine.js';

const sourceId = 'gdacs-alerts';
const rssUrl = 'https://www.gdacs.org/contentdata/xml/rss.xml';
const freshnessMs = 90 * 60_000;

function fresh(value, now) {
  return Number.isSafeInteger(value) && now >= value && now - value <= freshnessMs;
}

function readRssDates(body) {
  if (typeof body !== 'string' || body.length > 2 * 1024 * 1024
    || /<!DOCTYPE|<!ENTITY/i.test(body) || !/^\s*(?:<\?xml[^>]*>\s*)?<rss\b/i.test(body)) return [];
  const leaf = createRequire(new URL('../gcp/mcp-proxy/package.json', import.meta.url));
  const require = createRequire(import.meta.url);
  let xml;
  try { xml = leaf('fast-xml-parser'); } catch { xml = require('fast-xml-parser'); }
  if (xml.XMLValidator.validate(body) !== true) return [];
  const items = new xml.XMLParser({ processEntities: false, isArray: name => name === 'item' }).parse(body)?.rss?.channel?.item;
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (typeof item?.title !== 'string' || !item.title.trim() || typeof item.link !== 'string'
      || typeof item['georss:point'] !== 'string' || typeof item.pubDate !== 'string') return [];
    const point = item['georss:point'].trim().split(/\s+/u).map(Number);
    const stamp = Date.parse(item.pubDate);
    try {
      const link = new URL(item.link.replaceAll('&amp;', '&'));
      if (!['http:', 'https:'].includes(link.protocol) || link.hostname !== 'www.gdacs.org'
        || link.pathname !== '/report.aspx' || link.username || link.password
        || point.length !== 2 || !Number.isFinite(point[0]) || Math.abs(point[0]) > 90
        || !Number.isFinite(point[1]) || Math.abs(point[1]) > 180 || !Number.isFinite(stamp)) return [];
      return [stamp];
    } catch { return []; }
  });
}

export function verifyGdacsEnvelope(payload, surface, now = Date.now()) {
  const isMachine = payload?.contentType === gdacsMachineMime;
  const machine = isMachine ? parseGdacsMachineBody(payload.body) : null;
  if (isMachine) {
    assert.ok(machine && payload.fallbackUsed === true, 'Invalid GDACS update envelope or fallback attribution.');
    if (!payload.proxyUsed && payload.fetchedUrl === sourceUrl && (surface === 'mcp' || payload.fallback === gdacsMachineFallback)) {
      if (surface !== 'mcp') assert.equal(payload.stale, true, 'Primary degradation must be preserved.');
      if (fresh(machine.newestUpdateAt, now)) return {
        status: 'machine_fallback_verified', count: machine.items.length, newestAt: machine.newestUpdateAt,
        timeSemantics: 'updated', coverage: machine.coverage, provider: sourceUrl
      };
    }
    return { status: 'cache_or_unavailable', newestAt: machine.newestUpdateAt, timeSemantics: 'updated' };
  }
  const dates = readRssDates(payload?.body);
  const newestAt = dates.filter(stamp => stamp <= now).reduce((max, stamp) => Math.max(max, stamp), 0);
  const knownMcpRss = surface !== 'mcp' || (payload?.url === rssUrl &&
    (payload.fetchedUrl === rssUrl || ['allorigins', 'jina'].includes(payload.proxyUsed)));
  if (!payload?.error && !payload?.stale && !payload?.fallback && !payload?.fallbackUsed
    && knownMcpRss && fresh(newestAt, now)) {
    return { status: 'primary_unexercised', count: dates.length, newestAt, timeSemantics: 'published', source: rssUrl, transport: surface === 'mcp' ? payload.proxyUsed || 'direct' : 'not_reported' };
  }
  if (surface === 'pages' && payload?.fallback === 'live-cache') assert.equal(payload.stale, true, 'Published cache must remain visibly stale.');
  return { status: 'cache_or_unavailable', newestAt: newestAt || null, timeSemantics: 'published' };
}

export async function verifyGdacsCandidate(surface, target, { fetchImpl = fetch, callTool = callMcpTool, now = Date.now } = {}) {
  if (surface === 'pages') return verifyGdacsEnvelope(JSON.parse(fs.readFileSync(target, 'utf8')), surface, now());
  const url = new URL(target);
  assert.ok(['feed', 'mcp'].includes(surface) && url.protocol === 'https:'
    && new RegExp('^gha-[0-9]+-[0-9]+---situation-room-' + surface + '(?:-[a-z0-9]+)+\\.a\\.run\\.app$').test(url.hostname)
    && url.origin === target, 'Expected an existing release candidate tag URL.');
  if (surface === 'feed') {
    const response = await fetchImpl(target + '/api/feed', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: sourceId, force: true }), redirect: 'error', signal: AbortSignal.timeout(60_000)
    });
    assert.ok(response.ok, 'GDACS Feed candidate request failed.');
    const payload = JSON.parse(await readMcpResponseText(response));
    assert.equal(payload.id, sourceId);
    return verifyGdacsEnvelope(payload, surface, now());
  }
  const endpoint = target + '/mcp';
  const raw = await callTool(endpoint, 'raw.fetch', { sourceId, format: 'text' }, 30_000, { retry: false, redirect: 'error' });
  assert.ok(raw.ok && raw.data?.sourceId === sourceId, 'GDACS MCP raw response unavailable.');
  const result = verifyGdacsEnvelope(raw.data, surface, now());
  if (result.status !== 'machine_fallback_verified') return result;
  const list = await callTool(endpoint, 'signals.list', { sourceId, limit: 25 }, 30_000, { retry: false, redirect: 'error' });
  const items = list.data?.items;
  if (list.ok && list.data?.sourceId === sourceId && list.data.fallbackUsed === false
    && !list.data.proxyUsed && list.data.fetchedUrl === rssUrl && Array.isArray(items)
    && items.some(item => fresh(item.publishedAt, now()))) {
    return { ...result, status: 'machine_raw_verified_signals_primary_unexercised' };
  }
  assert.ok(list.ok && list.data?.sourceId === sourceId && list.data?.fallbackUsed && !list.data.proxyUsed
    && list.data.fetchedUrl === sourceUrl && Array.isArray(items) && items.length && items.length <= 25
    && items.every(row => row.sourceId === sourceId && row.source === 'GDACS' && row.publishedAt === null
      && row.timeSemantics === 'updated' && row.coverage?.product === 'events4app'
      && Number.isSafeInteger(row.updatedAt) && row.updatedAt <= now()
      && Number.isFinite(row.geo?.lat) && Math.abs(row.geo.lat) <= 90 && Number.isFinite(row.geo?.lon) && Math.abs(row.geo.lon) <= 180)
    && items.some(row => fresh(row.updatedAt, now())), 'GDACS MCP typed list did not independently verify the machine source.');
  return { ...result, signalsCount: items.length, signalsNewestAt: Math.max(...items.map(row => row.updatedAt)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [surface, target] = process.argv.slice(2);
  try {
    const result = await verifyGdacsCandidate(surface, target);
    console.log(JSON.stringify(result));
    if (surface !== 'pages' && result.status === 'cache_or_unavailable') process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: 'verification_failed', surface }));
    process.exitCode = 1;
  }
}
