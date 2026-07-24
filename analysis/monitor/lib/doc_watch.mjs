import { fetchText, hashContent } from './client.mjs';

const BREAKING_CHANGE_PATTERN = /\b(breaking|deprecat|sunset|removed|migration|schema|parameter|field|authentication|oauth|token|rate limit|sorting|sort order|required)\b/i;
const STATUS_INCIDENT_PATTERN = /\b(outage|degraded|delay|incident|maintenance|unavailable)\b/i;
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/ig;

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function normalizeDocText(text = '', contentType = 'text/plain') {
  let normalized = String(text || '');
  if (String(contentType).includes('html')) {
    normalized = normalized
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    normalized = decodeHtmlEntities(normalized);
  }
  return normalized
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

export function extractDatedEntries(text = '') {
  const normalized = normalizeDocText(text);
  if (!normalized) return [];
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dated = [];
  for (const line of lines) {
    const matches = [...line.matchAll(DATE_PATTERN)];
    if (!matches.length) continue;
    for (const match of matches) {
      dated.push({
        date: match[0],
        text: line.slice(0, 240)
      });
    }
  }
  const seen = new Set();
  return dated.filter((entry) => {
    const key = `${entry.date}|${entry.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

export function classifyDocChange({
  previous = null,
  current,
  surfaceType,
  tier = 'standard',
  acceptedHashRequired = false
}) {
  if (!current?.hash) return null;
  if (current.requiredMarkers?.length) {
    if (!current.missingRequiredMarkers?.length) return null;
    return {
      regressionClass: 'docs-contract-change',
      severity: tier === 'core' ? 'critical' : 'warning',
      message: `Official ${surfaceType} surface is missing required contract markers.`
    };
  }
  if (!acceptedHashRequired && !previous?.hash) return null;
  if (!acceptedHashRequired && previous?.hash === current.hash) return null;
  if (surfaceType === 'support') {
    return {
      regressionClass: 'support-surface-updated',
      severity: 'warning',
      message: 'Official support surface changed.'
    };
  }
  const latestText = current.normalizedText || '';
  if (surfaceType === 'status') {
    return {
      regressionClass: 'status-surface-updated',
      severity: STATUS_INCIDENT_PATTERN.test(latestText) && tier === 'core' ? 'critical' : 'warning',
      message: 'Official status surface changed.'
    };
  }
  if (BREAKING_CHANGE_PATTERN.test(latestText)) {
    return {
      regressionClass: 'docs-contract-change',
      severity: tier === 'core' ? 'critical' : 'warning',
      message: 'Official docs or changelog includes contract-change keywords.'
    };
  }
  return {
    regressionClass: 'docs-surface-updated',
    severity: surfaceType === 'changelog' && tier === 'core' ? 'critical' : 'warning',
    message: 'Official docs or changelog surface changed.'
  };
}

function pickRepresentativeFeedId(surface) {
  const sorted = [...surface.feedIds].sort((a, b) => {
    if (surface.tiers[a] === surface.tiers[b]) return a.localeCompare(b);
    return surface.tiers[a] === 'core' ? -1 : 1;
  });
  return sorted[0] || null;
}

export function collectDocumentSurfaces(entries) {
  const surfaces = new Map();
  for (const entry of entries) {
    const urls = {
      docs: entry.docsUrl,
      changelog: entry.changelogUrl,
      status: entry.statusUrl,
      support: entry.supportUrl
    };
    for (const [surfaceType, url] of Object.entries(urls)) {
      if (!url) continue;
      const key = `${surfaceType}:${url}`;
      const existing = surfaces.get(key) || {
        key,
        surfaceType,
        url,
        feedIds: [],
        tiers: {},
        acceptedHashes: [],
        enforceAcceptedHashes: false,
        requiredMarkers: []
      };
      existing.feedIds.push(entry.id);
      existing.tiers[entry.id] = entry.tier;
      existing.enforceAcceptedHashes ||= entry.enforceAcceptedSurfaceHashes === true;
      const acceptedHash = entry.acceptedSurfaceHashes?.[surfaceType]?.[url];
      if (Array.isArray(acceptedHash)) {
        existing.acceptedHashes.push(...acceptedHash);
      } else if (acceptedHash) {
        existing.acceptedHashes.push(acceptedHash);
      }
      const requiredMarkers = entry.requiredSurfaceMarkers?.[surfaceType]?.[url];
      if (Array.isArray(requiredMarkers)) {
        existing.requiredMarkers.push(...requiredMarkers);
      }
      surfaces.set(key, existing);
    }
  }
  return [...surfaces.values()].map((surface) => ({
    ...surface,
    acceptedHashes: [...new Set(surface.acceptedHashes.filter(Boolean))],
    requiredMarkers: [...new Set(surface.requiredMarkers.filter((marker) => (
      typeof marker === 'string' && marker.length > 0
    )))],
    representativeFeedId: pickRepresentativeFeedId(surface)
  }));
}

export async function watchDocumentation({ entries, previousDocs = {}, timeoutMs = 30000 }) {
  const surfaces = collectDocumentSurfaces(entries);
  const concurrency = 6;
  const queue = [...surfaces];
  const results = [];

  async function worker() {
    while (queue.length) {
      const surface = queue.shift();
      if (!surface) return;
      const response = await fetchText(surface.url, {
        headers: {
          'Accept': 'text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.8'
        },
        timeoutMs
      });
      const contentType = response.headers?.get('content-type') || 'text/plain';
      const normalizedText = normalizeDocText(response.text, contentType);
      const missingRequiredMarkers = surface.requiredMarkers.filter(
        (marker) => !normalizedText.includes(marker)
      );
      const current = {
        key: surface.key,
        surfaceType: surface.surfaceType,
        url: surface.url,
        representativeFeedId: surface.representativeFeedId,
        feedIds: surface.feedIds,
        status: response.status,
        ok: response.ok,
        error: response.error || null,
        contentType,
        etag: response.headers?.get('etag') || null,
        lastModified: response.headers?.get('last-modified') || null,
        hash: response.ok ? hashContent(normalizedText) : null,
        acceptedHashRequired: surface.enforceAcceptedHashes && surface.acceptedHashes.length > 0,
        requiredMarkers: surface.requiredMarkers,
        missingRequiredMarkers,
        normalizedText,
        datedEntries: response.ok ? extractDatedEntries(normalizedText) : [],
        generatedAt: new Date().toISOString()
      };
      const previous = previousDocs[surface.key] || null;
      const accepted = response.ok && Array.isArray(surface.acceptedHashes) && current.hash
        ? surface.acceptedHashes.includes(current.hash)
        : false;
      const contractConfigured = surface.requiredMarkers.length > 0;
      const contractSatisfied = response.ok
        && contractConfigured
        && missingRequiredMarkers.length === 0;
      const acceptedBaseline = contractConfigured ? contractSatisfied : accepted;
      const classification = response.ok
        ? (acceptedBaseline
            ? null
            : classifyDocChange({
              previous,
              current,
              surfaceType: surface.surfaceType,
              tier: surface.feedIds.some((feedId) => surface.tiers[feedId] === 'core') ? 'core' : 'standard',
              acceptedHashRequired: current.acceptedHashRequired
            }))
        : {
          regressionClass: 'docs-fetch-failed',
          severity: surface.feedIds.some((feedId) => surface.tiers[feedId] === 'core') ? 'warning' : 'info',
          message: response.error || `HTTP ${response.status}`
        };
      results.push({
        ...current,
        changed: Boolean(classification),
        acceptedBaseline,
        classification
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, surfaces.length || 1) }, () => worker()));
  return results.sort((a, b) => a.key.localeCompare(b.key));
}
