import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { callMcpTool } from '../../analysis/monitor/lib/client.mjs';
import { verifyCisaCandidate } from '../verify_cisa_candidate.mjs';

const endpoint = 'https://example.test/mcp';
const catalogUrl = 'https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities.json';
const evidenceUrl = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';
const cve = (n) => `CVE-2026-${String(n).padStart(4, '0')}`;
const id = (value) => createHash('sha1').update(JSON.stringify(['cisa-kev', value])).digest('hex').slice(0, 12);
const row = (n, dateAdded = '2026-09-01') => ({
  cveID: cve(n), vulnerabilityName: `Name ${n}`, shortDescription: `Description ${n}`, dateAdded
});
const signal = (source) => ({
  sourceId: 'cisa-kev', cveID: source.cveID, docId: source.cveID,
  id: id(source.cveID), title: `${source.cveID} - ${source.vulnerabilityName}`,
  vulnerabilityName: source.vulnerabilityName, shortDescription: source.shortDescription,
  dateAdded: source.dateAdded || null,
  publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(source.dateAdded || '')
    && !Number.isNaN(Date.parse(`${source.dateAdded}T00:00:00Z`))
    && new Date(`${source.dateAdded}T00:00:00Z`).toISOString().slice(0, 10) === source.dateAdded
    ? Date.parse(`${source.dateAdded}T00:00:00Z`) : null,
  url: evidenceUrl
});

function fixture() {
  const vulnerabilities = Array.from({ length: 53 }, (_, n) => row(n + 1));
  vulnerabilities[0].dateAdded = 'invalid';
  vulnerabilities.push({ cveID: 'bad', vulnerabilityName: 'bad', shortDescription: 'bad' });
  const items = vulnerabilities.slice(0, 53).map(signal);
  const selected = items[51];
  return {
    raw: { sourceId: 'cisa-kev', fallbackUsed: false, url: catalogUrl,
      data: { catalogVersion: '2026.09', dateReleased: '2026-09-02', count: 54, vulnerabilities } },
    list: { sourceId: 'cisa-kev', fallbackUsed: false, items },
    search: { signals: [selected], sourcesChecked: [{ sourceId: 'cisa-kev', ok: true, fallbackUsed: false }], warnings: null },
    get: { sourceId: 'cisa-kev', fallbackUsed: false, item: selected }
  };
}

async function run(data) {
  const calls = [];
  const output = await verifyCisaCandidate(endpoint, { callTool: async (_endpoint, name, args, timeout, options) => {
    calls.push({ name, args, timeout, options });
    const response = name === 'raw.fetch' ? data.raw : name === 'signals.list' ? data.list
      : name === 'search.smart' ? data.search : data.get;
    return { ok: true, data: response };
  } });
  return { output, calls };
}

test('complete catalog passes with five CISA-only calls and late-index proof', async () => {
  const { output, calls } = await run(fixture());
  assert.equal(output.eligibleCveCount, 53);
  assert.equal(output.listedCveCount, 53);
  assert.equal(output.rawRowCount, 54);
  assert.equal(output.excludedRowCount, 1);
  assert.equal(output.excluded[0].reason, 'invalid_cve');
  assert.equal(output.selectedRawIndex, 51);
  assert.equal(output.selectedCve, cve(52));
  assert.equal(output.selectedId, id(cve(52)));
  assert.equal(output.selectedPublishedAt, Date.parse('2026-09-01T00:00:00Z'));
  assert.match(output.eligibleCveDigest, /^[a-f0-9]{64}$/);
  assert.match(output.rawDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(({ name }) => name), ['raw.fetch', 'signals.list', 'search.smart', 'signals.get', 'signals.get']);
  assert.deepEqual(calls[2].args, { sources: ['cisa-kev'], maxSources: 1, query: cve(52), perSourceLimit: 1, totalLimit: 1 });
  assert.ok(calls.every(({ timeout }) => timeout === 60000));
  assert.deepEqual(calls.map(({ options }) => options), [undefined, { allowCompleteEvent: true }, undefined, undefined, undefined]);
});

test('only opted-in CISA list reads a complete SSE event above the default limit', async (t) => {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { id: requestId } = JSON.parse(body);
    const event = { jsonrpc: '2.0', id: requestId, result: {
      structuredContent: { sourceId: 'cisa-kev', padding: 'x'.repeat(
        request.url === '/oversize' ? 16 * 1024 * 1024 : 2 * 1024 * 1024) }
    } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(event)}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const localEndpoint = `http://127.0.0.1:${server.address().port}/mcp`;

  const ordinary = await callMcpTool(localEndpoint, 'signals.list', { sourceId: 'cisa-kev' }, 10000);
  assert.equal(ordinary.error, 'response_too_large');
  const unrelated = await callMcpTool(localEndpoint, 'signals.list', { sourceId: 'other' }, 10000,
    { allowCompleteEvent: true });
  assert.equal(unrelated.error, 'response_too_large');
  const approved = await callMcpTool(localEndpoint, 'signals.list', { sourceId: 'cisa-kev' }, 10000,
    { allowCompleteEvent: true });
  assert.equal(approved.ok, true);
  assert.equal(approved.data.sourceId, 'cisa-kev');
  assert.equal(approved.data.padding.length, 2 * 1024 * 1024);
  const oversized = await callMcpTool(`http://127.0.0.1:${server.address().port}/oversize`,
    'signals.list', { sourceId: 'cisa-kev' }, 10000, { allowCompleteEvent: true });
  assert.equal(oversized.error, 'response_too_large');
});

