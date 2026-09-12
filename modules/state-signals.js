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

const US_STATE_NAME_BY_CODE = Object.fromEntries(US_STATE_OPTIONS.map((entry) => [entry.code, entry.name]));
const US_STATE_CODE_BY_NAME = Object.fromEntries(
  US_STATE_OPTIONS.map((entry) => [entry.name.toLowerCase(), entry.code])
);

export function getStateOptions() {
  return US_STATE_OPTIONS;
}

export function getStateNameByCode(code) {
  const normalized = normalizeJurisdictionCode(code);
  return normalized ? US_STATE_NAME_BY_CODE[normalized] || normalized : '';
}

export function normalizeJurisdictionCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (US_STATE_NAME_BY_CODE[upper]) return upper;
  const lower = raw.toLowerCase();
  if (US_STATE_CODE_BY_NAME[lower]) return US_STATE_CODE_BY_NAME[lower];
  const match = lower.match(/state:([a-z]{2})/);
  if (match) {
    const parsed = match[1].toUpperCase();
    return US_STATE_NAME_BY_CODE[parsed] ? parsed : '';
  }
  return '';
}

export function getStateSignalFilterCode(value) {
  const code = normalizeJurisdictionCode(value);
  return code || 'ALL';
}

export function getStateSignalFilterName(value) {
  const code = getStateSignalFilterCode(value);
  if (code === 'ALL') return 'All states';
  return US_STATE_NAME_BY_CODE[code] || code;
}

export function renderStateSignalFilterOptions(selectElement, selectedValue = 'ALL') {
  if (!selectElement) return;
  const selectedCode = getStateSignalFilterCode(selectedValue);
  const options = [{ code: 'ALL', name: 'All states' }, ...US_STATE_OPTIONS];
  selectElement.innerHTML = options.map((entry) => (
    `<option value="${entry.code}">${entry.name}</option>`
  )).join('');
  selectElement.value = selectedCode;
}

function getStateCodeFromItem(item) {
  return normalizeJurisdictionCode(
    item?.jurisdictionCode
      || item?.stateCode
      || item?.regionTag
      || item?.location
  );
}

export function applyStateSignalFilter(items, selectedState = 'ALL', { includeFederal = true } = {}) {
  const selectedCode = getStateSignalFilterCode(selectedState);
  if (selectedCode === 'ALL') return items;
  return (items || []).filter((item) => {
    const level = String(item?.jurisdictionLevel || '').toLowerCase();
    if (level === 'state') {
      return getStateCodeFromItem(item) === selectedCode;
    }
    return includeFederal;
  });
}

export function buildStateFeedRequestParams(feed, selectedState = 'ALL') {
  if (!feed || !feed.supportsParams) return {};
  if (String(feed.jurisdictionLevel || '').toLowerCase() !== 'state') return {};

  const selectedCode = getStateSignalFilterCode(selectedState);
  const strategy = feed.paramStrategy || 'state-code';
  const params = {};

  if (strategy === 'openstates-jurisdiction') {
    if (selectedCode !== 'ALL') {
      params.jurisdiction = `ocd-jurisdiction/country:us/state:${selectedCode.toLowerCase()}/government`;
    }
    return params;
  }

  if (selectedCode !== 'ALL') {
    params.state = selectedCode;
    params.jurisdictionCode = selectedCode;
  }

  if (Array.isArray(feed.capabilities) && feed.capabilities.length) {
    params.signalType = feed.capabilities[0];
  }

  return params;
}
