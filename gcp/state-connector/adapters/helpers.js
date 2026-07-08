import { XMLParser } from 'fast-xml-parser';
import { STATE_NAMES } from '../constants.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: true
});

const entityMap = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: '-',
  mdash: '-'
};

export function decodeEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entityMap[name.toLowerCase()] || match);
}

export function cleanText(value = '') {
  return decodeEntities(String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function absoluteUrl(url, baseUrl) {
  if (!url) return '';
  try {
    return new URL(decodeEntities(url), baseUrl).toString();
  } catch {
    return decodeEntities(url);
  }
}

export function parseXml(text) {
  return xmlParser.parse(text || '');
}

export function arrayify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function rssItems(text) {
  const parsed = parseXml(text);
  const channel = parsed?.rss?.channel || parsed?.feed || {};
  const items = arrayify(channel.item || channel.entry);
  return items.map((item) => ({
    title: cleanText(textValue(item.title)),
    summary: cleanText(textValue(item.description || item.summary || item.content)),
    url: cleanText(textValue(item.link?.['@_href'] || item.link)),
    updatedAt: cleanText(textValue(item.pubDate || item.updated || item.published || item['dc:date'])),
    agency: cleanText(textValue(item.author || item['dc:creator']))
  })).filter((item) => item.title);
}

export function textValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return value['#cdata'] || value['#text'] || '';
  return String(value);
}

export function isoDate(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  const normalized = raw
    .replace(/\bEDT\b/g, '-0400')
    .replace(/\bEST\b/g, '-0500')
    .replace(/\bCDT\b/g, '-0500')
    .replace(/\bCST\b/g, '-0600')
    .replace(/\bPDT\b/g, '-0700')
    .replace(/\bPST\b/g, '-0800');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

export function dateFromTitle(title) {
  const match = String(title || '').match(/(?:-|,)\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[a-z]*,?\s*\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s*$/i);
  return match ? isoDate(match[1]) : '';
}

export function makeSignal({
  id,
  title,
  summary = '',
  url = '',
  updatedAt = '',
  state,
  agency = '',
  status = '',
  effectiveDate = '',
  source,
  signalType
}) {
  const stateCode = String(state || '').toUpperCase();
  const cleanTitle = cleanText(title);
  if (!cleanTitle || !stateCode || !signalType) return null;
  return {
    id: cleanText(id || `${stateCode}:${signalType}:${cleanTitle}`),
    title: cleanTitle,
    summary: cleanText(summary),
    url,
    updatedAt: isoDate(updatedAt) || isoDate(effectiveDate) || '',
    state: stateCode,
    stateName: STATE_NAMES[stateCode] || stateCode,
    agency: cleanText(agency),
    status: cleanText(status),
    effectiveDate: isoDate(effectiveDate),
    source: cleanText(source || 'State Connector'),
    signalType
  };
}

export function uniqueSignals(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items.filter(Boolean)) {
    const key = item.id || `${item.state}:${item.signalType}:${item.title}:${item.updatedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export function extractAnchorDatePairs(html, {
  rowPattern,
  baseUrl,
  state,
  source,
  signalType,
  agency,
  status = ''
}) {
  const results = [];
  for (const match of html.matchAll(rowPattern)) {
    const href = match.groups?.href || match[1];
    const title = match.groups?.title || match[2];
    const date = match.groups?.date || match[3] || '';
    const signal = makeSignal({
      id: `${state}:${signalType}:${cleanText(title)}`,
      title,
      summary: `${source} ${signalType === 'rulemaking' ? 'rulemaking notice' : 'executive order'}.`,
      url: absoluteUrl(href, baseUrl),
      updatedAt: date,
      state,
      agency,
      status,
      source,
      signalType
    });
    if (signal) results.push(signal);
  }
  return uniqueSignals(results);
}
