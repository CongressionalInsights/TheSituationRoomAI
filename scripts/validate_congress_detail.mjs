import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const baseArgIndex = args.findIndex((value) => value === '--base');
const baseArgValue = baseArgIndex >= 0 ? args[baseArgIndex + 1] : null;
const baseOrigin = baseArgValue
  || args.find((value) => value.startsWith('--base='))?.split('=')[1]
  || process.env.SR_BASE
  || 'http://127.0.0.1:5173';
const feedsConfig = JSON.parse(fs.readFileSync(path.join(root, 'data', 'feeds.json'), 'utf8'));

const congressFeeds = (feedsConfig.feeds || []).filter((feed) => (
  feed.id?.startsWith('congress-') || (feed.tags || []).includes('congress')
));

const pickArray = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.item)) return value.item;
  if (Array.isArray(value.bill)) return value.bill;
  if (Array.isArray(value.amendment)) return value.amendment;
  if (Array.isArray(value.report)) return value.report;
  if (Array.isArray(value.hearing)) return value.hearing;
  if (Array.isArray(value.nomination)) return value.nomination;
  if (Array.isArray(value.treaty)) return value.treaty;
  return null;
};

const normalizeCongressBillType = (value) => {
  if (!value) return '';
  return String(value).toUpperCase().replace(/\./g, '').trim();
};

const toCongressApiType = (value) => normalizeCongressBillType(value).toLowerCase();

const buildCongressApiUrl = (path) => `https://api.congress.gov/v3${path}`;

