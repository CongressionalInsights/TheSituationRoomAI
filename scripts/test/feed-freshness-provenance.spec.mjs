import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeCsvSignals, normalizeJsonSignals } from '../../gcp/mcp-proxy/signal-normalization.js';
import { fetchRaw } from '../../gcp/mcp-proxy/server.js';
import { evaluateInvariant, summarizeProxyPayload, summarizeSignals } from '../../analysis/monitor/lib/audit.mjs';
import { loadMonitoringCatalog } from '../../analysis/monitor/lib/catalog.mjs';

const { entriesById, feeds } = loadMonitoringCatalog();

test('GPSJam selects newest real manifest dates before limiting results', () => {
  const source = process.env.TSR_GPSJAM_MANIFEST;
  const synthetic = 'date,suspect,num_bad_aircraft_hexes,source\n' +
    Array.from({length: 59}, (_, i) => `2022-01-${String(i % 28 + 1).padStart(2,'0')},false,5,fixture`).join('\n') +
    '\n2026-11-17,false,3,fixture\n2026-02-30,false,4,fixture\nunknown,false,0,fixture\n';
  const rows = normalizeCsvSignals(source ? fs.readFileSync(source, 'utf8') : synthetic, entriesById.gpsjam);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].publishedAt, Date.parse('2026-11-17T00:00:00Z'));
  assert.ok(rows.every((row, i) => i === 0 || rows[i-1].publishedAt >= row.publishedAt));
  assert.ok(!rows.some(row => row.title === '2026-02-30' || row.title === 'unknown'));
});

test('GDELT reports provider seen time without assigning retrieval or publication time', () => {
  const feed = entriesById['gdelt-doc'];
  const data = { articles: [
    {title:'Compact time',seendate:'20261118T122000Z'},
    {title:'UTC time',seendate:'2026-11-18T12:19:01Z'},
    {title:'Invalid time',seendate:'20260230T121900Z'},
    {title:'Unknown time'}
  ] };
  const items = normalizeJsonSignals(JSON.stringify(data), feed);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(x => x.seenAt), [Date.parse('2026-11-18T12:20:00Z'), Date.parse('2026-11-18T12:19:01Z'), null, null]);
  assert.ok(items.every(x => x.publishedAt === null && x.timeSemantics === 'seen'));
  assert.equal(summarizeProxyPayload(feed, { body: data }).newestTimestamp, items[0].seenAt);
  assert.equal(summarizeSignals({data:{items}}, feed).newestTimestamp, items[0].seenAt);
  const noData = { newestTimestamp: null, fetchedAt: Date.now() };
  const unknown = evaluateInvariant('freshness', { entry: feed, proxySummary: noData, rawSummary: noData,
    signalSummary: { count: 1, newestTimestamp: null } });
  assert.equal(unknown.regressionClass, 'observation-freshness-unknown');
});

test('OpenSky published fallback stays labeled and missing observation time stays unknown', async t => {
  const feed = feeds.find(x => x.id === 'transport-opensky');
  const aircraft = ['fixture','Fixture',null,0,0,20,10];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).includes('/data/feeds/transport-opensky.json')) {
      return Response.json({body:JSON.stringify({states:[aircraft]}),httpStatus:200,contentType:'application/json'});
    }
    return new Response('Unavailable',{status:503});
  });
  const raw = await fetchRaw(feed,{});
  assert.ok(calls.at(-1).includes('/data/feeds/transport-opensky.json'));
  assert.equal(raw.proxyUsed,'live-cache');
  assert.equal(raw.fallbackUsed,true);
  assert.equal(normalizeJsonSignals(raw.body, feed)[0].publishedAt, null);
});

test('Congress monitor measures actual houseRollCallVotes records independently of mixed source order', () => {
  const feed = entriesById['congress-house-votes'];
  const data = {houseRollCallVotes:[
    { updateDate: '2025-08-04T12:00:00Z' },
    { startDate: '2025-12-03T17:00:00Z' }
  ]};
  const report = summarizeProxyPayload(feed,{body:data,httpStatus:200});
  assert.equal(report.rawItemCount,2);
  assert.equal(report.newestTimestamp, Date.parse('2025-12-03T17:00:00Z'));
});

test('Polymarket requests high day volume and measures an explicit provider update separately', () => {
  const feed = entriesById['polymarket-markets'];
  const url = new URL(feeds.find(x => x.id === feed.id).url);
  assert.equal(url.searchParams.get('order'), 'volume24hr');
  assert.equal(url.searchParams.get('ascending'), 'false');
  const data = [
    {title:'Sample market',startDate:'2026-11-11T12:00:00Z',updatedAt:'2026-11-18T15:50:00.000Z'},
    {title:'Missing dates'}
  ];
  const items = normalizeJsonSignals(JSON.stringify(data),feed);
  assert.equal(items[0].publishedAt,Date.parse(data[0].startDate));
  assert.equal(items[0].updatedAt,Date.parse(data[0].updatedAt));
  assert.equal(items[1].publishedAt,null);
  assert.equal(items[1].updatedAt,null);
  assert.equal(summarizeProxyPayload(feed,{body:data}).newestTimestamp,items[0].updatedAt);
  assert.equal(summarizeSignals({data:{items}},feed).newestTimestamp,items[0].updatedAt);
});

test('State advisory catalog uses the RSS directory’s officially listed advisory route', () => {
  assert.equal(feeds.find(x => x.id === 'state-travel-advisories').url, 'https://travel.state.gov/_res/rss/TAsTWs.xml');
  assert.equal(entriesById['state-travel-advisories'].freshnessWindowMinutes, 720);
});
