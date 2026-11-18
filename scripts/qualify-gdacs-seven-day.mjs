import { createHash } from 'node:crypto';

export const url = 'https://data.gdacs.org/xml/rss_7d.xml';
export const maxBytes = 2 * 1024 * 1024;
export async function qualifyPagesRunner({ fetchImpl, xmlParser, xmlValidator, userAgent, now = Date.now }) {
  const signal = AbortSignal.timeout(20_000);
  const response = await fetchImpl(url, {
    method: 'GET', redirect: 'error', credentials: 'omit', signal,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
  const receipt = { status: response.status, mime: ['application/xml','text/xml','application/rss+xml','text/html'].includes(mime) ? mime : 'other' };
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    return { ...receipt, outcome: 'http_or_body_unusable' };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) return { ...receipt, outcome: 'body_cap' };
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  Object.assign(receipt, { bytes, sha256: createHash('sha256').update(buffer).digest('hex') });
  const body = buffer.toString('utf8');
  if (mime === 'text/html' || /^\s*(?:<!doctype html|<html\b)/i.test(body)) return { ...receipt, outcome: 'html' };
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || xmlValidator.validate(body) !== true) return { ...receipt, outcome: 'invalid_xml' };
  const rss = xmlParser.parse(body).rss;
  if (!rss?.channel) return { ...receipt, outcome: 'not_rss' };
  const value = rss.channel.item;
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const date = item => Date.parse(item.pubDate || item['dc:date'] || item.date || '');
  const coordinates = item => {
    const value = String(item['georss:point'] ?? '').trim().split(/\s+/);
    if (value.length !== 2 || value.some(x => !x)) return false;
    const [lat, lon] = value.map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  };
  const report = item => {
    try {
      const target = new URL(item.link);
      return ['http:','https:'].includes(target.protocol) && ['www.gdacs.org','gdacs.org'].includes(target.hostname)
        && !target.username && !target.password && !target.port && /^\/report\.aspx$/i.test(target.pathname);
    } catch { return false; }
  };
  const realDates = items.map(date).filter(Number.isFinite);
  const time = now();
  const usable = item => Boolean(String(item.title || '').trim() && report(item) && coordinates(item));
  const fresh = item => Number.isFinite(date(item)) && date(item) <= time && time - date(item) <= 90 * 60_000;
  return { ...receipt, outcome: 'rss_observed', items: items.length,
    dated: realDates.length, oldest: realDates.length ? Math.min(...realDates) : null,
    newest: realDates.length ? Math.max(...realDates) : null,
    usableTitleLinkPoint: items.filter(usable).length,
    usableWithin90Minutes: items.filter(x => usable(x) && fresh(x)).length,
    eventEpisodeIdentity: items.filter(x => x['gdacs:eventid'] != null && x['gdacs:episodeid'] != null).length,
    typeAndSeverity: items.filter(x => x['gdacs:eventtype'] != null && x['gdacs:alertlevel'] != null).length,
  };
}

export function maySend(env, event) {
  return env.GITHUB_REPOSITORY === 'CongressionalInsights/TheSituationRoomAI'
    && env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF === 'refs/heads/codex/gdacs-seven-day-qualify-20261118-a'
    && env.GITHUB_RUN_ATTEMPT === '1'
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    && /^[0-9]+$/.test(env.GITHUB_RUN_ID || '')
    && event.ref === env.GITHUB_REF
    && event.created === true && event.deleted === false && event.forced === false
    && event.before === '0'.repeat(40) && event.after === env.GITHUB_SHA;
}

async function main() {
  const { readFileSync, openSync, writeFileSync, closeSync, fsyncSync } = await import('node:fs');
  const { join } = await import('node:path');
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (!maySend(env, event)) throw Error('source_guard_refused');
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  const { app } = JSON.parse(readFileSync('data/feeds.json', 'utf8'));
  if (typeof app?.userAgent !== 'string' || !app.userAgent) throw Error('header_config_refused');
  const identity = { run: env.GITHUB_RUN_ID, attempt: 1, source: env.GITHUB_SHA, target: url };
  const startedAt = new Date().toISOString();
  const intent = { ...identity, startedAt, state: 'attempting_or_uncertain', remaining: 0 };
  const fd = openSync(join(env.RUNNER_TEMP, 'gdacs-seven-day-send-intent.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(intent)); fsyncSync(fd); } finally { closeSync(fd); }
  console.log(JSON.stringify(intent));
  let result;
  try {
    result = await qualifyPagesRunner({
      fetchImpl: fetch, xmlParser: new XMLParser({ processEntities: false }),
      xmlValidator: XMLValidator, userAgent: app.userAgent,
    });
  } catch (error) {
    result = { outcome: ['TimeoutError','AbortError'].includes(error.name) ? 'timeout' : 'transport_or_decode' };
  }
  console.log(JSON.stringify({ ...identity, startedAt, finishedAt: new Date().toISOString(), remaining: 0, ...result }));
  if (result.outcome !== 'rss_observed') process.exitCode = 1;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('qualification_preflight_refused'); process.exitCode = 1; });
}