const getCongressDetailTargets = (item) => {
  const targets = [];
  if (item?.feedId === 'congress-summaries' && item.apiUrl) {
    const rawUrl = String(item.apiUrl || '');
    const match = rawUrl.match(/https?:\/\/api\.congress\.gov\/v3(.*)/i);
    if (match && match[1]) {
      const pathValue = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
      const withFormat = pathValue.includes('format=json')
        ? pathValue
        : `${pathValue}${pathValue.includes('?') ? '&' : '?'}format=json`;
      targets.push({ type: 'summary-detail', label: 'Summary Detail', url: buildCongressApiUrl(withFormat) });
    }
  }
  const congress = item.congress;
  const billType = toCongressApiType(item.billType);
  const billNumber = item.billNumber;
  if (congress && billType && billNumber) {
    const base = `/bill/${congress}/${billType}/${billNumber}`;
    targets.push({ type: 'bill-detail', label: 'Bill Detail', url: buildCongressApiUrl(`${base}?format=json`) });
    targets.push({ type: 'summary', label: 'Summary', url: buildCongressApiUrl(`${base}/summaries?format=json`) });
    targets.push({ type: 'actions', label: 'Actions', url: buildCongressApiUrl(`${base}/actions?format=json&limit=20`) });
    targets.push({ type: 'committees', label: 'Committees', url: buildCongressApiUrl(`${base}/committees?format=json&limit=20`) });
    targets.push({ type: 'cosponsors', label: 'Cosponsors', url: buildCongressApiUrl(`${base}/cosponsors?format=json&limit=20`) });
    targets.push({ type: 'related', label: 'Related Bills', url: buildCongressApiUrl(`${base}/relatedbills?format=json&limit=20`) });
    targets.push({ type: 'subjects', label: 'Subjects', url: buildCongressApiUrl(`${base}/subjects?format=json&limit=20`) });
    targets.push({ type: 'titles', label: 'Titles', url: buildCongressApiUrl(`${base}/titles?format=json&limit=20`) });
    targets.push({ type: 'text', label: 'Text Versions', url: buildCongressApiUrl(`${base}/text?format=json&limit=20`) });
    targets.push({ type: 'bill-amendments', label: 'Bill Amendments', url: buildCongressApiUrl(`${base}/amendments?format=json&limit=20`) });
  }
  const amendmentType = toCongressApiType(item.amendmentType);
  const amendmentNumber = item.amendmentNumber;
  if (congress && amendmentType && amendmentNumber) {
    const base = `/amendment/${congress}/${amendmentType}/${amendmentNumber}`;
    targets.push({ type: 'amendment-detail', label: 'Amendment Detail', url: buildCongressApiUrl(`${base}?format=json`) });
    targets.push({ type: 'amend-actions', label: 'Amendment Actions', url: buildCongressApiUrl(`${base}/actions?format=json&limit=20`) });
    targets.push({ type: 'amend-cosponsors', label: 'Amendment Cosponsors', url: buildCongressApiUrl(`${base}/cosponsors?format=json&limit=20`) });
    targets.push({ type: 'amendment-amendments', label: 'Amendment Amendments', url: buildCongressApiUrl(`${base}/amendments?format=json&limit=20`) });
    targets.push({ type: 'amend-text', label: 'Amendment Text', url: buildCongressApiUrl(`${base}/text?format=json&limit=20`) });
  }
  const voteNumber = item.voteNumber;
  const voteSession = item.voteSession;
  if (congress && voteSession && voteNumber) {
    const base = `/house-vote/${congress}/${voteSession}/${voteNumber}`;
    targets.push({ type: 'vote', label: 'Vote Detail', url: buildCongressApiUrl(`${base}?format=json&limit=20`) });
    targets.push({ type: 'vote-members', label: 'Member Votes', url: buildCongressApiUrl(`${base}/members?format=json&limit=500`) });
  }
  const committeeCode = item.committeeCode;
  const committeeChamber = (item.committeeChamber || '').toLowerCase();
  if (committeeCode && committeeChamber) {
    const base = `/committee/${committeeChamber}/${committeeCode}`;
    targets.push({ type: 'committee-detail', label: 'Committee Detail', url: buildCongressApiUrl(`${base}?format=json`) });
    targets.push({ type: 'committee-bills', label: 'Committee Bills', url: buildCongressApiUrl(`${base}/bills?format=json&limit=20`) });
    targets.push({ type: 'committee-reports', label: 'Committee Reports', url: buildCongressApiUrl(`${base}/reports?format=json&limit=20`) });
    targets.push({ type: 'committee-nominations', label: 'Committee Nominations', url: buildCongressApiUrl(`${base}/nominations?format=json&limit=20`) });
    targets.push({ type: 'committee-communications-house', label: 'Committee House Communications', url: buildCongressApiUrl(`${base}/house-communication?format=json&limit=20`) });
    targets.push({ type: 'committee-communications-senate', label: 'Committee Senate Communications', url: buildCongressApiUrl(`${base}/senate-communication?format=json&limit=20`) });
  }
  const reportType = toCongressApiType(item.reportType);
  const reportNumber = item.reportNumber;
  if (congress && reportType && reportNumber) {
    const base = `/committee-report/${congress}/${reportType}/${reportNumber}`;
    targets.push({ type: 'report-detail', label: 'Committee Report', url: buildCongressApiUrl(`${base}?format=json`) });
    targets.push({ type: 'report-text', label: 'Report Text', url: buildCongressApiUrl(`${base}/text?format=json&limit=20`) });
  }
  const jacketNumber = item.jacketNumber;
  if (congress && committeeChamber && jacketNumber && item.alertType === 'Committee Print') {
    const base = `/committee-print/${congress}/${committeeChamber}/${jacketNumber}`;
    targets.push({ type: 'print-detail', label: 'Committee Print', url: buildCongressApiUrl(`${base}?format=json`) });
    targets.push({ type: 'print-text', label: 'Print Text', url: buildCongressApiUrl(`${base}/text?format=json&limit=20`) });
  }
  if (item.alertType === 'Committee Meeting' && congress && committeeChamber && (item.eventId || item.meetingId || item.event)) {
    const eventId = item.eventId || item.meetingId || item.event;
    const base = `/committee-meeting/${congress}/${committeeChamber}/${eventId}`;
    targets.push({ type: 'meeting-detail', label: 'Meeting Detail', url: buildCongressApiUrl(`${base}?format=json`) });
  }
  const communicationType = item.communicationType;
  const communicationNumber = item.communicationNumber;
  if (congress && communicationType && communicationNumber) {
    const chamber = (item.communicationChamber || '').toLowerCase() === 'senate' ? 'senate' : 'house';
    const base = `/${chamber}-communication/${congress}/${communicationType}/${communicationNumber}`;
    targets.push({ type: 'communication-detail', label: 'Communication Detail', url: buildCongressApiUrl(`${base}?format=json`) });
  }
  return targets;
};

