import { jurisdictionNameForCode, normalizeJurisdictionCode } from './state-signals.js';

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

export function normalizeSwpcTimestamp(value) {
  const timestamp = String(value || '').trim();
  if (!timestamp || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return timestamp;
  return `${timestamp}Z`;
}

function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSwpcSignals(data, feed) {
  return data.slice(0, 50).map((entry) => {
    const spacecraft = String(entry?.source || '').trim();
    const protonSpeed = normalizeFiniteNumber(entry?.proton_speed);
    const protonDensity = normalizeFiniteNumber(entry?.proton_density);
    const protonTemperature = normalizeFiniteNumber(entry?.proton_temperature);
    const summary = normalizeSummary([
      protonSpeed !== null ? `Proton speed ${protonSpeed} km/s` : '',
      protonDensity !== null ? `Proton density ${protonDensity} p/cm3` : '',
      protonTemperature !== null ? `Proton temperature ${protonTemperature} K` : ''
    ].filter(Boolean).join(' | '));
    return {
      title: spacecraft ? `Solar wind - ${spacecraft}` : 'Solar wind observation',
      url: feed.url || '',
      summary: summary || 'Proton measurements unavailable',
      publishedAt: parseFirstValidTimestamp(normalizeSwpcTimestamp(entry?.time_tag)),
      source: feed.name,
      category: feed.category,
      spacecraft: spacecraft || null,
      active: typeof entry?.active === 'boolean' ? entry.active : null,
      protonSpeed,
      protonDensity,
      protonTemperature
    };
  });
}

const SWPC_NON_FINITE_TOKENS = ['-Infinity', '+Infinity', 'Infinity', 'NaN'];

function findNonWhitespace(text, start, step) {
  for (let index = start; index >= 0 && index < text.length; index += step) {
    if (!/\s/.test(text[index])) return text[index];
  }
  return '';
}

function normalizeSwpcNonFiniteNumbers(text) {
  let normalized = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }

    const token = SWPC_NON_FINITE_TOKENS.find((candidate) => text.startsWith(candidate, index));
    if (token) {
      const previous = findNonWhitespace(text, index - 1, -1);
      const next = findNonWhitespace(text, index + token.length, 1);
      const startsValue = !previous || previous === ':' || previous === ',' || previous === '[';
      const endsValue = !next || next === ',' || next === ']' || next === '}';
      if (startsValue && endsValue) {
        normalized += 'null';
        index += token.length - 1;
        continue;
      }
    }
    normalized += char;
  }
  return normalized;
}

