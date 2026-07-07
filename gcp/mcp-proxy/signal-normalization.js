import { normalizeJurisdictionCode } from './state-signals.js';

function normalizeSummary(text = '') {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 500 ? `${cleaned.slice(0, 497)}...` : cleaned;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFirstValidTimestamp(...values) {
  for (const value of values) {
    const parsed = parseTimestamp(value);
    if (parsed !== null) return parsed;
  }
  return Date.now();
}

function parseCsvRows(text = '') {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const next = text[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(current);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length || row.length) {
    row.push(current);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}

function toCsvObjects(text = '') {
  const rows = parseCsvRows(String(text || '').trim());
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => String(header || '').trim());
  return rows.slice(1).map((row) => headers.reduce((acc, header, index) => {
    acc[header] = row[index] || '';
    return acc;
  }, {}));
}

function parseStooqTimestamp(row = {}) {
  const date = String(row.Date || '').trim();
  const time = String(row.Time || '').trim();
  if (!date || date === 'N/D') return Date.now();
  const stamp = time && time !== 'N/D' ? `${date}T${time}Z` : `${date}T00:00:00Z`;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : Date.parse(date);
}

export function getStateBillSortTimestamp(entry) {
  const candidates = [
    entry?.updated_at,
    entry?.latest_action_date,
    entry?.latest_action_at,
    entry?.effective_date,
    entry?.effectiveDate,
    entry?.created_at,
    entry?.first_action_date
  ];
  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function extractStateMetadata(entry, feed) {
  const jurisdictionCode = normalizeJurisdictionCode(
    entry.jurisdictionCode
    || entry.state
    || entry.stateCode
    || entry.state_code
    || entry.jurisdiction?.id
    || entry.jurisdiction?.name
    || entry.from_organization?.id
    || entry.organization?.id
  );
  const jurisdictionName = entry.jurisdictionName
    || entry.stateName
    || entry.state_name
    || entry.jurisdiction?.name
    || entry.from_organization?.name
    || null;
  const signalType = entry.signalType
    || entry.type
    || entry.documentType
    || (Array.isArray(feed.capabilities) ? feed.capabilities[0] : null)
    || null;
  const docId = entry.docId || entry.id || entry.identifier || null;
  const status = entry.status || entry.latest_action_description || null;
  const agency = entry.agency || entry.from_organization?.name || entry.organization?.name || null;
  const effectiveDate = entry.effectiveDate || entry.effective_date || entry.latest_action_date || null;
  const level = entry.jurisdictionLevel || feed.jurisdictionLevel || null;
  return {
    jurisdictionLevel: level,
    jurisdictionCode,
    jurisdictionName,
    signalType,
    docId,
    status,
    agency,
    effectiveDate
  };
}

const COMMITTEE_REPORT_TYPE_MAP = {
  HRPT: 'H. Rept.',
  SRPT: 'S. Rept.',
  ERPT: 'E. Rept.'
};

function normalizeCongressReportType(value) {
  if (!value) return '';
  return String(value).toUpperCase().replace(/[^A-Z]/g, '');
}

function formatCongressReportTypeNumber(entry) {
  const reportType = normalizeCongressReportType(entry.reportType || entry.type || '');
  const reportNumber = entry.reportNumber || entry.number || '';
  if (!reportType || !reportNumber) return '';
  const label = COMMITTEE_REPORT_TYPE_MAP[reportType] || reportType;
  return `${label} ${reportNumber}`;
}

function isCommitteeReportEntry(entry, feed) {
  if (feed?.id === 'congress-reports') return true;
  return Boolean(
    entry?.citation
    || entry?.cmte_rpt_id
    || entry?.reportType
    || entry?.reportNumber
    || (typeof entry?.type === 'string' && normalizeCongressReportType(entry.type).endsWith('RPT'))
  );
}

function formatCongressChamber(value) {
  const chamber = String(value || '').trim().toLowerCase();
  if (!chamber) return '';
  if (chamber === 'house') return 'House';
  if (chamber === 'senate') return 'Senate';
  if (chamber === 'joint') return 'Joint';
  return String(value).trim();
}

function buildCongressHearingTitle(entry) {
  const chamber = formatCongressChamber(entry?.chamber);
  const congress = entry?.congress ? String(entry.congress) : '';
  const hearingNumber = entry?.number ? String(entry.number) : '';
  const jacketNumber = entry?.jacketNumber ? String(entry.jacketNumber) : '';
  const type = chamber ? `${chamber} hearing` : 'Congress hearing';
  const marker = [congress, hearingNumber].filter(Boolean).join('-') || congress || jacketNumber;
  const jacket = jacketNumber ? ` (jacket ${jacketNumber})` : '';
  return `${type}${marker ? ` ${marker}` : ''}${jacket}`;
}

function buildCongressCommitteeMeetingTitle(entry) {
  const chamber = formatCongressChamber(entry?.chamber);
  const eventId = entry?.eventId ? String(entry.eventId) : '';
  const congress = entry?.congress ? String(entry.congress) : '';
  const type = chamber ? `${chamber} committee meeting` : 'Congress committee meeting';
  return `${type} ${eventId || congress}`.trim();
}

function buildCommitteeReportTitle(entry, fallbackTitle) {
  const citation = String(entry?.citation || '').trim();
  if (citation) return citation;
  const typeNumber = formatCongressReportTypeNumber(entry);
  if (typeNumber) return typeNumber;
  return fallbackTitle;
}

function buildCommitteeReportSummary(entry, fallbackSummary) {
  if (fallbackSummary) return fallbackSummary;
  const chamber = formatCongressChamber(entry?.chamber);
  const reportMarker = String(entry?.citation || '').trim() || formatCongressReportTypeNumber(entry);
  const updateDate = String(entry?.updateDate || entry?.updatedAt || entry?.updated || '').trim();
  const parts = [chamber, reportMarker, updateDate].filter(Boolean);
  return normalizeSummary(parts.join(' • '));
}

function selectList(data) {
  return Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.packages)
      ? data.packages
      : Array.isArray(data?.entries)
        ? data.entries
      : Array.isArray(data?.articles)
        ? data.articles
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.features)
            ? data.features
            : Array.isArray(data?.results)
              ? data.results
              : Array.isArray(data?.bills)
                ? data.bills
                : Array.isArray(data?.amendments)
                  ? data.amendments
                  : Array.isArray(data?.committeeReports)
                    ? data.committeeReports
                    : Array.isArray(data?.committeeReport)
                      ? data.committeeReport
                      : Array.isArray(data?.reports)
                        ? data.reports
                        : Array.isArray(data?.houseRollCallVotes)
                          ? data.houseRollCallVotes
                          : Array.isArray(data?.events)
                            ? data.events
                            : Array.isArray(data?.hearings)
                              ? data.hearings
                              : Array.isArray(data?.committeeMeetings)
                                ? data.committeeMeetings
                                : Array.isArray(data?.nominations)
                                  ? data.nominations
                                  : Array.isArray(data?.treaties)
                                    ? data.treaties
                                    : Array.isArray(data?.congressionalRecord)
                                      ? data.congressionalRecord
                                      : Array.isArray(data?.response?.data)
                                        ? data.response.data
                                        : Array.isArray(data?.response?.items)
                                          ? data.response.items
                                          : Array.isArray(data?.response?.results)
                                            ? data.response.results
                                            : [];
}

