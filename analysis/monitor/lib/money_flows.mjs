import { callMcpTool } from './client.mjs';
import { createAlert } from './reporting.mjs';

export function inspectMoneyFlows(response) {
  const alerts = [];
  const alert = (regressionClass, message, source = 'aggregate', severity = 'warning') => alerts.push(createAlert({
    feedId: 'money-flows', regressionClass, severity, message, metadata: { identity: source }
  }));
  const data = response?.data;
  if (!response?.ok || !data || !Array.isArray(data.items)) {
    alert('money-flow-acquisition-failed', 'Money-flow sample could not be acquired; source activity is unknown.');
    return { status: 'degraded', alerts, coverage: null, sources: {} };
  }
  if (data.schemaVersion !== 2 || data.coverage?.status !== 'discovery_sample' || data.coverage?.complete !== false || data.summary?.basis !== 'returned_rows_only') {
    alert('money-flow-contract', 'Money-flow sample is missing its financial or coverage contract.');
  }
  const sources = {};
  for (const name of ['lda', 'ldaContributions', 'fec', 'sam', 'usaspending']) {
    const source = data.sources?.[name];
    const coverage = source?.coverage;
    sources[name] = { count: source?.count ?? null, returnedCount: source?.returnedCount ?? null, coverage: coverage ?? null };
    if (!coverage || typeof coverage.complete !== 'boolean') {
      alert('money-flow-source-contract', `${name}: source coverage is missing.`, name);
    } else if (coverage.status === 'unavailable' || source.error) {
      alert('money-flow-source-unavailable', `${name}: acquisition unavailable or failed; not evidence of zero activity.`, name);
    } else if (!coverage.complete) {
      alert('money-flow-partial-coverage', `${name}: bounded discovery did not exhaust its queries.`, name, 'info');
    }
  }
  const ids = new Set();
  for (const item of data.items) {
    const identity = `${item.source}:${item.sourceId}`;
    if (!item.sourceId || ids.has(identity)) alert('money-flow-identity', 'Missing or duplicate normalized source identity.', item.source);
    ids.add(identity);
    if (item.amount !== null && !Number.isFinite(item.amount)) alert('money-flow-amount', 'Malformed financial amount.', item.source);
    if (item.source === 'SAM.gov' && (item.amount !== null || item.bucket !== 'registry')) alert('money-flow-registration-as-money', 'SAM registration was represented as spending.', 'sam');
    if (item.source === 'USAspending' && (item.type !== 'Federal Transaction' || item.amountBasis !== 'transaction_obligation')) alert('money-flow-transaction-semantics', 'USAspending row lost its transaction semantics.', 'usaspending');
    if (item.source === 'OpenFEC' && !item.attribution) alert('money-flow-attribution', 'FEC party attribution is missing.', 'fec');
  }
  return { status: alerts.some((a) => a.severity !== 'info') ? 'degraded' : 'ok', alerts, coverage: data.coverage, sources };
}

export async function auditMoneyFlows(options, call = callMcpTool) {
  const end = new Date().toISOString().slice(0, 10);
  const start = `${end.slice(0, 4)}-01-01`;
  // One narrow sample in the existing full audit. Never replay the entire provider fan-out.
  const result = await call(options.mcp, 'money.flows', { query: 'CVS Health', start, end, limit: 10 }, 60000, { retry: false });
  return { ...inspectMoneyFlows(result), query: 'CVS Health', range: { start, end },
    note: 'Transport, source coverage, identities and numeric semantics only; this sample cannot prove completeness or original point-in-time coverage.' };
}