export function parseJsonFeedPayload(text, feed) {
  const body = String(text || '');
  return JSON.parse(feed?.id === 'swpc-json' ? normalizeSwpcNonFiniteNumbers(body) : body);
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
    entry?.latest_passage_date,
    entry?.latestPassageDate,
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
  const latestPassageDate = entry.latestPassageDate || entry.latest_passage_date || null;
  const effectiveDate = entry.effectiveDate || entry.effective_date || latestPassageDate || entry.latest_action_date || null;
  const level = entry.jurisdictionLevel || feed.jurisdictionLevel || null;
  return {
    jurisdictionLevel: level,
    jurisdictionCode,
    jurisdictionName,
    signalType,
    docId,
    status,
    agency,
    effectiveDate,
    latestPassageDate
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

function formatCongressBillIdentifier(entry) {
  const type = String(entry?.type || entry?.billType || '').trim().toUpperCase();
  const number = String(entry?.number || entry?.billNumber || '').trim();
  if (!type || !number) return '';
  return `${type} ${number}`;
}

const CONGRESS_BILL_WEB_TYPE_SLUGS = {
  HR: 'house-bill',
  S: 'senate-bill',
  HRES: 'house-resolution',
  SRES: 'senate-resolution',
  HJRES: 'house-joint-resolution',
  SJRES: 'senate-joint-resolution',
  HCONRES: 'house-concurrent-resolution',
  SCONRES: 'senate-concurrent-resolution'
};

function normalizeCongressBillType(value = '') {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function buildCongressBillWebUrl(entry = {}) {
  const congress = String(entry.congress || '').trim();
  const number = String(entry.number || entry.billNumber || '').trim();
  const slug = CONGRESS_BILL_WEB_TYPE_SLUGS[normalizeCongressBillType(entry.type || entry.billType)];
  if (!congress || !number || !slug) return '';
  return `https://www.congress.gov/bill/${encodeURIComponent(congress)}th-congress/${slug}/${encodeURIComponent(number)}`;
}

function isCongressBillEntry(entry, feed) {
  return Boolean(
    feed?.congressCommitteeBills
    || feed?.id === 'congress-api'
    || (entry?.latestAction && entry?.number && entry?.type && entry?.congress)
  );
}

function buildCongressBillTitle(entry, fallbackTitle) {
  const identifier = formatCongressBillIdentifier(entry);
  const cleanTitle = String(fallbackTitle || '').trim();
  const isUntitled = !cleanTitle || cleanTitle.toLowerCase() === 'untitled';
  if (!identifier) return cleanTitle || 'Congress bill';
  if (isUntitled || cleanTitle.toUpperCase().startsWith(identifier.toUpperCase())) return identifier;
  return `${identifier} - ${cleanTitle}`;
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
  if (Array.isArray(data)) return data;
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
                : Array.isArray(data?.['committee-bills']?.bills)
                  ? data['committee-bills'].bills
                  : Array.isArray(data?.committeeBills?.bills)
                    ? data.committeeBills.bills
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

function normalizeNwsSignals(data, feed) {
  // Keep the complete fetched alert set until query filtering and output limits.
  return data.features.filter((feature) => feature?.properties).map((feature) => {
    const props = feature.properties;
    const zoneCodes = [
      ...(Array.isArray(props.geocode?.UGC) ? props.geocode.UGC : []),
      ...(Array.isArray(props.affectedZones) ? props.affectedZones.map((url) => String(url).split('/').pop()) : [])
    ];
    const jurisdictionCodes = [...new Set(zoneCodes.map((zone) => {
      const match = String(zone).match(/^([A-Z]{2})[CZ]\d{3}$/);
      return match ? normalizeJurisdictionCode(match[1]) : '';
    }).filter(Boolean))];
    const geometry = feature.geometry || null;
    const coords = geometry?.type === 'Point' ? geometry.coordinates : [];
    const lat = normalizeFiniteNumber(coords?.[1]);
    const lon = normalizeFiniteNumber(coords?.[0]);
    const publishedAt = [props.sent, props.effective, props.onset].map(parseTimestamp).find((value) => value !== null) ?? null;
    return {
      title: props.headline || props.event || 'Weather alert',
      url: props['@id'] || feature.id || '',
      docId: props.id || feature.id || props['@id'] || null,
      summary: normalizeSummary([props.areaDesc, props.description].filter(Boolean).join(' — ')),
      description: props.description || '',
      instruction: props.instruction || '',
      publishedAt,
      source: feed.name,
      category: feed.category,
      agency: props.senderName || null,
      event: props.event || null,
      signalType: props.event || null,
      status: props.status || null,
      messageType: props.messageType || null,
      severity: props.severity || null,
      certainty: props.certainty || null,
      urgency: props.urgency || null,
      effectiveDate: props.effective || null,
      onset: props.onset || null,
      expires: props.expires || null,
      ends: props.ends || null,
      areaDesc: props.areaDesc || '',
      affectedZones: props.affectedZones || [],
      geocode: props.geocode || {},
      jurisdictionCodes,
      jurisdictionNames: jurisdictionCodes.map(jurisdictionNameForCode),
      geometry,
      geo: lat !== null && lon !== null ? { lat, lon } : null
    };
  }).filter((item) => !['test', 'exercise', 'draft', 'system'].includes(String(item.status || '').toLowerCase()));
}

export function parseGenericJsonFeed(data, feed) {
  if (feed?.id === 'nws-alerts' && Array.isArray(data?.features)) {
    return normalizeNwsSignals(data, feed);
  }
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
    const isCongressBill = isCongressBillEntry(entry, feed);
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
          : isCongressBill
            ? buildCongressBillTitle(entry, fallbackTitle)
            : (isCommitteeReport ? buildCommitteeReportTitle(entry, fallbackTitle) : fallbackTitle);
    const congressBillUrl = isCongressBill ? buildCongressBillWebUrl(entry) : '';
    const url = congressVoteUrl || congressBillUrl || properties.url || entry.openstates_url || entry.url || entry.html_url || entry.link || entry.permalink || entry.webUrl || entry.packageLink || entry.detailsLink || entry.pdf_url || '';
    const defaultSummary = normalizeSummary(entry.summary || entry.description || entry.body || entry.abstract || properties.status || properties.type || properties.place || '');
    const congressBillSummary = normalizeSummary([
      entry.latestAction?.text || '',
      entry.latestAction?.actionDate || '',
      entry.updateDate || ''
    ].filter(Boolean).join(' • '));
    const voteSummary = normalizeSummary(
      [
        entry.voteQuestion || entry.question || '',
        entry.result || entry.voteResult || '',
        entry.voteType || ''
      ].filter(Boolean).join(' • ')
    );
    const summary = isCongressHouseVote
      ? (voteSummary || defaultSummary)
      : isCongressBill
        ? (congressBillSummary || defaultSummary)
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
      entry.publication_date,
      entry.lastModified,
      entry.dateIssued,
      entry.updateDate,
      entry.updateDateIncludingText,
      entry.introducedDate,
      entry.updated_at,
      entry.startDate,
      entry.updatedAt,
      entry.updated,
      entry.latest_action_date,
      entry.latest_passage_date,
      entry.latestPassageDate,
      entry.latestAction?.actionDate,
      feed?.id === 'swpc-json' ? normalizeSwpcTimestamp(entry.time_tag) : null,
      entry.effectiveDate,
      entry.effective_date,
      latestEonetGeometry?.date
    );
    const eventCoords = Array.isArray(latestEonetGeometry?.coordinates) ? latestEonetGeometry.coordinates : [];
    const featureCoords = Array.isArray(entry?.geometry?.coordinates) ? entry.geometry.coordinates : [];
    const point = (latValue, lonValue) => {
      const lat = normalizeFiniteNumber(latValue);
      const lon = normalizeFiniteNumber(lonValue);
      return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
    };
    const geo = point(entry.geo?.lat, entry.geo?.lon)
      || point(entry.latitude, entry.longitude)
      || (entry.geometry?.type === 'Point' ? point(featureCoords[1], featureCoords[0]) : null)
      || (latestEonetGeometry?.type === 'Point' ? point(eventCoords[1], eventCoords[0]) : null);
    const stateMeta = extractStateMetadata(entry, feed);
    const hasStateMeta = Object.values(stateMeta).some((value) => value !== null && value !== '');
    const stateIdentifier = String(entry.identifier || entry.bill_id || entry.billId || '').trim();
    const stateTitlePrefix = [stateMeta.jurisdictionCode, stateIdentifier].filter(Boolean).join(' ');
    const normalizedTitle = String(title || '').toUpperCase();
    const titleWithStateIdentifier = feed?.id === 'state-legislation' && stateIdentifier
      && !normalizedTitle.startsWith(stateIdentifier.toUpperCase())
      && (!stateTitlePrefix || !normalizedTitle.startsWith(stateTitlePrefix.toUpperCase()))
      ? `${stateTitlePrefix || stateIdentifier} - ${title}`
      : title;
    const congressBillMeta = isCongressBill ? {
      billNumber: String(entry.number || entry.billNumber || ''),
      billType: String(entry.type || entry.billType || ''),
      congress: entry.congress || null,
      latestAction: entry.latestAction || null,
      updateDate: entry.updateDate || null,
      introducedDate: entry.introducedDate || null,
      apiUrl: entry.apiUrl || ''
    } : {};
    return {
      title: titleWithStateIdentifier,
      url,
      summary: finalSummary,
      publishedAt: Number.isNaN(publishedAt) ? Date.now() : publishedAt,
      source: entry.source || feed.name,
      category: feed.category,
      geo,
      ...(feed?.id === 'nasa-firms' ? {
        observationKey: JSON.stringify([
          entry.source || feed.name, entry.id || entry.docId || null, geo,
          publishedAt, entry.satellite || null, entry.instrument || null, finalSummary
        ])
      } : {}),
      ...(hasStateMeta ? stateMeta : {}),
      ...congressBillMeta
    };
  });
}

export function normalizeJsonSignals(text, feed) {
  const normalizeParsed = (data) => (
    feed?.id === 'swpc-json' && Array.isArray(data)
      ? normalizeSwpcSignals(data, feed)
      : parseGenericJsonFeed(data, feed)
  );
  try {
    return normalizeParsed(parseJsonFeedPayload(text, feed));
  } catch {
    const trimmed = String(text || '').trim();
    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart === -1 || objectEnd <= objectStart) return [];
    try {
      return normalizeParsed(parseJsonFeedPayload(trimmed.slice(objectStart, objectEnd + 1), feed));
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