const normalizeItem = (raw, feed) => {
  const apiUrl = [raw.url, raw.link, raw.bill?.url].find((value) => (
    typeof value === 'string' && value.includes('api.congress.gov')
  ));
  return {
    feedId: feed.id,
    alertType: feed.congressType || raw.alertType || '',
    apiUrl,
    congress: raw.congress || raw.bill?.congress || raw.congressReceived || raw.congressConsidered,
    billType: raw.billType || raw.bill?.type || raw.type,
    billNumber: raw.billNumber || raw.bill?.number || raw.number,
    amendmentType: raw.amendmentType || raw.type,
    amendmentNumber: raw.amendmentNumber || raw.number,
    voteSession: raw.session || raw.sessionNumber,
    voteNumber: raw.voteNumber || raw.rollCall || raw.number,
    committeeCode: raw.committeeCode || raw.systemCode || raw.committee?.systemCode,
    committeeChamber: raw.committeeChamber || raw.chamber || raw.committee?.chamber,
    reportType: raw.reportType || raw.type,
    reportNumber: raw.reportNumber || raw.number,
    jacketNumber: raw.jacketNumber || raw.number,
    communicationType: raw.communicationType || raw.type,
    communicationNumber: raw.communicationNumber || raw.number,
    communicationChamber: raw.communicationChamber || raw.chamber,
    eventId: raw.eventId || raw.meetingId || raw.event,
    meetingId: raw.meetingId || raw.event
  };
};

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { 'accept': 'application/json' } });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
};

const failures = [];
const summaries = [];

for (const feed of congressFeeds) {
  const { ok, status, data } = await fetchJson(`${baseOrigin}/api/feed?id=${feed.id}&force=1`);
  if (!ok) {
    failures.push({ feedId: feed.id, stage: 'feed', status });
    continue;
  }
  let payload = data;
  let body = payload?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      failures.push({ feedId: feed.id, stage: 'parse', error: error.message });
      continue;
    }
  }
  if (!body || body.error) {
    failures.push({ feedId: feed.id, stage: 'body', error: body?.error || 'empty_body' });
    continue;
  }
  const list = pickArray(body?.bills)
    || pickArray(body?.amendments)
    || pickArray(body?.committeeReports)
    || pickArray(body?.committeeReport)
    || pickArray(body?.nominations)
    || pickArray(body?.treaties)
    || pickArray(body?.hearings)
    || pickArray(body?.committeeMeetings)
    || pickArray(body?.committee)
    || pickArray(body?.committees)
    || pickArray(body?.committeePrints)
    || pickArray(body?.committeePrint)
    || pickArray(body?.houseVotes)
    || pickArray(body?.houseVote)
    || pickArray(body?.houseCommunications)
    || pickArray(body?.houseCommunication)
    || pickArray(body?.senateCommunications)
    || pickArray(body?.senateCommunication)
    || pickArray(body?.summaries)
    || pickArray(body?.congressionalRecord)
    || pickArray(body?.dailyCongressionalRecord)
    || pickArray(body?.records)
    || pickArray(body?.Results?.Issues)
    || pickArray(body?.results)
    || [];

  const sample = list.slice(0, 20).map((item) => normalizeItem(item, feed));
  for (const item of sample) {
    const targets = getCongressDetailTargets(item);
    const itemKey = [
      item.alertType || 'Congress',
      item.congress,
      item.billType || item.amendmentType || item.reportType || item.communicationType || '',
      item.billNumber || item.amendmentNumber || item.reportNumber || item.communicationNumber || item.jacketNumber || item.voteNumber || ''
    ].filter(Boolean).join(':');
    summaries.push({ feedId: feed.id, itemKey, targetCount: targets.length });
    for (const target of targets) {
      const result = await fetchJson(`${baseOrigin}/api/congress-detail?url=${encodeURIComponent(target.url)}`);
      if (!result.ok || result.data?.error) {
        failures.push({
          feedId: feed.id,
          itemKey,
          targetType: target.type,
          url: target.url,
          status: result.status,
          error: result.data?.error || 'fetch_failed',
          upstreamStatus: result.data?.status || null
        });
      }
    }
  }
}

const outputDir = path.join(root, 'analysis', 'congress');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'congress-detail-404.json');
fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), failures, summaries }, null, 2));

console.log(`Congress detail validation complete. Failures: ${failures.length}`);
console.log(`Report written to ${outputPath}`);