test('empty and malformed catalogs fail closed', async () => {
  for (const data of [null, {}, { vulnerabilities: [] }, { vulnerabilities: 'bad' }]) {
    const f = fixture();
    f.raw.data = data;
    await assert.rejects(run(f), { code: 'invalid_catalog' });
  }
  const massDrop = fixture();
  massDrop.raw.data.vulnerabilities.splice(0, 48, ...Array.from({ length: 48 }, () => ({ cveID: 'bad' })));
  await assert.rejects(run(massDrop), { code: 'malformed_mass_drop' });
});

test('missing catalog provenance and fallback fail closed', async () => {
  const missing = fixture();
  delete missing.raw.data.catalogVersion;
  await assert.rejects(run(missing), { code: 'invalid_catalog' });
  for (const surface of ['raw', 'list', 'get']) {
    const fallback = fixture();
    fallback[surface].fallbackUsed = true;
    await assert.rejects(run(fallback), { code: 'invalid_response' });
  }
  const searchFallback = fixture();
  searchFallback.search.sourcesChecked[0].fallbackUsed = true;
  await assert.rejects(run(searchFallback), { code: 'search_failure_or_drift' });
});

test('missing, duplicated, and mismatched signals fail closed', async () => {
  const missing = fixture();
  missing.list.items.pop();
  await assert.rejects(run(missing), { code: 'mass_drop_or_source_drift' });
  const duplicate = fixture();
  duplicate.list.items.push(duplicate.list.items[0]);
  await assert.rejects(run(duplicate), { code: 'duplicate_list_cve' });
  const mismatched = fixture();
  mismatched.list.items[0].publishedAt = Date.now();
  await assert.rejects(run(mismatched), { code: 'identity_or_provenance_mismatch' });
});

test('search and get drift or cross-provider results fail closed', async () => {
  const wrongSearch = fixture();
  wrongSearch.search.sourcesChecked.push({ sourceId: 'other', ok: true, fallbackUsed: false });
  await assert.rejects(run(wrongSearch), { code: 'search_failure_or_drift' });
  const drift = fixture();
  drift.get.item = null;
  await assert.rejects(run(drift), { code: 'source_drift' });
  const mismatch = fixture();
  mismatch.get.item = { ...mismatch.get.item, id: 'wrong' };
  await assert.rejects(run(mismatch), { code: 'identity_or_provenance_mismatch' });
  const changed = fixture();
  let getCount = 0;
  await assert.rejects(verifyCisaCandidate(endpoint, { callTool: async (_endpoint, name) => {
    const data = name === 'raw.fetch' ? changed.raw : name === 'signals.list' ? changed.list
      : name === 'search.smart' ? changed.search : changed.get;
    if (name === 'signals.get' && ++getCount === 2) {
      return { ok: true, data: { ...data, item: { ...data.item, publishedAt: null } } };
    }
    return { ok: true, data };
  } }), { code: 'identity_or_provenance_mismatch' });
  assert.equal(getCount, 2);
});

test('workflow canonical comparison rejects changed catalog content', (t) => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy-mcp-proxy.yml', import.meta.url), 'utf8');
  const marker = 'jq -e --slurpfile candidate /tmp/mcp-diagnostics/cisa-candidate.json \\\n';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  const expression = workflow.slice(start + marker.length).match(/^\s*'([^']+)' \\\n/);
  assert.ok(expression);

  const directory = mkdtempSync(join(tmpdir(), 'cisa-parity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidatePath = join(directory, 'candidate.json');
  const canonicalPath = join(directory, 'canonical.json');
  const candidate = {
    rawDigest: 'catalog-a', catalogVersion: 'v1', dateReleased: '2026-09-22',
    eligibleCveDigest: 'same-cves', selectedId: 'same-id'
  };
  writeFileSync(candidatePath, JSON.stringify(candidate));
  const compare = (canonical) => {
    writeFileSync(canonicalPath, JSON.stringify(canonical));
    return spawnSync('jq', ['-e', '--slurpfile', 'candidate', candidatePath, expression[1], canonicalPath], {
      encoding: 'utf8'
    });
  };
  assert.equal(compare(candidate).status, 0);
  const changedContent = compare({ ...candidate, rawDigest: 'catalog-b' });
  assert.equal(changedContent.status, 1, changedContent.stderr);
  assert.equal(compare({ ...candidate, catalogVersion: 'v2' }).status, 1);
});
