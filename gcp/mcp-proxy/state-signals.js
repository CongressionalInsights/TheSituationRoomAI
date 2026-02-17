const US_STATE_OPTIONS = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' }
];

const US_STATE_CODE_SET = new Set(US_STATE_OPTIONS.map((entry) => entry.code));
const US_STATE_CODE_BY_NAME = Object.fromEntries(
  US_STATE_OPTIONS.map((entry) => [entry.name.toLowerCase(), entry.code])
);

export function sanitizeParamsObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cleaned = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (!key || value === undefined || value === null || value === '') return;
    cleaned[key] = String(value);
  });
  return cleaned;
}

export function normalizeJurisdictionCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (US_STATE_CODE_SET.has(upper)) return upper;
  const lower = raw.toLowerCase();
  if (US_STATE_CODE_BY_NAME[lower]) return US_STATE_CODE_BY_NAME[lower];
  const match = lower.match(/state:([a-z]{2})/);
  if (!match) return '';
  const parsed = match[1].toUpperCase();
  return US_STATE_CODE_SET.has(parsed) ? parsed : '';
}

function inferSignalType(feed) {
  if (!Array.isArray(feed?.capabilities) || !feed.capabilities.length) return '';
  return String(feed.capabilities[0] || '');
}

function applyStateCodeStrategy(feed, params) {
  const signalType = inferSignalType(feed);
  const stateCode = normalizeJurisdictionCode(params.state || params.jurisdictionCode);
  if (stateCode) {
    params.state = stateCode;
    params.jurisdictionCode = stateCode;
  } else {
    delete params.state;
    delete params.jurisdictionCode;
  }
  if (signalType && !params.signalType) {
    params.signalType = signalType;
  }
  return params;
}

function applyOpenStatesStrategy(params) {
  const stateCode = normalizeJurisdictionCode(params.state || params.jurisdictionCode || params.jurisdiction);
  if (stateCode && !String(params.jurisdiction || '').includes('ocd-jurisdiction/')) {
    params.jurisdiction = `ocd-jurisdiction/country:us/state:${stateCode.toLowerCase()}/government`;
  }
  delete params.state;
  delete params.jurisdictionCode;
  delete params.signalType;
  return params;
}

function applyFeedParamStrategy(feed, params = {}) {
  const resolved = { ...sanitizeParamsObject(params) };
  const strategy = feed?.paramStrategy || '';
  if (strategy === 'openstates-jurisdiction') return applyOpenStatesStrategy(resolved);
  if (strategy === 'state-code') return applyStateCodeStrategy(feed, resolved);
  return resolved;
}

export function mergeFeedParams(feed, requestParams = {}) {
  if (!feed?.supportsParams) return {};
  const merged = {
    ...sanitizeParamsObject(feed.defaultParams),
    ...sanitizeParamsObject(requestParams)
  };
  return applyFeedParamStrategy(feed, merged);
}