export function parseGenericJsonFeed(data, feed) {
  if (feed?.id === 'transport-opensky' && Array.isArray(data?.states)) {
    const observedAt = Number.isFinite(Number(data?.time)) ? Number(data.time) * 1000 : Date.now();
    return data.states.slice(0, 200).map((row) => {
      if (!Array.isArray(row)) return null;
      const icao24 = String(row[0] || '').trim();
      const callsign = String(row[1] || '').trim();
      const lon = Number(row[5]);
      const lat = Number(row[6]);
      return {
        title: callsign || icao24 || 'Aircraft state',
        url: icao24 ? `https://opensky-network.org/aircraft-profile?icao24=${encodeURIComponent(icao24)}` : 'https://opensky-network.org/',
        summary: normalizeSummary([
          row[2] || '',
          row[8] != null ? `Ground speed ${row[8]}` : '',
          row[13] != null ? `Altitude ${row[13]}` : ''
        ].filter(Boolean).join(' • ')),
        publishedAt: observedAt,
        source: feed.name,
        category: feed.category,
        geo: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
      };
    }).filter(Boolean);
  }

  return selectList(data).slice(0, 50).map((entry) => {
    if (typeof entry === 'string') {
      return {
        title: entry,
        url: '',
        summary: '',
        publishedAt: Date.now(),
        source: feed.name,
        category: feed.category
      };
    }
    const properties = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
    const voteNumber = entry.voteNumber || entry.rollCall || entry.rollCallNumber || entry.number || '';
    const voteSession = entry.session || entry.sessionNumber || '';
    const isCongressHouseVote = feed?.id === 'congress-house-votes'
      || entry.rollCallNumber !== undefined
      || entry.voteQuestion !== undefined
      || entry.voteType !== undefined;
    const voteTitle = voteNumber
      ? (voteSession ? `Roll Call ${voteNumber} • Session ${voteSession}` : `Roll Call ${voteNumber}`)
      : 'House Vote';
    const congressVoteUrl = (entry.congress && voteSession && voteNumber)
      ? `https://www.congress.gov/roll-call-vote/${entry.congress}th-congress/house-session-${voteSession}/${voteNumber}`
      : '';
    const fallbackTitle = properties.title || entry.title || entry.name || entry.headline || entry.label || 'Untitled';
    const isCommitteeReport = !isCongressHouseVote && isCommitteeReportEntry(entry, feed);
    const isCongressHearing = feed?.id === 'congress-hearings';
    const isCongressCommitteeMeeting = feed?.id === 'congress-committee-meetings';
    const isEonetEvent = feed?.id === 'eonet-events';
    const eonetCategories = Array.isArray(entry?.categories)
      ? entry.categories.map((cat) => cat?.title || cat?.id).filter(Boolean)
      : [];
    const eonetGeometry = Array.isArray(entry?.geometry) ? entry.geometry : [];
    const latestEonetGeometry = eonetGeometry.reduce((latest, point) => {
      if (!latest) return point;
      const latestMs = Date.parse(latest?.date || '');
      const pointMs = Date.parse(point?.date || '');
      if (Number.isNaN(pointMs)) return latest;
      if (Number.isNaN(latestMs) || pointMs > latestMs) return point;
      return latest;
    }, null);
    const title = isCongressHouseVote
      ? voteTitle
      : isCongressHearing
        ? buildCongressHearingTitle(entry)
        : isCongressCommitteeMeeting
          ? buildCongressCommitteeMeetingTitle(entry)
          : (isCommitteeReport ? buildCommitteeReportTitle(entry, fallbackTitle) : fallbackTitle);
    const url = congressVoteUrl || properties.url || entry.url || entry.link || entry.permalink || entry.webUrl || entry.packageLink || entry.detailsLink || '';
    const defaultSummary = normalizeSummary(entry.summary || entry.description || entry.body || entry.abstract || properties.status || properties.type || properties.place || '');
    const voteSummary = normalizeSummary(
      [
        entry.voteQuestion || entry.question || '',
        entry.result || entry.voteResult || '',
        entry.voteType || ''
      ].filter(Boolean).join(' • ')
    );
    const summary = isCongressHouseVote
      ? (voteSummary || defaultSummary)
      : (isCommitteeReport ? buildCommitteeReportSummary(entry, defaultSummary) : defaultSummary);
    const eonetSummary = normalizeSummary(
      [
        eonetCategories.join(', '),
        latestEonetGeometry?.magnitudeValue && latestEonetGeometry?.magnitudeUnit
          ? `Magnitude ${latestEonetGeometry.magnitudeValue} ${latestEonetGeometry.magnitudeUnit}`
          : ''
      ].filter(Boolean).join(' • ')
    );
    const finalSummary = isEonetEvent ? (defaultSummary || eonetSummary) : summary;
    const publishedAt = parseFirstValidTimestamp(
      entry.publishedAt,
      entry.published_at,
      properties.time,
      properties.updated,
      entry.pubDate,
      isEonetEvent ? latestEonetGeometry?.date : null,
      entry.date,
      entry.lastModified,
      entry.dateIssued,
      entry.updateDate,
      entry.updateDateIncludingText,
      entry.updated_at,
      entry.startDate,
      entry.updatedAt,
      entry.updated,
      entry.latest_action_date,
      entry.effectiveDate,
      entry.effective_date,
      latestEonetGeometry?.date
    );
    const eventCoords = Array.isArray(latestEonetGeometry?.coordinates) ? latestEonetGeometry.coordinates : [];
    const featureCoords = Array.isArray(entry?.geometry?.coordinates) ? entry.geometry.coordinates : [];
    const geo = entry.geo
      || (entry.latitude && entry.longitude ? { lat: Number(entry.latitude), lon: Number(entry.longitude) } : null)
      || (featureCoords.length >= 2 ? { lat: Number(featureCoords[1]), lon: Number(featureCoords[0]) } : null)
      || (eventCoords.length >= 2 ? { lat: Number(eventCoords[1]), lon: Number(eventCoords[0]) } : null);
    const stateMeta = extractStateMetadata(entry, feed);
    const hasStateMeta = Object.values(stateMeta).some((value) => value !== null && value !== '');
    return {
      title,
      url,
      summary: finalSummary,
      publishedAt: Number.isNaN(publishedAt) ? Date.now() : publishedAt,
      source: entry.source || feed.name,
      category: feed.category,
      geo,
      ...(hasStateMeta ? stateMeta : {})
    };
  });
}

