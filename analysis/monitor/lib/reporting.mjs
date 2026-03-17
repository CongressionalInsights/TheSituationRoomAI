import { hashContent } from './client.mjs';

const SEVERITY_RANK = {
  critical: 3,
  warning: 2,
  info: 1,
  ok: 0
};

function rankSeverity(value) {
  return SEVERITY_RANK[value] ?? 0;
}

export function createAlert({
  feedId,
  regressionClass,
  severity,
  message,
  docsHash = null,
  metadata = {}
}) {
  const fingerprint = docsHash
    || hashContent(JSON.stringify({
      regressionClass,
      message,
      identity: metadata.identity || metadata.url || metadata.surfaceKey || null
    })).slice(0, 12);
  return {
    feedId,
    regressionClass,
    severity,
    message,
    docsHash,
    metadata,
    dedupeKey: `${feedId}:${regressionClass}:${fingerprint}`
  };
}

export function applyKnownUpstreamQuirks(alert, quirks = []) {
  for (const quirk of quirks) {
    if (!quirk || quirk.regressionClass !== alert.regressionClass) continue;
    return {
      ...alert,
      severity: quirk.severity || alert.severity,
      knownQuirkId: quirk.id || null,
      suppressNew: Boolean(quirk.suppressNew),
      message: quirk.note ? `${alert.message} ${quirk.note}` : alert.message
    };
  }
  return alert;
}

export function dedupeAlerts(alerts = []) {
  const deduped = new Map();
  for (const alert of alerts) {
    const existing = deduped.get(alert.dedupeKey);
    if (!existing || rankSeverity(alert.severity) > rankSeverity(existing.severity)) {
      deduped.set(alert.dedupeKey, alert);
    }
  }
  return [...deduped.values()].sort((a, b) => {
    const severityDelta = rankSeverity(b.severity) - rankSeverity(a.severity);
    if (severityDelta) return severityDelta;
    return a.feedId.localeCompare(b.feedId);
  });
}

export function diffAlerts(currentAlerts = [], previousAlerts = []) {
  const previous = new Map(previousAlerts.map((alert) => [alert.dedupeKey, alert]));
  const current = new Map(currentAlerts.map((alert) => [alert.dedupeKey, alert]));

  const newAlerts = currentAlerts.filter((alert) => {
    if (alert.suppressNew && previous.has(alert.dedupeKey)) return false;
    return !previous.has(alert.dedupeKey);
  });
  const resolvedAlerts = previousAlerts.filter((alert) => !current.has(alert.dedupeKey));
  const ongoingAlerts = currentAlerts.filter((alert) => previous.has(alert.dedupeKey));

  return {
    newAlerts,
    resolvedAlerts,
    ongoingAlerts
  };
}

export function summarizeAlerts(alerts = []) {
  return alerts.reduce((acc, alert) => {
    acc.total += 1;
    acc[alert.severity] = (acc[alert.severity] || 0) + 1;
    return acc;
  }, {
    total: 0,
    critical: 0,
    warning: 0,
    info: 0
  });
}

export function buildMarkdownReport(report) {
  const { summary = {}, alerts = [], deltas = {}, feedResults = [], docResults = [] } = report || {};
  const lines = [];
  lines.push(`# Data Monitor: ${report.mode}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Feeds checked: ${summary.checkedFeeds || 0}/${summary.totalFeeds || 0}`);
  lines.push(`Alerts: critical ${summary.critical || 0}, warning ${summary.warning || 0}, info ${summary.info || 0}`);
  lines.push(`Changes: new ${deltas.newAlerts?.length || 0}, resolved ${deltas.resolvedAlerts?.length || 0}, ongoing ${deltas.ongoingAlerts?.length || 0}`);
  lines.push('');

  const newAlerts = deltas.newAlerts || [];
  if (newAlerts.length) {
    lines.push('## New Alerts');
    newAlerts.slice(0, 10).forEach((alert) => {
      lines.push(`- [${alert.severity}] ${alert.feedId}: ${alert.message}`);
    });
    lines.push('');
  }

  const criticalAlerts = alerts.filter((alert) => alert.severity === 'critical');
  if (criticalAlerts.length) {
    lines.push('## Critical');
    criticalAlerts.slice(0, 12).forEach((alert) => {
      lines.push(`- ${alert.feedId}: ${alert.message}`);
    });
    lines.push('');
  }

  const changedDocs = docResults.filter((result) => result.changed);
  if (changedDocs.length) {
    lines.push('## Official Surface Changes');
    changedDocs.slice(0, 10).forEach((result) => {
      lines.push(`- ${result.surfaceType} ${result.url} (${result.classification?.severity || 'info'})`);
    });
    lines.push('');
  }

  const degradedFeeds = feedResults.filter((result) => result.status !== 'ok');
  if (degradedFeeds.length) {
    lines.push('## Degraded Feeds');
    degradedFeeds.slice(0, 12).forEach((result) => {
      lines.push(`- ${result.feedId}: ${result.status} (${result.alerts.length} alerts)`);
    });
    lines.push('');
  }

  if (!newAlerts.length && !criticalAlerts.length && !changedDocs.length && !degradedFeeds.length) {
    lines.push('No actionable changes detected.');
  }

  return `${lines.join('\n').trim()}\n`;
}
