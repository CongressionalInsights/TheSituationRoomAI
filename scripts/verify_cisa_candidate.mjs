import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { callMcpTool } from '../analysis/monitor/lib/client.mjs';

const SOURCE = 'cisa-kev';
const EVIDENCE_URL = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';
const CATALOG_URL = 'https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities.json';
const text = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const itemId = (cve) => createHash('sha1').update(JSON.stringify([SOURCE, cve])).digest('hex').slice(0, 12);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sourceDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

function classifyRows(rows) {
  const eligible = new Map();
  const excluded = [];
  rows.forEach((row, index) => {
    const cve = text(row?.cveID).toUpperCase();
    const reason = !row || typeof row !== 'object' || Array.isArray(row) ? 'not_object'
      : !/^CVE-\d{4}-\d{4,}$/.test(cve) ? 'invalid_cve'
        : !text(row.vulnerabilityName) ? 'missing_name'
          : !text(row.shortDescription) ? 'missing_description' : null;
    if (reason) {
      excluded.push({ index, cve: cve || null, reason });
    } else if (eligible.has(cve)) {
      fail('duplicate_catalog_cve', `Duplicate eligible catalog CVE: ${cve}`);
    } else {
      eligible.set(cve, { row, index });
    }
  });
  return { eligible, excluded };
}

function checkEnvelope(value, name) {
  if (!value || typeof value !== 'object' || value.fallbackUsed !== false || value.error) {
    fail('invalid_response', `${name} returned missing, fallback, or error data`);
  }
  if (value.sourceId !== undefined && value.sourceId !== SOURCE) {
    fail('wrong_source', `${name} returned another source`);
  }
}

function checkItem(item, cve, row, name) {
  const expectedDate = sourceDate(row.dateAdded);
  if (!item || item.sourceId !== SOURCE || item.cveID !== cve || item.docId !== cve
    || item.id !== itemId(cve) || item.title !== `${cve} - ${text(row.vulnerabilityName)}`
    || item.url !== EVIDENCE_URL || text(item.vulnerabilityName) !== text(row.vulnerabilityName)
    || text(item.shortDescription) !== text(row.shortDescription)
    || item.publishedAt !== expectedDate || item.dateAdded !== (text(row.dateAdded) || null)) {
    fail('identity_or_provenance_mismatch', `${name} disagrees with catalog row ${cve}`);
  }
}

export async function verifyCisaCandidate(endpoint, { callTool = callMcpTool } = {}) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || !url.host || url.username || url.password
    || url.search || url.hash || !url.pathname.endsWith('/mcp')) {
    fail('invalid_endpoint', 'Provide an exact MCP endpoint URL without credentials, query, or fragment');
  }
  const calls = [];
  const invoke = async (name, args) => {
    calls.push(name);
    const response = await callTool(endpoint, name, args, 60000,
      name === 'signals.list' ? { allowCompleteEvent: true } : undefined);
    if (!response?.ok) fail('tool_failure', `${name} failed: ${response?.error || 'unknown error'}`);
    return response.data;
  };

  const raw = await invoke('raw.fetch', { sourceId: SOURCE, format: 'json' });
  checkEnvelope(raw, 'raw.fetch');
  if (raw.url !== CATALOG_URL || !Array.isArray(raw.data?.vulnerabilities)
    || !text(raw.data.catalogVersion) || !text(raw.data.dateReleased)
    || raw.data.vulnerabilities.length === 0) {
    fail('invalid_catalog', 'raw.fetch lacks the official, versioned, nonempty parsed CISA catalog');
  }
  const { eligible, excluded } = classifyRows(raw.data.vulnerabilities);
  if (!eligible.size) fail('empty_eligible_set', 'CISA catalog has no eligible CVEs');
  if (excluded.length * 10 > raw.data.vulnerabilities.length) {
    fail('malformed_mass_drop', `${excluded.length} of ${raw.data.vulnerabilities.length} catalog rows are ineligible`);
  }
  if (raw.data.count !== undefined && raw.data.count !== raw.data.vulnerabilities.length) {
    fail('catalog_count_mismatch', 'Catalog count differs from vulnerabilities length');
  }
  const list = await invoke('signals.list', { sourceId: SOURCE });
  checkEnvelope(list, 'signals.list');
  if (!Array.isArray(list.items) || !list.items.length) fail('empty_list', 'signals.list returned no CISA items');
  const listed = new Map();
  for (const item of list.items) {
    const cve = item?.cveID;
    if (!eligible.has(cve)) fail('unexpected_cve_or_drift', `List CVE absent from raw catalog: ${cve}`);
    if (listed.has(cve)) fail('duplicate_list_cve', `Duplicate list CVE: ${cve}`);
    checkItem(item, cve, eligible.get(cve).row, 'signals.list');
    listed.set(cve, item);
  }
  if (listed.size !== eligible.size) {
    const missing = [...eligible.keys()].filter((cve) => !listed.has(cve));
    fail('mass_drop_or_source_drift', `List omitted ${missing.length} eligible CVE(s); source drift cannot be excluded: ${missing.slice(0, 5).join(', ')}`);
  }
  const dated = [...eligible.entries()].filter(([, value]) => sourceDate(value.row.dateAdded) !== null);
  const proof = dated.find(([, value]) => value.index > 50) || dated[0];
  if (!proof) fail('no_dated_proof', 'No eligible CVE has a valid source date');
  const [cve, { row, index }] = proof;
  const id = listed.get(cve).id;
  const search = await invoke('search.smart', {
    sources: [SOURCE], maxSources: 1, query: cve, perSourceLimit: 1, totalLimit: 1
  });
  if (!search || !Array.isArray(search.signals) || search.signals.length !== 1
    || !Array.isArray(search.sourcesChecked) || search.sourcesChecked.length !== 1
    || search.sourcesChecked[0].sourceId !== SOURCE || search.sourcesChecked[0].ok !== true
    || search.sourcesChecked[0].fallbackUsed !== false || search.warnings?.length) {
    fail('search_failure_or_drift', 'CISA-only search failed, fell back, or changed source');
  }
  checkItem(search.signals[0], cve, row, 'search.smart');
  if (search.signals[0].id !== id) fail('search_identity_mismatch', 'Search ID differs from list ID');
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const got = await invoke('signals.get', { sourceId: SOURCE, id });
    checkEnvelope(got, 'signals.get');
    if (!got.item) fail('source_drift', 'Chosen CVE disappeared between MCP reads');
    checkItem(got.item, cve, row, 'signals.get');
  }
  return {
    ok: true, endpoint, sourceId: SOURCE,
    catalogVersion: raw.data.catalogVersion, dateReleased: raw.data.dateReleased,
    rawDigest: hash(raw.data), eligibleCveDigest: hash([...eligible.keys()].sort()),
    rawRowCount: raw.data.vulnerabilities.length, eligibleCveCount: eligible.size,
    excludedRowCount: excluded.length, excluded, listedCveCount: listed.size,
    selectedCve: cve, selectedId: id, selectedPublishedAt: sourceDate(row.dateAdded),
    selectedRawIndex: index, calls
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail('usage', 'Usage: node scripts/verify_cisa_candidate.mjs <exact-mcp-endpoint>');
    console.log(JSON.stringify(await verifyCisaCandidate(process.argv[2])));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code || 'verification_failed', error: error.message }));
    process.exitCode = 1;
  }
}