export function normalizeJsonSignals(text, feed) {
  try {
    return parseGenericJsonFeed(JSON.parse(text), feed);
  } catch {
    const trimmed = String(text || '').trim();
    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart === -1 || objectEnd <= objectStart) return [];
    try {
      return parseGenericJsonFeed(JSON.parse(trimmed.slice(objectStart, objectEnd + 1)), feed);
    } catch {
      return [];
    }
  }
}

export function normalizeCsvSignals(text, feed) {
  const rows = toCsvObjects(text);
  if (!rows.length) return [];
  if (feed?.id === 'stooq-quote') {
    return rows.map((row) => {
      const symbol = String(row.Symbol || '').trim();
      const close = Number(row.Close);
      if (!symbol || row.Close === 'N/D' || !Number.isFinite(close)) return null;
      const open = Number(row.Open);
      const deltaPct = Number.isFinite(open) && open ? ((close - open) / open) * 100 : null;
      const publishedAt = parseStooqTimestamp(row);
      return {
        title: `${symbol} Price`,
        url: `https://stooq.com/q/?s=${encodeURIComponent(symbol.toLowerCase())}`,
        summary: normalizeSummary(`Close ${close} | ${row.Date || 'Latest'} ${row.Time || ''}`),
        publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
        source: feed.name,
        category: feed.category,
        value: close,
        deltaPct,
        symbol,
        volume: Number(row.Volume)
      };
    }).filter(Boolean);
  }

  return rows.slice(0, 50).map((row) => {
    const title = row.title || row.Title || row.name || row.Name || row.Symbol || Object.values(row)[0] || 'CSV row';
    const url = row.url || row.URL || row.link || row.Link || '';
    const published = row.publishedAt || row.date || row.Date || row.published || row.Published || '';
    const publishedAt = published ? Date.parse(published) : Date.now();
    return {
      title,
      url,
      summary: normalizeSummary(row.summary || row.Summary || row.description || row.Description || ''),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      source: feed.name,
      category: feed.category
    };
  }).filter((item) => item.title);
}
