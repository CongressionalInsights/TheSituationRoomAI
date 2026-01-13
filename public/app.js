import { apiFetch, apiJson, getAssetUrl, isStaticMode, getOpenAiProxy } from './services/api.js';

const LAYOUT_VERSION = 3;
const CUSTOM_FEEDS_KEY = 'situationRoomCustomFeeds';

const state = {
  feeds: [],
  baseFeeds: [],
  customFeeds: [],
  items: [],
  scopedItems: [],
  clusters: [],
  panels: {
    defaultOrder: [],
    order: [],
    visibility: {},
    sizes: {}
  },
  keys: {},
  keyStatus: {},
  keyFilter: null,
  feedStatus: {},
  keyGroups: {},
  searchCategories: [],
  translationCache: {},
  translationInFlight: new Set(),
  staticAnalysis: null,
  customTickers: [],
  energyMarket: {},
  listLimits: {},
  settings: {
    refreshMinutes: 60,
    theme: 'system',
    maxAgeDays: 30,
    languageMode: 'en',
    radiusKm: 150,
    scope: 'global',
    aiTranslate: true,
    superMonitor: false,
    showStatus: true,
    showTravelTicker: true,
    showKeys: true,
    liveSearch: true,
    tickerWatchlist: [],
    mapBasemap: 'osm',
    mapRasterOverlays: {
      hillshade: false,
      sar: false
      ,
      aerosol: false,
      thermal: false,
      fire: false
    },
    mapImageryDate: '',
    mapSarDate: '',
    mapOverlayOpacity: {
      hillshade: 0.45,
      sar: 0.55,
      aerosol: 0.45,
      thermal: 0.6,
      fire: 0.6
    },
    mapLayers: {
      weather: true,
      disaster: true,
      space: true,
      news: true,
      spill: true,
      health: true,
      travel: true,
      transport: true,
      security: true,
      infrastructure: true,
      local: true
    }
  },
  location: {
    lat: 35.5951,
    lon: -82.5515,
    source: 'fallback'
  },
  geoCache: {},
  chatHistory: [],
  mapPoints: [],
  map: null,
  mapBaseLayers: {},
  mapOverlayLayers: {},
  activeBaseLayer: null,
  imageryDate: null,
  sarDate: null,
  imageryDateManual: false,
  sarDateManual: false,
  imageryResolveInFlight: false,
  sarResolveInFlight: false,
  energyMap: null,
  energyMapLayer: null,
  energyGeo: null,
  energyMapData: null,
  energyMapError: null,
  energyMapFetchedAt: 0,
  lastBuildAt: null,
  refreshTimer: null,
  lastFetch: null,
  retryingFeeds: false,
  staleRetrying: false,
  lastStaleRetry: 0,
  health: 'Initializing',
  previousSignals: null,
  analysisSignature: null,
  analysisRunning: false
};

const elements = {
  app: document.querySelector('.app'),
  sidebar: document.getElementById('sidebar'),
  sidebarScrim: document.getElementById('sidebarScrim'),
  navToggle: document.getElementById('navToggle'),
  sidebarSettings: document.getElementById('sidebarSettings'),
  sidebarAbout: document.getElementById('sidebarAbout'),
  communityConnect: document.getElementById('communityConnect'),
  communityFrame: document.querySelector('.chat-frame'),
  panelGrid: document.getElementById('panelGrid'),
  exportSnapshot: document.getElementById('exportSnapshot'),
  refreshNow: document.getElementById('refreshNow'),
  statusText: document.getElementById('statusText'),
  dataFresh: document.getElementById('dataFresh'),
  refreshValue: document.getElementById('refreshValue'),
  refreshRange: document.getElementById('refreshRange'),
  refreshRangeValue: document.getElementById('refreshRangeValue'),
  maxAgeRange: document.getElementById('maxAgeRange'),
  maxAgeValue: document.getElementById('maxAgeValue'),
  languageToggle: document.getElementById('languageToggle'),
  radiusRange: document.getElementById('radiusRange'),
  radiusRangeValue: document.getElementById('radiusRangeValue'),
  themeToggle: document.getElementById('themeToggle'),
  ageToggle: document.getElementById('ageToggle'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsToggle: document.getElementById('settingsToggle'),
  settingsClose: document.getElementById('settingsClose'),
  panelToggles: document.getElementById('panelToggles'),
  resetLayout: document.getElementById('resetLayout'),
  aiTranslateToggle: document.getElementById('aiTranslateToggle'),
  superMonitorToggle: document.getElementById('superMonitorToggle'),
  keyManager: document.getElementById('keyManager'),
  feedHealth: document.getElementById('feedHealth'),
  aboutOverlay: document.getElementById('aboutOverlay'),
  aboutOpen: document.getElementById('aboutOpen'),
  aboutOpenSettings: document.getElementById('aboutOpenSettings'),
  aboutClose: document.getElementById('aboutClose'),
  listOverlay: document.getElementById('listOverlay'),
  listModalTitle: document.getElementById('listModalTitle'),
  listModalMeta: document.getElementById('listModalMeta'),
  listModalList: document.getElementById('listModalList'),
  listModalClose: document.getElementById('listModalClose'),
  feedScope: document.getElementById('feedScope'),
  searchInput: document.getElementById('searchInput'),
  searchBtn: document.getElementById('searchBtn'),
  searchHint: document.getElementById('searchHint'),
  liveSearchToggle: document.getElementById('liveSearchToggle'),
  scopeToggle: document.getElementById('scopeToggle'),
  geoLocateBtn: document.getElementById('geoLocateBtn'),
  geoValue: document.getElementById('geoValue'),
  healthValue: document.getElementById('healthValue'),
  statusCompact: document.getElementById('statusCompact'),
  statusToggle: document.getElementById('statusToggle'),
  keySection: document.getElementById('keySection'),
  keyCompactBody: document.getElementById('keyCompactBody'),
  keyToggle: document.getElementById('keyToggle'),
  newsList: document.getElementById('newsList'),
  cryptoList: document.getElementById('cryptoList'),
  disasterList: document.getElementById('disasterList'),
  localList: document.getElementById('localList'),
  predictionList: document.getElementById('predictionList'),
  policyList: document.getElementById('policyList'),
  cyberList: document.getElementById('cyberList'),
  agricultureList: document.getElementById('agricultureList'),
  researchList: document.getElementById('researchList'),
  spaceList: document.getElementById('spaceList'),
  energyList: document.getElementById('energyList'),
  energyMap: document.getElementById('energyMap'),
  energyMapLegend: document.getElementById('energyMapLegend'),
  energyMapEmpty: document.getElementById('energyMapEmpty'),
  healthList: document.getElementById('healthList'),
  transportList: document.getElementById('transportList'),
  analysisOutput: document.getElementById('analysisOutput'),
  analysisBody: document.querySelector('#analysisOutput .analysis-body'),
  analysisRun: document.getElementById('analysisRun'),
  summaryGlobalActivity: document.getElementById('summaryGlobalActivity'),
  summaryGlobalActivityMeta: document.getElementById('summaryGlobalActivityMeta'),
  summaryNewsSaturation: document.getElementById('summaryNewsSaturation'),
  summaryNewsSaturationMeta: document.getElementById('summaryNewsSaturationMeta'),
  summaryLocalEvents: document.getElementById('summaryLocalEvents'),
  summaryLocalEventsMeta: document.getElementById('summaryLocalEventsMeta'),
  summaryMarketPulse: document.getElementById('summaryMarketPulse'),
  summaryMarketPulseMeta: document.getElementById('summaryMarketPulseMeta'),
  globalActivity: document.getElementById('globalActivity'),
  globalActivityMeta: document.getElementById('globalActivityMeta'),
  newsSaturation: document.getElementById('newsSaturation'),
  newsSaturationMeta: document.getElementById('newsSaturationMeta'),
  localEvents: document.getElementById('localEvents'),
  localEventsMeta: document.getElementById('localEventsMeta'),
  marketPulse: document.getElementById('marketPulse'),
  marketPulseMeta: document.getElementById('marketPulseMeta'),
  signalHealthChip: document.getElementById('signalHealthChip'),
  mapCanvas: document.getElementById('mapCanvas'),
  mapBase: document.getElementById('mapBase'),
  mapEmpty: document.getElementById('mapEmpty'),
  mapTooltip: document.getElementById('mapTooltip'),
  mapLegendBtn: document.getElementById('mapLegendBtn'),
  mapLegend: document.getElementById('mapLegend'),
  imageryDateInput: document.getElementById('imageryDateInput'),
  sarDateInput: document.getElementById('sarDateInput'),
  imageryDatePanel: document.getElementById('imageryDatePanel'),
  sarDatePanel: document.getElementById('sarDatePanel'),
  imageryAutoBtn: document.getElementById('imageryAutoBtn'),
  sarAutoBtn: document.getElementById('sarAutoBtn'),
  imageryPanelAutoBtn: document.getElementById('imageryPanelAutoBtn'),
  sarPanelAutoBtn: document.getElementById('sarPanelAutoBtn'),
  imageryResetBtn: document.getElementById('imageryResetBtn'),
  imageryResetPanelBtn: document.getElementById('imageryResetPanelBtn'),
  mapDetail: document.getElementById('mapDetail'),
  mapDetailList: document.getElementById('mapDetailList'),
  mapDetailMeta: document.getElementById('mapDetailMeta'),
  mapDetailClose: document.getElementById('mapDetailClose'),
  mapWrap: document.querySelector('.map-wrap'),
  travelTicker: document.getElementById('travelTicker'),
  travelTickerTrack: document.getElementById('travelTickerTrack'),
  travelTickerBtn: document.getElementById('travelTickerBtn'),
  tickerBar: document.getElementById('tickerBar'),
  tickerTrack: document.getElementById('tickerTrack'),
  financeSpotlight: document.getElementById('financeSpotlight'),
  searchResults: document.getElementById('searchResults'),
  searchResultsList: document.getElementById('searchResultsList'),
  searchResultsMeta: document.getElementById('searchResultsMeta'),
  searchResultsClose: document.getElementById('searchResultsClose'),
  categoryFilters: document.getElementById('categoryFilters'),
  savedSearches: document.getElementById('savedSearches'),
  chatLog: document.getElementById('chatLog'),
  chatInput: document.getElementById('chatInput'),
  chatSend: document.getElementById('chatSend'),
  financeMarketsList: document.getElementById('financeMarketsList'),
  financePolicyList: document.getElementById('financePolicyList'),
  financeTabs: document.getElementById('financeTabs')
  ,
  customFeedToggle: document.getElementById('customFeedToggle'),
  customFeedExport: document.getElementById('customFeedExport'),
  customFeedImportToggle: document.getElementById('customFeedImportToggle'),
  customFeedDownload: document.getElementById('customFeedDownload'),
  customFeedOpen: document.getElementById('customFeedOpen'),
  customFeedJsonPanel: document.getElementById('customFeedJsonPanel'),
  customFeedJson: document.getElementById('customFeedJson'),
  customFeedJsonCopy: document.getElementById('customFeedJsonCopy'),
  customFeedJsonApply: document.getElementById('customFeedJsonApply'),
  customFeedJsonStatus: document.getElementById('customFeedJsonStatus'),
  customFeedList: document.getElementById('customFeedList'),
  customFeedForm: document.getElementById('customFeedForm'),
  customFeedName: document.getElementById('customFeedName'),
  customFeedUrl: document.getElementById('customFeedUrl'),
  customFeedCategory: document.getElementById('customFeedCategory'),
  customFeedFormat: document.getElementById('customFeedFormat'),
  customFeedProxy: document.getElementById('customFeedProxy'),
  customFeedTags: document.getElementById('customFeedTags'),
  customFeedSupportsQuery: document.getElementById('customFeedSupportsQuery'),
  customFeedDefaultQuery: document.getElementById('customFeedDefaultQuery'),
  customFeedRequiresKey: document.getElementById('customFeedRequiresKey'),
  customFeedKeyParam: document.getElementById('customFeedKeyParam'),
  customFeedKeyHeader: document.getElementById('customFeedKeyHeader'),
  customFeedTtl: document.getElementById('customFeedTtl'),
  customFeedSave: document.getElementById('customFeedSave'),
  customFeedCancel: document.getElementById('customFeedCancel'),
  customFeedStatus: document.getElementById('customFeedStatus')
};

const defaultPanelSizes = {
  map: { cols: 12 },
  ticker: { cols: 12 },
  'finance-spotlight': { cols: 12 },
  imagery: { cols: 12 },
  command: { cols: 12 },
  signals: { cols: 5 },
  news: { cols: 6 },
  finance: { cols: 3 },
  crypto: { cols: 3 },
  prediction: { cols: 4 },
  hazards: { cols: 4 },
  local: { cols: 8 },
  community: { cols: 6 },
  policy: { cols: 4 },
  cyber: { cols: 4 },
  agriculture: { cols: 4 },
  research: { cols: 4 },
  space: { cols: 4 },
  'energy-map': { cols: 6 },
  energy: { cols: 4 },
  health: { cols: 4 },
  transport: { cols: 4 }
};

let editingCustomFeedId = null;

const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'on', 'with', 'at', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'has', 'have']);
const allowedSummaryTags = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'span', 'a', 'font']);
const docsMap = {
  openai: 'https://platform.openai.com/api-keys'
};
const keyGroupLabels = {
  'api.data.gov': 'Data.gov (FOIA + GovInfo)',
  'eia': 'EIA (Energy)'
};
const panelKeyFilters = {
  hazards: ['weather', 'disaster', 'space'],
  finance: ['finance', 'gov', 'cyber', 'agriculture'],
  map: ['weather', 'disaster', 'space', 'news', 'travel', 'transport', 'local'],
  geo: ['weather', 'disaster', 'space', 'news', 'travel', 'transport', 'local'],
  local: ['news', 'gov', 'disaster', 'weather'],
  assistant: ['assistant']
};
const categoryLabels = {
  news: 'News',
  finance: 'Finance',
  gov: 'Government',
  crypto: 'Crypto / Web3',
  prediction: 'Prediction Markets',
  spill: 'Oil Spills',
  disaster: 'Disasters',
  weather: 'Weather',
  space: 'Space',
  cyber: 'Cyber',
  agriculture: 'Agriculture',
  research: 'Research',
  energy: 'Energy',
  health: 'Health',
  travel: 'Travel',
  transport: 'Transport',
  security: 'Security',
  infrastructure: 'Infrastructure',
  local: 'Local'
};
const categoryOrder = ['news', 'finance', 'gov', 'crypto', 'prediction', 'spill', 'disaster', 'weather', 'space', 'cyber', 'agriculture', 'research', 'energy', 'health', 'travel', 'transport', 'security', 'infrastructure', 'local'];
const globalFallbackCategories = new Set(['crypto', 'research', 'space', 'travel', 'health']);
const listDefaults = {
  newsList: 30,
  financeMarketsList: 20,
  financePolicyList: 20,
  cryptoList: 20,
  predictionList: 20,
  disasterList: 20,
  localList: 20,
  policyList: 20,
  cyberList: 20,
  agricultureList: 20,
  researchList: 20,
  spaceList: 20,
  energyList: 20,
  healthList: 20,
  transportList: 20
};
const listPageSize = 8;
const listModalConfigs = [
  { id: 'newsList', title: 'News Layer', withCoverage: true, getItems: () => buildNewsItems(state.clusters) },
  { id: 'financeMarketsList', title: 'Finance: Markets', getItems: () => getCombinedItems(['finance', 'energy']) },
  { id: 'financePolicyList', title: 'Finance: Regulatory', getItems: () => getCombinedItems(['gov', 'cyber', 'agriculture']) },
  { id: 'cryptoList', title: 'Crypto / Web3', getItems: () => getCategoryItems('crypto').items },
  { id: 'predictionList', title: 'Prediction Markets', getItems: () => getPredictionItems() },
  { id: 'disasterList', title: 'Hazards & Weather', getItems: () => getCombinedItems(['disaster', 'weather', 'space']) },
  { id: 'localList', title: 'Local Lens', getItems: () => getLocalItemsForPanel() },
  { id: 'policyList', title: 'Policy & Government', getItems: () => getCategoryItems('gov').items },
  { id: 'cyberList', title: 'Cyber Pulse', getItems: () => getCategoryItems('cyber').items },
  { id: 'agricultureList', title: 'Agriculture', getItems: () => getCategoryItems('agriculture').items },
  { id: 'researchList', title: 'Research Watch', getItems: () => getCategoryItems('research').items },
  { id: 'spaceList', title: 'Space Weather', getItems: () => getCategoryItems('space').items },
  { id: 'energyList', title: 'Energy', getItems: () => getEnergyNewsItems() },
  { id: 'healthList', title: 'Health', getItems: () => getCategoryItems('health').items },
  { id: 'transportList', title: 'Transport & Logistics', getItems: () => getCategoryItems('transport').items }
];
const listModalConfigMap = Object.fromEntries(listModalConfigs.map((config) => [config.id, config]));

const GIBS_LAYERS = {
  'gibs-viirs': {
    id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    label: 'NASA VIIRS True Color',
    format: 'jpg',
    maxZoom: 9,
    matrixSet: 'GoogleMapsCompatible_Level9'
  },
  'gibs-modis-terra': {
    id: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    label: 'MODIS Terra True Color',
    format: 'jpg',
    maxZoom: 9,
    matrixSet: 'GoogleMapsCompatible_Level9'
  },
  'gibs-modis-aqua': {
    id: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
    label: 'MODIS Aqua True Color',
    format: 'jpg',
    maxZoom: 9,
    matrixSet: 'GoogleMapsCompatible_Level9'
  },
  'gibs-nightlights': {
    id: 'VIIRS_Black_Marble',
    label: 'VIIRS Black Marble',
    format: 'png',
    maxZoom: 8,
    matrixSet: 'GoogleMapsCompatible_Level8',
    defaultDate: '2016-01-01'
  },
  'gibs-daynight': {
    id: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance',
    label: 'VIIRS Day/Night Band',
    format: 'png',
    maxZoom: 8,
    matrixSet: 'GoogleMapsCompatible_Level8'
  }
};

const GIBS_OVERLAYS = {
  aerosol: {
    id: 'OMPS_Aerosol_Index',
    label: 'Aerosol Index',
    format: 'png',
    maxZoom: 6,
    matrixSet: 'GoogleMapsCompatible_Level6',
    opacity: 0.45
  },
  thermal: {
    id: 'VIIRS_SNPP_Thermal_Anomalies_375m_All',
    label: 'Thermal Anomalies',
    format: 'png',
    maxZoom: 6,
    matrixSet: 'GoogleMapsCompatible_Level6',
    opacity: 0.6
  },
  'fire-east': {
    id: 'GOES-East_ABI_FireTemp',
    label: 'GOES East Fire Temp',
    format: 'png',
    maxZoom: 6,
    matrixSet: 'GoogleMapsCompatible_Level6',
    opacity: 0.6
  },
  'fire-west': {
    id: 'GOES-West_ABI_FireTemp',
    label: 'GOES West Fire Temp',
    format: 'png',
    maxZoom: 6,
    matrixSet: 'GoogleMapsCompatible_Level6',
    opacity: 0.6
  }
};
const severityLabels = [
  { min: 8, label: 'Great' },
  { min: 7, label: 'Major' },
  { min: 6, label: 'Strong' },
  { min: 5, label: 'Moderate' },
  { min: 4, label: 'Light' },
  { min: 3, label: 'Minor' },
  { min: 0, label: 'Micro' }
];
const criticalFeedIds = [
  'google-news-us',
  'bbc-world',
  'guardian-world',
  'pbs-headlines',
  'usgs-quakes-hour',
  'nws-alerts',
  'eonet-events',
  'cdc-travel-notices',
  'coinpaprika-global',
  'coinpaprika-tickers',
  'treasury-debt',
  'bls-cpi',
  'energy-eia',
  'energy-eia-brent',
  'energy-eia-ng',
  'eia-today'
];

function countCriticalIssues(results) {
  return results.filter((result) => {
    if (!result?.feed?.id || !criticalFeedIds.includes(result.feed.id)) return false;
    if (result.error === 'requires_key' || result.error === 'requires_config' || result.error === 'missing_server_key') return false;
    return result.error || (result.httpStatus && result.httpStatus >= 400);
  }).length;
}

function isFeedStale(feed, status) {
  if (!status?.fetchedAt) return false;
  const ttl = Number(feed?.ttlMinutes) || state.settings.refreshMinutes;
  const buffer = Math.max(5, Math.min(15, Math.round(ttl * 0.2)));
  const maxAgeMs = (ttl + buffer) * 60 * 1000;
  return Date.now() - status.fetchedAt > maxAgeMs;
}
const usStateCodes = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC'
]);

function loadSettings() {
  const saved = localStorage.getItem('situationRoomSettings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const defaultLayers = { ...state.settings.mapLayers };
      const defaultOverlays = { ...state.settings.mapRasterOverlays };
      const defaultOpacity = { ...state.settings.mapOverlayOpacity };
      Object.assign(state.settings, parsed);
      state.settings.mapLayers = { ...defaultLayers, ...(parsed.mapLayers || {}) };
      state.settings.mapRasterOverlays = { ...defaultOverlays, ...(parsed.mapRasterOverlays || {}) };
      state.settings.mapOverlayOpacity = { ...defaultOpacity, ...(parsed.mapOverlayOpacity || {}) };
      if (!state.settings.mapBasemap) {
        state.settings.mapBasemap = 'osm';
      }
      if (state.settings.mapBasemap === 'gibs') {
        state.settings.mapBasemap = 'gibs-viirs';
      }
      if (!state.settings.mapImageryDate) {
        state.settings.mapImageryDate = '';
      }
      if (!state.settings.mapSarDate) {
        state.settings.mapSarDate = '';
      }
      if (typeof state.settings.aiTranslate !== 'boolean') {
        state.settings.aiTranslate = true;
      }
      if (typeof state.settings.showStatus !== 'boolean') {
        state.settings.showStatus = true;
      }
      if (typeof state.settings.showTravelTicker !== 'boolean') {
        state.settings.showTravelTicker = true;
      }
      if (typeof state.settings.showKeys !== 'boolean') {
        state.settings.showKeys = true;
      }
      if (typeof state.settings.liveSearch !== 'boolean') {
        state.settings.liveSearch = true;
      }
      if (typeof state.settings.superMonitor !== 'boolean') {
        state.settings.superMonitor = isStaticMode();
      }
      if (!Array.isArray(state.settings.tickerWatchlist)) {
        state.settings.tickerWatchlist = [];
      }
    } catch (err) {
      state.settings.aiTranslate = true;
      state.settings.showStatus = true;
      state.settings.showTravelTicker = true;
      state.settings.showKeys = true;
      state.settings.liveSearch = true;
      state.settings.superMonitor = isStaticMode();
      state.settings.tickerWatchlist = [];
      state.settings.mapBasemap = 'osm';
      state.settings.mapRasterOverlays = { ...state.settings.mapRasterOverlays };
      state.settings.mapImageryDate = '';
      state.settings.mapSarDate = '';
      state.settings.mapOverlayOpacity = { ...state.settings.mapOverlayOpacity };
    }
  }
}

function saveSettings() {
  localStorage.setItem('situationRoomSettings', JSON.stringify(state.settings));
}

function loadKeys() {
  const saved = localStorage.getItem('situationRoomKeys');
  if (saved) {
    try {
      state.keys = JSON.parse(saved);
      if (state.keys?.openai?.key) {
        state.keys.openai.key = state.keys.openai.key.trim();
      }
    } catch (err) {
      state.keys = {};
    }
  }
}

function saveKeys() {
  localStorage.setItem('situationRoomKeys', JSON.stringify(state.keys));
}

function loadKeyGroups() {
  const saved = localStorage.getItem('situationRoomKeyGroups');
  if (saved) {
    try {
      state.keyGroups = JSON.parse(saved);
    } catch (err) {
      state.keyGroups = {};
    }
  }
}

function saveKeyGroups() {
  localStorage.setItem('situationRoomKeyGroups', JSON.stringify(state.keyGroups));
}

function loadKeyStatus() {
  const saved = localStorage.getItem('situationRoomKeyStatus');
  if (saved) {
    try {
      state.keyStatus = JSON.parse(saved);
    } catch (err) {
      state.keyStatus = {};
    }
  }
}

function saveKeyStatus() {
  localStorage.setItem('situationRoomKeyStatus', JSON.stringify(state.keyStatus));
}

function loadGeoCache() {
  const saved = localStorage.getItem('situationRoomGeoCache');
  if (saved) {
    try {
      state.geoCache = JSON.parse(saved);
    } catch (err) {
      state.geoCache = {};
    }
  }
}

function saveGeoCache() {
  localStorage.setItem('situationRoomGeoCache', JSON.stringify(state.geoCache));
}

function loadCustomFeeds() {
  const saved = localStorage.getItem(CUSTOM_FEEDS_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((feed) => ({
      ...feed,
      tags: Array.isArray(feed.tags) ? feed.tags : [],
      supportsQuery: Boolean(feed.supportsQuery),
      requiresKey: Boolean(feed.requiresKey),
      format: feed.format || 'rss',
      category: feed.category || 'news',
      ttlMinutes: Number(feed.ttlMinutes || 60),
      isCustom: true,
      keySource: 'client'
    }));
  } catch (err) {
    return [];
  }
}

function saveCustomFeeds() {
  localStorage.setItem(CUSTOM_FEEDS_KEY, JSON.stringify(state.customFeeds));
}

function hashString(value) {
  let hash = 0;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function mergeCustomFeeds(baseFeeds, customFeeds) {
  const merged = [...baseFeeds];
  const existing = new Set(baseFeeds.map((feed) => feed.id));
  let mutated = false;
  customFeeds.forEach((feed) => {
    let id = feed.id;
    if (!id) {
      id = `custom-${hashString(feed.url || feed.name)}`;
      feed.id = id;
      mutated = true;
    }
    if (existing.has(id)) {
      const nextId = `${id}-${Math.random().toString(36).slice(2, 6)}`;
      feed.id = nextId;
      id = nextId;
      mutated = true;
    }
    feed.isCustom = true;
    feed.keySource = 'client';
    existing.add(id);
    merged.push(feed);
  });
  if (mutated) saveCustomFeeds();
  return merged;
}

async function loadStaticAnalysis() {
  if (!isStaticMode()) return null;
  try {
    const url = getAssetUrl(`/data/analysis.json?ts=${Date.now()}`);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('analysis_fetch_failed');
    const payload = await response.json();
    if (!payload || !payload.text) {
      state.staticAnalysis = null;
      return null;
    }
    state.staticAnalysis = payload;
    return payload;
  } catch (err) {
    state.staticAnalysis = null;
    return null;
  }
}

async function loadStaticBuild() {
  if (!isStaticMode()) return null;
  try {
    const url = getAssetUrl(`/data/build.json?ts=${Date.now()}`);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('build_fetch_failed');
    const payload = await response.json();
    if (payload?.generatedAt) {
      state.lastBuildAt = Date.parse(payload.generatedAt);
    }
    return payload;
  } catch {
    return null;
  }
}

function updateDataFreshBadge() {
  if (!elements.dataFresh) return;
  let stamp = state.lastFetch;
  if (isStaticMode()) {
    stamp = state.settings.superMonitor ? state.lastFetch : (state.lastBuildAt || state.lastFetch);
  }
  if (!stamp) {
    elements.dataFresh.textContent = 'Data fresh';
    elements.dataFresh.removeAttribute('title');
    return;
  }
  const relative = toRelativeTime(stamp);
  elements.dataFresh.textContent = isStaticMode()
    ? (state.settings.superMonitor ? `Live ${relative}` : `Cache ${relative}`)
    : `Data ${relative}`;
  const exact = new Date(stamp).toLocaleString();
  elements.dataFresh.title = isStaticMode()
    ? (state.settings.superMonitor ? `Live fetch ${exact}` : `Cache built ${exact}`)
    : `Last fetch ${exact}`;
}

function loadPanelState() {
  const saved = localStorage.getItem('situationRoomPanels');
  if (saved) {
    const parsed = JSON.parse(saved);
    if (parsed.version === LAYOUT_VERSION) {
      state.panels.order = Array.isArray(parsed.order) ? parsed.order : [];
      state.panels.visibility = parsed.visibility && typeof parsed.visibility === 'object' ? parsed.visibility : {};
      state.panels.sizes = parsed.sizes && typeof parsed.sizes === 'object' ? parsed.sizes : {};
    } else {
      state.panels.order = [];
      state.panels.visibility = {};
      state.panels.sizes = {};
    }
  }
}

function savePanelState() {
  localStorage.setItem('situationRoomPanels', JSON.stringify({
    order: state.panels.order,
    visibility: state.panels.visibility,
    sizes: state.panels.sizes,
    version: LAYOUT_VERSION
  }));
}

function getPanelRegistry() {
  return [...document.querySelectorAll('.panel[data-panel]')].map((panel) => ({
    id: panel.dataset.panel,
    title: panel.querySelector('.panel-title')?.textContent || panel.dataset.panel,
    element: panel
  }));
}

function applyPanelVisibility() {
  getPanelRegistry().forEach((panel) => {
    const visible = state.panels.visibility[panel.id] !== false;
    panel.element.classList.toggle('panel-hidden', !visible);
  });
}

function applyPanelOrder() {
  if (!state.panels.order.length) return;
  const registry = getPanelRegistry();
  const map = new Map(registry.map((panel) => [panel.id, panel.element]));
  state.panels.order.forEach((id) => {
    const el = map.get(id);
    if (el) elements.panelGrid.appendChild(el);
  });
  registry.forEach((panel) => {
    if (!state.panels.order.includes(panel.id)) {
      elements.panelGrid.appendChild(panel.element);
    }
  });
}

function applyPanelSizes() {
  getPanelRegistry().forEach((panel) => {
    const size = state.panels.sizes[panel.id] || defaultPanelSizes[panel.id];
    if (!size) {
      panel.element.style.gridColumnEnd = '';
      panel.element.style.height = '';
      return;
    }
    if (size.cols) {
      panel.element.style.gridColumnEnd = `span ${size.cols}`;
    } else {
      panel.element.style.gridColumnEnd = '';
    }
    if (size.height) {
      panel.element.style.height = `${size.height}px`;
    } else if (!state.panels.sizes[panel.id]?.height) {
      panel.element.style.height = '';
    }
  });
}

function buildPanelToggles() {
  const registry = getPanelRegistry();
  elements.panelToggles.innerHTML = '';
  registry.forEach((panel) => {
    const row = document.createElement('div');
    row.className = 'panel-toggle';
    const label = document.createElement('label');
    const safeId = `panel-toggle-${String(panel.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    label.className = 'panel-toggle-label';
    label.setAttribute('for', safeId);
    label.textContent = panel.title;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = safeId;
    checkbox.name = safeId;
    checkbox.checked = state.panels.visibility[panel.id] !== false;
    checkbox.addEventListener('change', () => {
      state.panels.visibility[panel.id] = checkbox.checked;
      savePanelState();
      applyPanelVisibility();
    });
    row.appendChild(label);
    row.appendChild(checkbox);
    elements.panelToggles.appendChild(row);
  });
}

function updatePanelOrderFromDOM() {
  state.panels.order = [...document.querySelectorAll('.panel[data-panel]')].map((panel) => panel.dataset.panel);
  savePanelState();
}

function initPanelDrag() {
  let draggedId = null;
  getPanelRegistry().forEach((panel) => {
    panel.element.setAttribute('draggable', 'true');
    panel.element.addEventListener('dragstart', (event) => {
      draggedId = panel.id;
      panel.element.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    panel.element.addEventListener('dragend', () => {
      panel.element.classList.remove('dragging');
      document.querySelectorAll('.panel.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    panel.element.addEventListener('dragover', (event) => {
      event.preventDefault();
      panel.element.classList.add('drag-over');
    });
    panel.element.addEventListener('dragleave', () => {
      panel.element.classList.remove('drag-over');
    });
    panel.element.addEventListener('drop', (event) => {
      event.preventDefault();
      panel.element.classList.remove('drag-over');
      const dragged = document.querySelector(`.panel[data-panel=\"${draggedId}\"]`);
      if (!dragged || dragged === panel.element) return;
      const rect = panel.element.getBoundingClientRect();
      const insertBefore = event.clientY < rect.top + rect.height / 2;
      elements.panelGrid.insertBefore(dragged, insertBefore ? panel.element : panel.element.nextSibling);
      updatePanelOrderFromDOM();
    });
  });
}

function initPanelResize() {
  const grid = elements.panelGrid;
  if (!grid) return;
  const gridStyle = window.getComputedStyle(grid);
  const gapValue = parseFloat(gridStyle.columnGap || gridStyle.gap || '0');

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const getColumnWidth = () => {
    const gridRect = grid.getBoundingClientRect();
    return (gridRect.width - gapValue * 11) / 12;
  };

  const startResize = (panel, mode, event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.element.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;
    const startX = event.clientX;
    const startY = event.clientY;
    const computed = window.getComputedStyle(panel.element);
    const colEnd = computed.gridColumnEnd || 'span 12';
    const match = colEnd.match(/span\s+(\d+)/);
    const startCols = match ? Number(match[1]) : Math.round(startWidth / (getColumnWidth() + gapValue));
    const originalDraggable = panel.element.getAttribute('draggable');
    panel.element.setAttribute('draggable', 'false');

    const onMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (mode !== 'y') {
        const columnWidth = getColumnWidth();
        const newWidth = startWidth + deltaX;
        const newCols = clamp(Math.round((newWidth + gapValue) / (columnWidth + gapValue)), 2, 12);
        panel.element.style.gridColumnEnd = `span ${newCols}`;
        state.panels.sizes[panel.id] = {
          ...state.panels.sizes[panel.id],
          cols: newCols,
          height: state.panels.sizes[panel.id]?.height || Math.round(startHeight)
        };
      }
      if (mode !== 'x') {
        const newHeight = Math.max(180, startHeight + deltaY);
        panel.element.style.height = `${newHeight}px`;
        state.panels.sizes[panel.id] = {
          ...state.panels.sizes[panel.id],
          cols: state.panels.sizes[panel.id]?.cols || startCols,
          height: Math.round(newHeight)
        };
      }
      savePanelState();
    };

  const onUp = () => {
    if (originalDraggable !== null) {
      panel.element.setAttribute('draggable', originalDraggable);
    } else {
      panel.element.removeAttribute('draggable');
    }
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (state.map) {
      setTimeout(() => state.map.invalidateSize(), 120);
    }
    if (state.energyMap) {
      setTimeout(() => state.energyMap.invalidateSize(), 120);
    }
  };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  getPanelRegistry().forEach((panel) => {
    if (panel.element.querySelector('.panel-resize-handle')) return;
    const handle = document.createElement('div');
    handle.className = 'panel-resize-handle';
    panel.element.appendChild(handle);
    handle.addEventListener('mousedown', (event) => startResize(panel, 'both', event));

    const handleX = document.createElement('div');
    handleX.className = 'panel-resize-handle-x';
    panel.element.appendChild(handleX);
    handleX.addEventListener('mousedown', (event) => startResize(panel, 'x', event));

    const handleY = document.createElement('div');
    handleY.className = 'panel-resize-handle-y';
    panel.element.appendChild(handleY);
    handleY.addEventListener('mousedown', (event) => startResize(panel, 'y', event));
  });
}

function resetLayout() {
  state.panels.order = [...state.panels.defaultOrder];
  state.panels.visibility = {};
  state.panels.sizes = {};
  savePanelState();
  applyPanelOrder();
  applyPanelVisibility();
  applyPanelSizes();
  buildPanelToggles();
}

function applyTheme(mode) {
  state.settings.theme = mode;
  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  elements.app.dataset.theme = resolved;
  document.documentElement.dataset.theme = resolved;
  document.body.dataset.theme = resolved;
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.dataset.theme = resolved;
  });
  renderEnergyMap();
}

function updateThemeButtons() {
  [...elements.themeToggle.querySelectorAll('.seg')].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === state.settings.theme);
  });
}

function updateAgeButtons() {
  if (!elements.ageToggle) return;
  [...elements.ageToggle.querySelectorAll('.seg')].forEach((btn) => {
    const age = Number(btn.dataset.age);
    btn.classList.toggle('active', age === state.settings.maxAgeDays);
  });
}

function updateLanguageButtons() {
  if (!elements.languageToggle) return;
  [...elements.languageToggle.querySelectorAll('.seg')].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.language === state.settings.languageMode);
  });
}

function updateScopeButtons() {
  [...elements.scopeToggle.querySelectorAll('.seg')].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scope === state.settings.scope);
  });
}

function updateSettingsUI() {
  elements.refreshValue.textContent = `${state.settings.refreshMinutes} min`;
  elements.refreshRange.value = state.settings.refreshMinutes;
  elements.refreshRangeValue.textContent = state.settings.refreshMinutes;
  if (elements.maxAgeRange) {
    elements.maxAgeRange.value = state.settings.maxAgeDays;
    elements.maxAgeValue.textContent = `${state.settings.maxAgeDays} days`;
  }
  elements.radiusRange.value = state.settings.radiusKm;
  elements.radiusRangeValue.textContent = state.settings.radiusKm;
  elements.geoValue.textContent = state.location.source === 'geo' ? 'Geolocated' : 'Fallback (Asheville)';
  if (elements.aiTranslateToggle) {
    elements.aiTranslateToggle.checked = state.settings.aiTranslate;
  }
  if (elements.superMonitorToggle) {
    elements.superMonitorToggle.checked = state.settings.superMonitor;
  }
  if (elements.statusCompact) {
    elements.statusCompact.classList.toggle('collapsed', !state.settings.showStatus);
  }
  if (elements.statusToggle) {
    elements.statusToggle.textContent = state.settings.showStatus ? 'Hide' : 'Show';
  }
  if (elements.keySection) {
    elements.keySection.classList.toggle('collapsed', !state.settings.showKeys);
  }
  if (elements.keyToggle) {
    elements.keyToggle.textContent = state.settings.showKeys ? 'Hide' : 'Show';
  }
  if (elements.travelTickerBtn) {
    elements.travelTickerBtn.classList.toggle('active', state.settings.showTravelTicker);
    elements.travelTickerBtn.textContent = state.settings.showTravelTicker ? 'Travel Ticker' : 'Travel Ticker Off';
  }
  if (elements.travelTicker) {
    elements.travelTicker.classList.toggle('hidden', !state.settings.showTravelTicker);
  }
  updateThemeButtons();
  updateScopeButtons();
  updateAgeButtons();
  updateLanguageButtons();
  updateMapLegendUI();
  updateMapDateUI();
  if (elements.liveSearchToggle) {
    elements.liveSearchToggle.classList.toggle('active', state.settings.liveSearch);
    elements.liveSearchToggle.textContent = state.settings.liveSearch ? 'Live Search On' : 'Live Search Off';
  }
}

function toggleSettings(open) {
  elements.settingsPanel.classList.toggle('open', open);
}

function toggleAbout(open) {
  if (!elements.aboutOverlay) return;
  elements.aboutOverlay.classList.toggle('open', open);
  elements.aboutOverlay.setAttribute('aria-hidden', open ? 'false' : 'true');
  elements.aboutOverlay.inert = !open;
}

function toggleListModal(open) {
  if (!elements.listOverlay) return;
  elements.listOverlay.classList.toggle('open', open);
  elements.listOverlay.setAttribute('aria-hidden', open ? 'false' : 'true');
  elements.listOverlay.inert = !open;
  if (!open && elements.listModalList) {
    elements.listModalList.innerHTML = '';
    elements.listModalList.dataset.listContext = '';
  }
}

function setNavOpen(open) {
  if (!elements.app) return;
  elements.app.classList.toggle('nav-open', open);
  if (elements.navToggle) {
    elements.navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

function setHealth(text) {
  state.health = text;
  elements.healthValue.textContent = text;
  if (elements.statusText) {
    elements.statusText.textContent = text === 'Healthy' ? 'Live' : text;
  }
}

function setRefreshing(isRefreshing) {
  if (!elements.refreshNow) return;
  elements.refreshNow.disabled = isRefreshing;
  elements.refreshNow.textContent = isRefreshing ? 'Refreshing...' : 'Refresh Now';
}

function buildFeedOptions() {
  elements.feedScope.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = 'All Sources';
  elements.feedScope.appendChild(all);

  const categories = Array.from(new Set(state.feeds.map((feed) => feed.category).filter(Boolean)));
  const sortedCategories = [
    ...categoryOrder.filter((cat) => categories.includes(cat)),
    ...categories.filter((cat) => !categoryOrder.includes(cat))
  ];

  if (elements.categoryFilters) {
    elements.categoryFilters.innerHTML = '';
    sortedCategories.forEach((category) => {
      const chip = document.createElement('button');
      chip.className = 'chip chip-toggle';
      chip.type = 'button';
      chip.dataset.category = category;
      chip.textContent = categoryLabels[category] || category;
      chip.addEventListener('click', () => {
        const selected = state.searchCategories.includes(category);
        if (selected) {
          state.searchCategories = state.searchCategories.filter((entry) => entry !== category);
        } else {
          state.searchCategories = [...state.searchCategories, category];
        }
        updateCategoryFilters();
      });
      elements.categoryFilters.appendChild(chip);
    });
  }

  const categoryGroup = document.createElement('optgroup');
  categoryGroup.label = 'Categories';
  sortedCategories.forEach((category) => {
    const option = document.createElement('option');
    option.value = `cat:${category}`;
    option.textContent = `All ${categoryLabels[category] || category}`;
    categoryGroup.appendChild(option);
  });
  elements.feedScope.appendChild(categoryGroup);

  sortedCategories.forEach((category) => {
    const group = document.createElement('optgroup');
    group.label = `${categoryLabels[category] || category} Feeds`;
    state.feeds
      .filter((feed) => feed.category === category)
      .forEach((feed) => {
        const option = document.createElement('option');
        option.value = feed.id;
        option.textContent = feed.name;
        group.appendChild(option);
      });
    elements.feedScope.appendChild(group);
  });

  updateCategoryFilters();
}

function updateCategoryFilters() {
  if (!elements.categoryFilters) return;
  const selected = new Set(state.searchCategories);
  [...elements.categoryFilters.querySelectorAll('.chip-toggle')].forEach((chip) => {
    chip.classList.toggle('active', selected.has(chip.dataset.category));
  });
  if (selected.size) {
    elements.feedScope.value = 'all';
  }
}

function populateCustomFeedCategories() {
  if (!elements.customFeedCategory) return;
  elements.customFeedCategory.innerHTML = '';
  categoryOrder.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = categoryLabels[category] || category;
    elements.customFeedCategory.appendChild(option);
  });
}

function toggleCustomFeedForm(open) {
  if (!elements.customFeedForm) return;
  elements.customFeedForm.classList.toggle('hidden', !open);
  elements.customFeedForm.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (!open) {
    editingCustomFeedId = null;
  }
}

function toggleCustomFeedJsonPanel(open) {
  if (!elements.customFeedJsonPanel) return;
  elements.customFeedJsonPanel.classList.toggle('hidden', !open);
  elements.customFeedJsonPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function sanitizeCustomFeedObject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const url = String(raw.url || '').trim();
  if (!name || !url || !/^https?:\/\//i.test(url)) return null;
  const category = raw.category || 'news';
  const format = raw.format || 'rss';
  const proxy = raw.proxy || '';
  const tags = Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [];
  const supportsQuery = Boolean(raw.supportsQuery);
  const defaultQuery = supportsQuery ? String(raw.defaultQuery || '') : '';
  const requiresKey = Boolean(raw.requiresKey);
  const keyParam = requiresKey ? String(raw.keyParam || 'api_key') : undefined;
  const keyHeader = requiresKey ? String(raw.keyHeader || '') : undefined;
  const ttlMinutes = Number.isFinite(Number(raw.ttlMinutes)) ? Number(raw.ttlMinutes) : 60;
  const id = raw.id || hashString(`${name}:${url}`);
  return {
    id,
    name,
    url,
    category,
    format,
    proxy: proxy || undefined,
    tags,
    supportsQuery,
    defaultQuery,
    requiresKey,
    keyParam,
    keyHeader,
    ttlMinutes,
    isCustom: true,
    keySource: 'client'
  };
}

function exportCustomFeedsJson() {
  if (!elements.customFeedJson) return;
  const payload = state.customFeeds.map((feed) => ({
    id: feed.id,
    name: feed.name,
    url: feed.url,
    category: feed.category,
    format: feed.format,
    proxy: feed.proxy,
    tags: feed.tags,
    supportsQuery: feed.supportsQuery,
    defaultQuery: feed.defaultQuery,
    requiresKey: feed.requiresKey,
    keyParam: feed.keyParam,
    keyHeader: feed.keyHeader,
    ttlMinutes: feed.ttlMinutes
  }));
  elements.customFeedJson.value = JSON.stringify(payload, null, 2);
  toggleCustomFeedJsonPanel(true);
  if (elements.customFeedJsonStatus) {
    elements.customFeedJsonStatus.textContent = payload.length ? 'Exported feeds to JSON.' : 'No custom feeds to export.';
  }
}

function getCustomFeedsExportString() {
  const payload = state.customFeeds.map((feed) => ({
    id: feed.id,
    name: feed.name,
    url: feed.url,
    category: feed.category,
    format: feed.format,
    proxy: feed.proxy,
    tags: feed.tags,
    supportsQuery: feed.supportsQuery,
    defaultQuery: feed.defaultQuery,
    requiresKey: feed.requiresKey,
    keyParam: feed.keyParam,
    keyHeader: feed.keyHeader,
    ttlMinutes: feed.ttlMinutes
  }));
  return JSON.stringify(payload, null, 2);
}

function applyCustomFeedsJson() {
  if (!elements.customFeedJson) return;
  const raw = elements.customFeedJson.value.trim();
  if (!raw) {
    if (elements.customFeedJsonStatus) elements.customFeedJsonStatus.textContent = 'Paste JSON to import feeds.';
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (elements.customFeedJsonStatus) elements.customFeedJsonStatus.textContent = 'Invalid JSON. Please check the format.';
    return;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.feeds) ? parsed.feeds : [];
  if (!list.length) {
    if (elements.customFeedJsonStatus) elements.customFeedJsonStatus.textContent = 'No feeds found in the JSON payload.';
    return;
  }
  const sanitized = list.map(sanitizeCustomFeedObject).filter(Boolean);
  if (!sanitized.length) {
    if (elements.customFeedJsonStatus) elements.customFeedJsonStatus.textContent = 'No valid feeds found. Check name and URL fields.';
    return;
  }
  const byId = new Map(state.customFeeds.map((feed) => [feed.id, feed]));
  sanitized.forEach((feed) => {
    byId.set(feed.id, feed);
  });
  state.customFeeds = Array.from(byId.values());
  saveCustomFeeds();
  state.feeds = mergeCustomFeeds(state.baseFeeds, state.customFeeds);
  buildCustomFeedList();
  buildFeedOptions();
  buildKeyManager();
  refreshAll(true);
  if (elements.customFeedJsonStatus) elements.customFeedJsonStatus.textContent = `Imported ${sanitized.length} feed${sanitized.length === 1 ? '' : 's'}.`;
}

function resetCustomFeedForm(feed) {
  if (!elements.customFeedForm) return;
  const data = feed || {};
  elements.customFeedName.value = data.name || '';
  elements.customFeedUrl.value = data.url || '';
  elements.customFeedCategory.value = data.category || 'news';
  elements.customFeedFormat.value = data.format || 'rss';
  elements.customFeedProxy.value = data.proxy || '';
  elements.customFeedTags.value = Array.isArray(data.tags) ? data.tags.join(', ') : '';
  elements.customFeedSupportsQuery.checked = Boolean(data.supportsQuery);
  elements.customFeedDefaultQuery.value = data.defaultQuery || '';
  elements.customFeedRequiresKey.checked = Boolean(data.requiresKey);
  elements.customFeedKeyParam.value = data.keyParam || 'api_key';
  elements.customFeedKeyHeader.value = data.keyHeader || '';
  elements.customFeedTtl.value = data.ttlMinutes ? String(data.ttlMinutes) : '';
  if (elements.customFeedRequiresKey) {
    const enabled = elements.customFeedRequiresKey.checked;
    elements.customFeedKeyParam.disabled = !enabled;
    elements.customFeedKeyHeader.disabled = !enabled;
  }
  if (elements.customFeedSupportsQuery) {
    elements.customFeedDefaultQuery.disabled = !elements.customFeedSupportsQuery.checked;
  }
  if (elements.customFeedStatus) {
    elements.customFeedStatus.textContent = feed ? 'Editing custom feed.' : 'Custom feeds are stored in this browser only.';
  }
}

function buildCustomFeedList() {
  if (!elements.customFeedList) return;
  elements.customFeedList.innerHTML = '';
  if (!state.customFeeds.length) {
    elements.customFeedList.innerHTML = '<div class="settings-note">No custom feeds yet.</div>';
    return;
  }
  state.customFeeds.forEach((feed) => {
    const row = document.createElement('div');
    row.className = 'custom-feed-row';
    const info = document.createElement('div');
    info.className = 'custom-feed-info';
    const name = document.createElement('div');
    name.className = 'custom-feed-name';
    name.textContent = feed.name || feed.url;
    const meta = document.createElement('div');
    meta.className = 'custom-feed-meta';
    const tags = Array.isArray(feed.tags) && feed.tags.length ? `• ${feed.tags.join(', ')}` : '';
    meta.textContent = `${feed.category || 'news'} • ${feed.format || 'rss'} ${tags}`.trim();
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'custom-feed-actions';
    const edit = document.createElement('button');
    edit.className = 'chip';
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      editingCustomFeedId = feed.id;
      resetCustomFeedForm(feed);
      toggleCustomFeedForm(true);
    });
    const remove = document.createElement('button');
    remove.className = 'chip';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      state.customFeeds = state.customFeeds.filter((entry) => entry.id !== feed.id);
      saveCustomFeeds();
      state.feeds = mergeCustomFeeds(state.baseFeeds, state.customFeeds);
      buildCustomFeedList();
      buildFeedOptions();
      buildKeyManager();
      refreshAll(true);
    });
    actions.appendChild(edit);
    actions.appendChild(remove);

    row.appendChild(info);
    row.appendChild(actions);
    elements.customFeedList.appendChild(row);
  });
}

function collectCustomFeedForm() {
  const name = elements.customFeedName.value.trim();
  const url = elements.customFeedUrl.value.trim();
  const category = elements.customFeedCategory.value;
  const format = elements.customFeedFormat.value;
  const proxy = elements.customFeedProxy.value || '';
  const tags = elements.customFeedTags.value.split(',').map((tag) => tag.trim()).filter(Boolean);
  const supportsQuery = elements.customFeedSupportsQuery.checked;
  const defaultQuery = elements.customFeedDefaultQuery.value.trim();
  const requiresKey = elements.customFeedRequiresKey.checked;
  const keyParam = elements.customFeedKeyParam.value.trim() || 'api_key';
  const keyHeader = elements.customFeedKeyHeader.value.trim();
  const ttlMinutes = Number(elements.customFeedTtl.value || 60);

  if (!name || !url) {
    return { error: 'Name and URL are required.' };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { error: 'URL must start with http:// or https://.' };
  }
  const feed = {
    id: editingCustomFeedId,
    name,
    url,
    category,
    format,
    proxy: proxy || undefined,
    tags,
    supportsQuery,
    defaultQuery: supportsQuery ? defaultQuery : '',
    requiresKey,
    keyParam: requiresKey ? keyParam : undefined,
    keyHeader: requiresKey ? keyHeader : undefined,
    ttlMinutes: Number.isFinite(ttlMinutes) ? ttlMinutes : 60,
    isCustom: true,
    keySource: 'client'
  };
  return { feed };
}

function updateMapLegendUI() {
  if (!elements.mapLegend) return;
  elements.mapLegend.querySelectorAll('input[data-layer]').forEach((input) => {
    const layer = input.dataset.layer;
    input.checked = Boolean(state.settings.mapLayers[layer]);
  });
  elements.mapLegend.querySelectorAll('input[data-basemap]').forEach((input) => {
    const basemap = input.dataset.basemap;
    input.checked = basemap === state.settings.mapBasemap;
  });
  elements.mapLegend.querySelectorAll('input[data-overlay]').forEach((input) => {
    const overlay = input.dataset.overlay;
    input.checked = Boolean(state.settings.mapRasterOverlays?.[overlay]);
  });
}

function updateMapDateUI() {
  const imageryDate = state.settings.mapImageryDate || state.imageryDate;
  const sarDate = state.settings.mapSarDate || state.sarDate;
  const maxDate = getRecentIsoDate(0);
  const minDate = '2014-10-01';
  if (elements.imageryDateInput && imageryDate) {
    elements.imageryDateInput.min = minDate;
    elements.imageryDateInput.max = maxDate;
    elements.imageryDateInput.value = imageryDate;
  }
  if (elements.sarDateInput && sarDate) {
    elements.sarDateInput.min = minDate;
    elements.sarDateInput.max = maxDate;
    elements.sarDateInput.value = sarDate;
  }
  if (elements.imageryDatePanel && imageryDate) {
    elements.imageryDatePanel.min = minDate;
    elements.imageryDatePanel.max = maxDate;
    elements.imageryDatePanel.value = imageryDate;
  }
  if (elements.sarDatePanel && sarDate) {
    elements.sarDatePanel.min = minDate;
    elements.sarDatePanel.max = maxDate;
    elements.sarDatePanel.value = sarDate;
  }
  updateImageryPanelUI();
}

function getOverlayOpacity(key, fallback = 0.5) {
  const value = state.settings.mapOverlayOpacity?.[key];
  return Number.isFinite(value) ? value : fallback;
}

function updateImageryPanelUI() {
  document.querySelectorAll('[data-imagery-basemap]').forEach((button) => {
    const basemap = button.dataset.imageryBasemap;
    button.classList.toggle('active', basemap === state.settings.mapBasemap);
  });
  document.querySelectorAll('[data-imagery-overlay]').forEach((button) => {
    const overlay = button.dataset.imageryOverlay;
    button.classList.toggle('active', Boolean(state.settings.mapRasterOverlays?.[overlay]));
  });
  document.querySelectorAll('[data-overlay-opacity]').forEach((input) => {
    const overlay = input.dataset.overlayOpacity;
    const value = Math.round(getOverlayOpacity(overlay, 0.5) * 100);
    input.value = value;
    const label = document.querySelector(`[data-overlay-opacity-value="${overlay}"]`);
    if (label) label.textContent = `${value}%`;
  });
}

function isServerManagedKey(feed) {
  return feed?.keySource === 'server';
}

function getKeyFeeds() {
  const keyFeeds = state.feeds
    .filter((feed) => !isServerManagedKey(feed))
    .filter((feed) => feed.requiresKey || feed.keyParam || feed.keyHeader || (feed.tags || []).includes('key'))
    .map((feed) => ({ ...feed, docsUrl: feed.docsUrl || docsMap[feed.id] }));
  if (!keyFeeds.find((feed) => feed.id === 'openai')) {
    keyFeeds.unshift({
      id: 'openai',
      name: 'OpenAI Assistant',
      category: 'assistant',
      requiresKey: true,
      docsUrl: docsMap.openai
    });
  }
  return keyFeeds;
}

function getKeyConfig(feed) {
  if (isServerManagedKey(feed)) {
    return { key: '', keyParam: '', keyHeader: '', groupId: feed.keyGroup || null, fromGroup: false, serverManaged: true };
  }
  const localConfig = state.keys[feed.id] || {};
  const groupId = feed.keyGroup;
  const groupConfig = groupId ? state.keyGroups[groupId] || {} : {};
  const key = groupConfig.key || localConfig.key;
  const keyParam = feed.lockKeyParam ? feed.keyParam : (localConfig.keyParam || feed.keyParam);
  const keyHeader = feed.lockKeyHeader ? feed.keyHeader : (localConfig.keyHeader || feed.keyHeader);
  return { key, keyParam, keyHeader, groupId, fromGroup: Boolean(groupConfig.key) };
}

function buildKeyManager(filterCategory) {
  state.keyFilter = filterCategory || state.keyFilter;
  const keyFeeds = getKeyFeeds();
  const filter = state.keyFilter;
  const filterList = filter ? (panelKeyFilters[filter] || [filter]) : null;
  let displayFeeds = filterList ? keyFeeds.filter((feed) => filterList.includes(feed.category)) : keyFeeds;
  if (filter && !displayFeeds.length) {
    displayFeeds = keyFeeds;
  }
  const toSafeId = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');

  elements.keyManager.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'key-manager-header';
  const title = document.createElement('div');
  title.textContent = filter ? `API Keys - ${filter.toUpperCase()}` : 'API Keys';
  const actions = document.createElement('div');
  actions.className = 'key-manager-actions';
  if (filter) {
    const reset = document.createElement('button');
    reset.className = 'chip';
    reset.textContent = 'Show All';
    reset.addEventListener('click', () => {
      state.keyFilter = null;
      buildKeyManager();
    });
    actions.appendChild(reset);
  }
  header.appendChild(title);
  header.appendChild(actions);
  elements.keyManager.appendChild(header);

  if (isStaticMode()) {
    const note = document.createElement('div');
    note.className = 'settings-note';
    note.textContent = state.settings.superMonitor
      ? 'Super Monitor Mode is active. Live fetches run for keyless feeds, plus custom feeds with browser keys. OpenAI requires a proxy on GitHub Pages.'
      : 'Static mode is active. Feeds load from the published cache. Optional: enable Super Monitor Mode to pull live keyless feeds (proxy required for OpenAI).';
    elements.keyManager.appendChild(note);
    if (!state.settings.superMonitor) {
      displayFeeds = displayFeeds.filter((feed) => feed.id === 'openai');
    }
  }

  const serverManaged = state.feeds.filter((feed) => isServerManagedKey(feed));
  if (serverManaged.length) {
    const note = document.createElement('div');
    note.className = 'settings-note';
    note.textContent = 'Server-managed keys: DATA_GOV, EIA, NASA_FIRMS, OPEN_AQ. Configure in the proxy.';
    elements.keyManager.appendChild(note);
  }

  const groupIds = [...new Set(displayFeeds.map((feed) => feed.keyGroup).filter(Boolean))];
  if (groupIds.length) {
    const section = document.createElement('div');
    section.className = 'key-group-section';
    const groupTitle = document.createElement('div');
    groupTitle.className = 'key-group-title';
    groupTitle.textContent = 'Shared Keys';
    section.appendChild(groupTitle);

    groupIds.forEach((groupId) => {
      const groupRow = document.createElement('div');
      groupRow.className = 'key-row key-group-row';
      const head = document.createElement('div');
      head.className = 'key-row-head';
      const name = document.createElement('div');
      name.className = 'list-title';
      name.textContent = keyGroupLabels[groupId] || groupId;
      const meta = document.createElement('div');
      meta.className = 'key-group-meta';
      const groupFeeds = displayFeeds.filter((feed) => feed.keyGroup === groupId);
      const groupFeedNames = groupFeeds.map((feed) => feed.name);
      const groupFeedIds = groupFeeds.map((feed) => feed.id);
      meta.textContent = `Applies to: ${groupFeedNames.join(', ')}`;
      head.appendChild(name);
      head.appendChild(meta);

      const keyLabel = document.createElement('label');
      keyLabel.textContent = 'API Key';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.id = `key-group-${toSafeId(groupId)}`;
      keyInput.name = keyInput.id;
      keyLabel.setAttribute('for', keyInput.id);
      keyInput.placeholder = 'Paste shared key';
      keyInput.value = state.keyGroups[groupId]?.key || '';
      keyInput.addEventListener('input', () => {
        const trimmed = keyInput.value.trim();
        state.keyGroups[groupId] = { ...(state.keyGroups[groupId] || {}), key: trimmed };
        groupFeedIds.forEach((feedId) => {
          state.keyStatus[feedId] = 'untested';
        });
        saveKeyGroups();
        saveKeyStatus();
        state.energyMapData = null;
        state.energyMapFetchedAt = 0;
        renderEnergyNews();
        renderEnergyMap();
        document.querySelectorAll(`.key-row[data-feed]`).forEach((row) => {
          const feedId = row.dataset.feed;
          const feed = displayFeeds.find((candidate) => candidate.id === feedId);
          if (feed?.keyGroup === groupId) {
            const input = row.querySelector('input[type="password"], input[type="text"]');
            if (input) input.value = keyInput.value;
            const status = row.querySelector('.key-status');
            if (status) {
              status.className = 'key-status untested';
              status.textContent = 'untested';
            }
          }
        });
      });

      const showToggle = document.createElement('button');
      showToggle.className = 'chip';
      showToggle.textContent = 'Show';
      showToggle.addEventListener('click', () => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
        showToggle.textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
      });

      const inputRow = document.createElement('div');
      inputRow.className = 'key-row-input';
      inputRow.appendChild(keyInput);
      inputRow.appendChild(showToggle);

      groupRow.appendChild(head);
      groupRow.appendChild(keyLabel);
      groupRow.appendChild(inputRow);
      section.appendChild(groupRow);
    });

    elements.keyManager.appendChild(section);
  }

  if (!displayFeeds.length) {
    elements.keyManager.innerHTML += '<div class="settings-note">No feeds require keys yet.</div>';
    return;
  }

  displayFeeds.forEach((feed) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    row.dataset.feed = feed.id;

    const head = document.createElement('div');
    head.className = 'key-row-head';
    const name = document.createElement('div');
    name.textContent = feed.name;
    name.className = 'list-title';

    const status = document.createElement('span');
    const statusValue = state.keyStatus[feed.id] || 'untested';
    status.className = `key-status ${statusValue}`;
    status.textContent = statusValue;

    const headActions = document.createElement('div');
    headActions.className = 'key-row-actions';
    const testBtn = document.createElement('button');
    testBtn.className = 'chip';
    testBtn.textContent = 'Test';
    testBtn.addEventListener('click', () => testFeedKey(feed, status));
    headActions.appendChild(testBtn);

    if (feed.docsUrl) {
      const link = document.createElement('a');
      link.className = 'chip';
      link.href = feed.docsUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Docs';
      headActions.appendChild(link);
    }

    head.appendChild(name);
    head.appendChild(status);
    head.appendChild(headActions);

    const keyLabel = document.createElement('label');
    keyLabel.textContent = 'API Key';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.id = `key-${toSafeId(feed.id)}`;
    keyInput.name = keyInput.id;
    keyLabel.setAttribute('for', keyInput.id);
    const keyConfig = getKeyConfig(feed);
    const groupLabel = feed.keyGroup ? (keyGroupLabels[feed.keyGroup] || feed.keyGroup) : null;
    keyInput.placeholder = feed.keyGroup ? 'Set in Shared Keys' : 'Paste key';
    keyInput.value = keyConfig.key || '';
    keyInput.disabled = Boolean(feed.keyGroup);
    if (!feed.keyGroup) {
      keyInput.addEventListener('input', () => {
        const trimmed = keyInput.value.trim();
        state.keys[feed.id] = { ...(state.keys[feed.id] || {}), key: trimmed };
        state.keyStatus[feed.id] = 'untested';
        saveKeys();
        saveKeyStatus();
        status.className = 'key-status untested';
        status.textContent = 'untested';
        if (feed.id === 'openai') updateChatStatus();
        state.energyMapData = null;
        state.energyMapFetchedAt = 0;
        renderEnergyNews();
        renderEnergyMap();
      });
    }

    const showToggle = document.createElement('button');
    showToggle.className = 'chip';
    showToggle.textContent = 'Show';
    showToggle.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      showToggle.textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
    });

    const inputRow = document.createElement('div');
    inputRow.className = 'key-row-input';
    inputRow.appendChild(keyInput);
    inputRow.appendChild(showToggle);

    row.appendChild(head);
    row.appendChild(keyLabel);
    row.appendChild(inputRow);

    if (feed.id !== 'openai') {
      const paramLabel = document.createElement('label');
      paramLabel.textContent = 'Key Param (query string)';
      const paramInput = document.createElement('input');
      paramInput.id = `key-param-${toSafeId(feed.id)}`;
      paramInput.name = paramInput.id;
      paramLabel.setAttribute('for', paramInput.id);
      paramInput.placeholder = feed.keyParam || 'api_key';
      paramInput.value = feed.lockKeyParam ? (feed.keyParam || '') : (state.keys[feed.id]?.keyParam || feed.keyParam || '');
      if (feed.lockKeyParam) {
        paramInput.disabled = true;
      } else {
        paramInput.addEventListener('input', () => {
          state.keys[feed.id] = { ...(state.keys[feed.id] || {}), keyParam: paramInput.value };
          saveKeys();
        });
      }

      const headerLabel = document.createElement('label');
      headerLabel.textContent = 'Key Header (optional)';
      const headerInput = document.createElement('input');
      headerInput.id = `key-header-${toSafeId(feed.id)}`;
      headerInput.name = headerInput.id;
      headerLabel.setAttribute('for', headerInput.id);
      headerInput.placeholder = feed.keyHeader || 'X-API-Key';
      headerInput.value = feed.lockKeyHeader ? (feed.keyHeader || '') : (state.keys[feed.id]?.keyHeader || feed.keyHeader || '');
      if (feed.lockKeyHeader) {
        headerInput.disabled = true;
      } else {
        headerInput.addEventListener('input', () => {
          state.keys[feed.id] = { ...(state.keys[feed.id] || {}), keyHeader: headerInput.value };
          saveKeys();
        });
      }

      row.appendChild(paramLabel);
      row.appendChild(paramInput);
      row.appendChild(headerLabel);
      row.appendChild(headerInput);
      if (feed.keyGroup) {
        const helper = document.createElement('div');
        helper.className = 'settings-note';
        helper.textContent = `Uses shared key: ${groupLabel}`;
        row.appendChild(helper);
      }
      if (feed.lockKeyParam || feed.lockKeyHeader) {
        const helper = document.createElement('div');
        helper.className = 'settings-note';
        helper.textContent = 'Key parameters are fixed for this API.';
        row.appendChild(helper);
      }
    } else {
      const helper = document.createElement('div');
      helper.className = 'settings-note';
      helper.textContent = 'Used for chat, AI briefings, and query translation.';
      row.appendChild(helper);
    }

    elements.keyManager.appendChild(row);
  });
}

function setKeyStatus(feedId, status, statusEl, message) {
  state.keyStatus[feedId] = status;
  saveKeyStatus();
  if (statusEl) {
    statusEl.className = `key-status ${status}`;
    statusEl.textContent = status;
    if (message) {
      statusEl.title = message;
    } else {
      statusEl.removeAttribute('title');
    }
  }
}

function deriveKeyStatus(payload) {
  if (!payload) return 'error';
  if (payload.error === 'requires_key') return 'missing';
  if (payload.httpStatus >= 200 && payload.httpStatus < 300) return 'ok';
  if (payload.httpStatus === 401 || payload.httpStatus === 403) return 'invalid';
  if (payload.httpStatus === 429) return 'rate_limited';
  return 'error';
}

function normalizeOpenAIError(err) {
  const message = (err?.message || '').toString();
  const lower = message.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('cors')) {
    return {
      status: 'error',
      message: 'Browser blocked the request (CORS). Key saved; use a proxy for live chat.'
    };
  }
  if ((lower.includes('invalid') || lower.includes('unauthorized') || lower.includes('401')) && !isStaticMode()) {
    return { status: 'invalid', message: message || 'Invalid API key' };
  }
  if (lower.includes('invalid') || lower.includes('unauthorized') || lower.includes('401')) {
    return { status: 'error', message: 'OpenAI request blocked on static hosting. Use a proxy for live chat.' };
  }
  if (lower.includes('rate') || lower.includes('429')) {
    return { status: 'rate_limited', message: message || 'Rate limited' };
  }
  return { status: 'error', message: message || 'OpenAI error' };
}

async function testFeedKey(feed, statusEl) {
  const keyConfig = getKeyConfig(feed);
  if (feed.id === 'openai' && keyConfig.key) {
    keyConfig.key = keyConfig.key.trim();
  }
  if (!keyConfig.key) {
    if (feed.id === 'openai' && getOpenAiProxy()) {
      setKeyStatus(feed.id, 'ok', statusEl, 'Using proxy key');
      return;
    }
    setKeyStatus(feed.id, 'missing', statusEl, 'Missing API key');
    return;
  }
  setKeyStatus(feed.id, 'testing', statusEl, 'Testing key...');

  if (feed.id === 'openai') {
    if (isStaticMode() && !getOpenAiProxy()) {
      if (!state.settings.superMonitor) {
        setKeyStatus(feed.id, 'missing', statusEl, 'Enable Super Monitor Mode to test.');
        return;
      }
      setKeyStatus(feed.id, 'ok', statusEl, 'Key saved. Static hosting cannot validate without a proxy.');
      return;
    }
    try {
      const result = await callAssistant({
        messages: [{ role: 'user', content: 'ping' }],
        context: { mode: 'key-test' },
        temperature: 0
      });
      if (result) {
        setKeyStatus(feed.id, 'ok', statusEl, 'Key valid');
      } else {
        setKeyStatus(feed.id, 'error', statusEl, 'No response');
      }
    } catch (err) {
      const { status, message } = normalizeOpenAIError(err);
      setKeyStatus(feed.id, status, statusEl, message);
    }
    return;
  }

  const params = new URLSearchParams();
  params.set('id', feed.id);
  params.set('force', '1');
  if (feed.supportsQuery && feed.defaultQuery) {
    params.set('query', feed.defaultQuery);
  }
  if (keyConfig.key) {
    params.set('key', keyConfig.key);
    if (keyConfig.keyParam) params.set('keyParam', keyConfig.keyParam);
    if (keyConfig.keyHeader) params.set('keyHeader', keyConfig.keyHeader);
  }

  try {
    const { data: payload, error } = await apiJson(`/api/feed?${params.toString()}`);
    if (error || !payload) {
      setKeyStatus(feed.id, 'error', statusEl, 'Feed API unreachable');
      return;
    }
    const derived = deriveKeyStatus(payload);
    const detail = payload.message || payload.error || (payload.httpStatus ? `HTTP ${payload.httpStatus}` : '');
    setKeyStatus(feed.id, derived, statusEl, detail);
  } catch (err) {
    setKeyStatus(feed.id, 'error', statusEl, err.message);
  }
}

function attachKeyButtons() {
  return;
}

function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !stopwords.has(token))
    .join(' ')
    .trim();
}

function canonicalUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((param) => parsed.searchParams.delete(param));
    return parsed.toString();
  } catch (err) {
    return url;
  }
}

function dedupeItems(items) {
  const seen = new Set();
  const deduped = [];
  items.forEach((item) => {
    const key = item._dedupeKey || canonicalUrl(item.url || '') || normalizeTitle(item.title || '');
    if (!key) {
      deduped.push(item);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function jaccardSimilarity(aTokens, bTokens) {
  if (!aTokens.size || !bTokens.size) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union ? intersection / union : 0;
}

function clusterNews(items) {
  const clusters = [];
  items.forEach((item) => {
    const urlKey = canonicalUrl(item.url);
    const tokens = new Set(normalizeTitle(item.title).split(' ').filter(Boolean));

    let matched = null;
    for (const cluster of clusters) {
      if (urlKey && cluster.urls.has(urlKey)) {
        matched = cluster;
        break;
      }
      const sim = jaccardSimilarity(tokens, cluster.tokens);
      if (sim > 0.72) {
        matched = cluster;
        break;
      }
    }

    if (!matched) {
      const cluster = {
        id: `cluster-${clusters.length}-${Date.now()}`,
        primary: item,
        items: [item],
        sources: new Set([item.source]),
        urls: urlKey ? new Set([urlKey]) : new Set(),
        tokens,
        updatedAt: item.publishedAt || Date.now()
      };
      clusters.push(cluster);
    } else {
      matched.items.push(item);
      matched.sources.add(item.source);
      if (urlKey) matched.urls.add(urlKey);
      if (item.publishedAt && item.publishedAt > matched.updatedAt) {
        matched.updatedAt = item.publishedAt;
        matched.primary = item;
      }
    }
  });

  return clusters.sort((a, b) => b.updatedAt - a.updatedAt);
}

function parseRss(text, feed) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'text/xml');
  const items = [...xml.getElementsByTagName('item')];
  if (!items.length) {
    const atomEntries = [...xml.getElementsByTagName('entry')];
    const entries = atomEntries.length
      ? atomEntries
      : (xml.getElementsByTagNameNS ? [...xml.getElementsByTagNameNS('*', 'entry')] : []);
    return entries.map((entry) => {
      const title = entry.getElementsByTagName('title')?.[0]?.textContent || 'Untitled';
      const linkEl = entry.getElementsByTagName('link')?.[0];
      const link = linkEl?.getAttribute('href') || linkEl?.textContent || '';
      const published = entry.getElementsByTagName('updated')?.[0]?.textContent
        || entry.getElementsByTagName('published')?.[0]?.textContent;
      const summaryEl = entry.getElementsByTagName('summary')?.[0];
      const rawDesc = summaryEl?.textContent || '';
      const rawHtml = summaryEl?.innerHTML || '';
      const normalized = normalizeSummary(rawDesc, rawHtml);
      return {
        title,
        url: link,
        summary: normalized.summary,
        summaryHtml: normalized.summaryHtml,
        publishedAt: published ? Date.parse(published) : Date.now(),
        source: feed.name,
        category: feed.category
      };
    });
  }
  return items.map((item) => {
    const title = item.getElementsByTagName('title')?.[0]?.textContent || 'Untitled';
    const link = item.getElementsByTagName('link')?.[0]?.textContent
      || item.getElementsByTagName('guid')?.[0]?.textContent
      || '';
    const dcDate = item.getElementsByTagName('dc:date')?.[0]?.textContent;
    const published = item.getElementsByTagName('pubDate')?.[0]?.textContent || dcDate;
    const source = item.getElementsByTagName('source')?.[0]?.textContent || feed.name;
    let geo = null;
    const geoPoint = item.getElementsByTagName('georss:point')?.[0]?.textContent;
    if (geoPoint) {
      const [lat, lon] = geoPoint.trim().split(/\\s+/).map(Number);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        geo = { lat, lon };
      }
    } else {
      const latText = item.getElementsByTagName('geo:lat')?.[0]?.textContent;
      const lonText = item.getElementsByTagName('geo:long')?.[0]?.textContent;
      if (latText && lonText) {
        const lat = Number(latText);
        const lon = Number(lonText);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          geo = { lat, lon };
        }
      }
    }
    const descEl = item.querySelector('description');
    const rawDesc = descEl?.textContent || '';
    const rawHtml = descEl?.innerHTML || '';
    const normalized = normalizeSummary(rawDesc, rawHtml);
    return {
      title,
      url: link,
      summary: normalized.summary,
      summaryHtml: normalized.summaryHtml,
      publishedAt: published ? Date.parse(published) : Date.now(),
      source,
      category: feed.category,
      geo
    };
  });
}

function parseJson(text, feed) {
  try {
    if (feed.format === 'csv') {
      if (feedParsers[feed.id]) return feedParsers[feed.id](text, feed);
      return parseGenericCsv(text, feed);
    }
    const data = JSON.parse(text);
    if (feed.format === 'arcgis') {
      return parseArcGisGeoJson(data, feed);
    }
    if (feedParsers[feed.id]) return feedParsers[feed.id](data, feed);
    if (feed.isCustom) return parseGenericJsonFeed(data, feed);
    return [];
  } catch (err) {
    return [];
  }
}

function parseGenericJsonFeed(data, feed) {
  const list = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data?.articles)
        ? data.articles
        : Array.isArray(data?.data)
          ? data.data
          : [];
  return list.slice(0, 20).map((entry) => {
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
    const title = entry.title || entry.name || entry.headline || 'Untitled';
    const url = entry.url || entry.link || entry.permalink || '';
    const summary = entry.summary || entry.description || entry.body || '';
    const published = entry.publishedAt || entry.pubDate || entry.date || entry.updatedAt;
    const geo = entry.geo || (entry.latitude && entry.longitude ? { lat: Number(entry.latitude), lon: Number(entry.longitude) } : null);
    return {
      title,
      url,
      summary,
      publishedAt: published ? Date.parse(published) : Date.now(),
      source: entry.source || feed.name,
      category: feed.category,
      geo
    };
  });
}

function parseArcGisGeoJson(data, feed) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const pickFirst = (obj, keys = []) => {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
        return obj[key];
      }
    }
    return null;
  };
  const toDate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      if (value > 1e12) return value;
      if (value > 1e9) return value * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  };
  const inferDate = (props) => {
    const candidates = [
      'reported_date', 'report_date', 'reportdate', 'incident_date', 'event_date', 'date', 'datetime',
      'timestamp', 'time', 'created_date', 'created', 'updated_date', 'updated', 'last_updated', 'last_update',
      'edit_date', 'start_date', 'end_date'
    ];
    const direct = pickFirst(props, candidates);
    if (direct) return toDate(direct);
    for (const key of Object.keys(props || {})) {
      const lower = key.toLowerCase();
      if (lower.includes('date') || lower.includes('time') || lower.includes('updated')) {
        const value = toDate(props[key]);
        if (value) return value;
      }
    }
    return null;
  };
  const inferTitle = (props) => pickFirst(props, [
    'title', 'name', 'incident', 'event', 'type', 'category', 'hazard', 'summary', 'description'
  ]) || feed.name;
  const inferSummary = (props) => pickFirst(props, [
    'summary', 'description', 'details', 'notes', 'comments', 'status', 'headline'
  ]) || '';
  const inferAlertType = (props) => pickFirst(props, [
    'alert_type', 'event', 'type', 'category', 'hazard', 'incident_type'
  ]);
  const inferSeverity = (props) => pickFirst(props, [
    'severity', 'sig', 'significance', 'priority', 'status'
  ]);
  const inferLocation = (props) => pickFirst(props, [
    'location', 'loc_desc', 'area_desc', 'place', 'city', 'county', 'state', 'country', 'region'
  ]);

  return features.slice(0, 250).map((feature) => {
    const props = feature?.properties || feature?.attributes || {};
    const title = inferTitle(props);
    const summary = inferSummary(props);
    const publishedAt = inferDate(props) || Date.now();
    const alertType = inferAlertType(props);
    const severity = inferSeverity(props);
    const location = inferLocation(props);
    let geo = geometryToPoint(feature.geometry);
    if (!geo) {
      const lat = pickFirst(props, ['latitude', 'lat', 'y']);
      const lon = pickFirst(props, ['longitude', 'lon', 'x']);
      if (lat !== null && lon !== null) {
        const nlat = Number(lat);
        const nlon = Number(lon);
        if (!Number.isNaN(nlat) && !Number.isNaN(nlon)) {
          geo = { lat: nlat, lon: nlon };
        }
      }
    }
    return {
      title,
      url: props.url || props.link || '',
      summary,
      publishedAt,
      source: feed.name,
      category: feed.category,
      geo,
      alertType,
      severity,
      location
    };
  }).filter((item) => item.geo);
}

function parseGenericCsv(text, feed) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1, 21).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx];
    });
    const title = row.title || row.name || row.headline || values[0] || 'Untitled';
    const url = row.url || row.link || '';
    const summary = row.summary || row.description || '';
    const published = row.publishedat || row.date || row.published || '';
    return {
      title,
      url,
      summary,
      publishedAt: published ? Date.parse(published) : Date.now(),
      source: feed.name,
      category: feed.category
    };
  });
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
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
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      row.push(current);
      if (row.some((cell) => cell.trim() !== '')) {
        rows.push(row);
      }
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

const parseFederalRegister = (data, feed) => (data.results || []).map((doc) => ({
  title: doc.title,
  url: doc.html_url,
  summary: doc.abstract || doc.type,
  publishedAt: doc.publication_date ? Date.parse(doc.publication_date) : Date.now(),
  source: 'Federal Register',
  category: feed.category,
  alertType: doc.type,
  deadline: doc.comments_close_on || doc.effective_on || null
}));

const parseEiaSeries = (data, feed) => {
  const seriesList = Array.isArray(data?.series) ? data.series : [];
  if (seriesList.length) {
    const items = seriesList.flatMap((series) => {
      if (!Array.isArray(series.data) || !series.data.length) return [];
      const title = series.name || series.series_id || 'EIA Series Update';
      const units = series.units ? ` ${series.units}` : '';
      const latest = series.data[0];
      const prev = series.data[1];
      const delta = prev ? (Number(latest[1]) - Number(prev[1])) : null;
      const deltaPct = prev && Number(prev[1]) ? (delta / Number(prev[1])) * 100 : null;
      return series.data.slice(0, 4).map(([date, value], idx) => {
        const valueText = value !== null && value !== undefined ? formatNumber(value) : '--';
        return {
          title: idx === 0 ? title : `${title} (${date})`,
          url: series.link || feed.docsUrl || feed.url,
          summary: `${date || 'Latest'}: ${valueText}${units}`,
          publishedAt: Date.now() - idx * 3600 * 1000,
          source: 'EIA',
          category: feed.category,
          value: Number(value),
          unit: series.units || '',
          delta: idx === 0 ? delta : null,
          deltaPct: idx === 0 ? deltaPct : null
        };
      });
    });
    if (items.length) return items;
  }

  const response = data?.response;
  if (response && Array.isArray(response.data) && response.data.length) {
    const title = response.description || response.series_id || data.series_id || 'EIA Series Update';
    return response.data.slice(0, 4).map((row, idx) => {
      const period = row.period || row.date || row.timestamp || row.time;
      let value = row.value ?? row.price ?? row.data;
      if (value === undefined && row) {
        const fallbackKey = Object.keys(row).find((key) => !['period', 'date', 'timestamp', 'time', 'series', 'series_id'].includes(key));
        value = row[fallbackKey];
      }
      const valueText = value !== null && value !== undefined ? formatNumber(value) : '--';
      return {
        title: idx === 0 ? title : `${title} (${period})`,
        url: feed.docsUrl || feed.url,
        summary: `${period || 'Latest'}: ${valueText}`,
        publishedAt: Date.now() - idx * 3600 * 1000,
        source: 'EIA',
        category: feed.category,
        value: Number(value)
      };
    });
  }
  return [];
};

const parsePolymarketMarkets = (data, feed) => {
  const markets = Array.isArray(data) ? data : (data?.markets || data?.data || []);
  if (!Array.isArray(markets) || !markets.length) return [];
  const toNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const parseArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const sorted = [...markets].sort((a, b) => {
    const aVol = toNumber(a.volume24hr ?? a.volume) || 0;
    const bVol = toNumber(b.volume24hr ?? b.volume) || 0;
    return bVol - aVol;
  });
  return sorted.slice(0, 60).map((market) => {
    const outcomes = parseArray(market.outcomes);
    const prices = parseArray(market.outcomePrices);
    const yesIndex = outcomes.findIndex((entry) => String(entry).toLowerCase() === 'yes');
    const pickedIndex = yesIndex >= 0 ? yesIndex : 0;
    const price = prices[pickedIndex] !== undefined ? Number(prices[pickedIndex]) : null;
    const probability = Number.isFinite(price) ? Math.round(price * 100) : null;
    const outcomeLabel = outcomes[pickedIndex] || 'Yes';
    const volume24 = toNumber(market.volume24hr) || toNumber(market.volume24hrClob) || toNumber(market.volume) || 0;
    const liquidity = toNumber(market.liquidity) || toNumber(market.liquidityClob) || 0;
    const metaParts = [];
    if (probability !== null) metaParts.push(`${outcomeLabel}: ${probability}%`);
    if (volume24) metaParts.push(`24h Vol ${formatCompactCurrency(volume24)}`);
    if (liquidity) metaParts.push(`Liq ${formatCompactCurrency(liquidity)}`);
    const end = market.endDate || market.endDateIso;
    if (end) metaParts.push(`Ends ${new Date(end).toLocaleDateString('en-US')}`);
    const updated = market.updatedAt || market.createdAt || market.startDate || market.endDate;
    return {
      title: market.question || market.title || 'Polymarket Market',
      url: market.slug ? `https://polymarket.com/market/${market.slug}` : 'https://polymarket.com/',
      summary: metaParts.join(' • '),
      publishedAt: updated ? Date.parse(updated) : Date.now(),
      source: 'Polymarket',
      category: feed.category,
      value: probability !== null ? probability : null,
      alertType: 'Prediction',
      volume24,
      liquidity
    };
  });
};

const parseIncidentNewsCsv = (text, feed) => {
  if (!text) return [];
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (key) => headers.indexOf(key);
  const get = (row, key) => {
    const i = idx(key);
    return i >= 0 ? row[i] : '';
  };
  return rows.slice(1, 101).map((row) => {
    const id = get(row, 'id');
    const name = get(row, 'name');
    const location = get(row, 'location');
    const threat = get(row, 'threat') || 'Oil';
    const commodity = get(row, 'commodity');
    const openDate = get(row, 'open_date');
    const lat = Number(get(row, 'lat'));
    const lon = Number(get(row, 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const summaryParts = [];
    if (threat) summaryParts.push(threat);
    if (commodity) summaryParts.push(commodity);
    if (location) summaryParts.push(location);
    return {
      title: name || 'Incident',
      url: id ? `https://incidentnews.noaa.gov/incident/${id}` : 'https://incidentnews.noaa.gov/',
      summary: summaryParts.join(' • '),
      publishedAt: openDate ? Date.parse(openDate) : Date.now(),
      source: 'NOAA IncidentNews',
      category: feed.category,
      geo: { lat, lon },
      alertType: threat || 'Spill',
      location,
      severity: threat
    };
  }).filter(Boolean);
};

const parseStooqCsv = (text, feed) => {
  if (!text) return [];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const values = lines[1].split(',').map((v) => v.trim());
  if (values.length < headers.length) return [];
  const row = headers.reduce((acc, key, idx) => {
    acc[key] = values[idx];
    return acc;
  }, {});
  if (!row.Symbol || !row.Close || row.Close === 'N/D') return [];
  const value = Number(row.Close);
  if (!Number.isFinite(value)) return [];
  const open = Number(row.Open);
  const deltaPct = Number.isFinite(open) && open ? ((value - open) / open) * 100 : null;
  return [{
    title: `${row.Symbol} Price`,
    url: `https://stooq.com/q/?s=${encodeURIComponent(row.Symbol.toLowerCase())}`,
    summary: `Close ${formatNumber(value)} | ${row.Date || 'Latest'} ${row.Time || ''}`.trim(),
    publishedAt: Date.now(),
    source: 'Stooq',
    category: feed.category,
    value,
    deltaPct,
    symbol: row.Symbol
  }];
};

const feedParsers = {
  'gdelt-doc': (data, feed) => (data.articles || []).map((article) => ({
    title: article.title,
    url: article.url,
    summary: article.seen || '',
    publishedAt: article.seendate ? Date.parse(article.seendate) : Date.now(),
    source: article.domain || article.sourceCountry || feed.name,
    category: feed.category
  })),
  'federal-register': parseFederalRegister,
  'federal-register-transport': parseFederalRegister,
  'nws-alerts': (data, feed) => (data.features || []).map((feature) => ({
    title: feature.properties.event,
    url: feature.properties.uri,
    summary: feature.properties.headline,
    publishedAt: Date.parse(feature.properties.sent) || Date.now(),
    source: 'NWS',
    category: feed.category,
    geo: geometryToPoint(feature.geometry),
    severity: feature.properties.severity,
    location: feature.properties.areaDesc,
    alertType: feature.properties.event
  })),
  'usgs-quakes-hour': (data, feed) => parseQuakes(data, feed),
  'usgs-quakes-day': (data, feed) => parseQuakes(data, feed),
  'eonet-events': (data, feed) => (data.events || []).map((event) => ({
    title: event.title,
    url: event.link,
    summary: event.description || '',
    publishedAt: event.geometry?.[0]?.date ? Date.parse(event.geometry[0].date) : Date.now(),
    source: 'NASA EONET',
    category: feed.category,
    geo: event.geometry?.[0] ? {
      lat: event.geometry[0].coordinates[1],
      lon: event.geometry[0].coordinates[0]
    } : null
  })),
  'swpc-json': (data, feed) => {
    if (!Array.isArray(data) || !data.length) return [];
    const entry = data[data.length - 1];
    const speed = entry.speed ?? entry.vsw ?? entry.VSW;
    const density = entry.density ?? entry.proton_density ?? entry.DENSITY;
    const temp = entry.temperature ?? entry.TEMP;
    const parts = [];
    if (speed) parts.push(`Speed ${formatNumber(speed)} km/s`);
    if (density) parts.push(`Density ${formatNumber(density)} p/cm3`);
    if (temp) parts.push(`Temp ${formatNumber(temp)} K`);
    return [{
      title: 'SWPC Solar Wind (1m)',
      url: 'https://services.swpc.noaa.gov/json/',
      summary: parts.length ? parts.join(' | ') : 'Solar wind updated.',
      publishedAt: entry.time_tag ? Date.parse(entry.time_tag) : Date.now(),
      source: 'NOAA SWPC',
      category: feed.category,
      alertType: 'Solar Wind'
    }];
  },
  'swpc-kp': (data, feed) => {
    if (!Array.isArray(data) || !data.length) return [];
    const entry = data[data.length - 1];
    const kp = Number(entry.kp_index ?? entry.kp);
    if (!Number.isFinite(kp)) return [];
    let impact = 'Quiet';
    if (kp >= 5) impact = 'Storm';
    else if (kp >= 4) impact = 'Active';
    const severity = `Kp ${kp.toFixed(1)} (${impact})`;
    return [{
      title: 'Geomagnetic Kp Index',
      url: 'https://www.swpc.noaa.gov/products/planetary-k-index',
      summary: severity,
      publishedAt: entry.time_tag ? Date.parse(entry.time_tag) : Date.now(),
      source: 'NOAA SWPC',
      category: feed.category,
      severity,
      alertType: 'Geomagnetic'
    }];
  },
  'energy-eia': parseEiaSeries,
  'energy-eia-brent': parseEiaSeries,
  'energy-eia-ng': parseEiaSeries,
  'polymarket-markets': parsePolymarketMarkets,
  'noaa-incidentnews': parseIncidentNewsCsv,
  'stooq-quote': parseStooqCsv,
  'transport-opensky': (data, feed) => {
    const states = Array.isArray(data?.states) ? data.states : [];
    if (!states.length) return [];
    const sampled = states
      .filter((entry) => Number.isFinite(entry?.[5]) && Number.isFinite(entry?.[6]))
      .slice(0, 18);
    const updatedAt = (data?.time ? data.time * 1000 : Date.now());
    return sampled.map((entry) => {
      const callsign = (entry?.[1] || entry?.[0] || 'Unknown').trim();
      const origin = entry?.[2] || 'Unknown';
      const speed = Number.isFinite(entry?.[9]) ? `${Math.round(entry[9] * 3.6)} km/h` : null;
      const altitude = Number.isFinite(entry?.[7]) ? `${Math.round(entry[7] * 3.28084)} ft` : null;
      const parts = [speed, altitude].filter(Boolean);
      return {
        title: `${callsign || 'Flight'} • ${origin}`,
        url: 'https://opensky-network.org/',
        summary: parts.length ? parts.join(' | ') : 'Airborne signal',
        publishedAt: entry?.[4] ? entry[4] * 1000 : updatedAt,
        source: 'OpenSky',
        category: feed.category,
        geo: {
          lat: entry[6],
          lon: entry[5]
        }
      };
    });
  },
  'coinpaprika-global': (data, feed) => ([{
    title: `Global Market Cap: $${formatNumber(data.market_cap_usd)}`,
    url: 'https://coinpaprika.com',
    summary: `24h Volume $${formatNumber(data.volume_24h_usd)} | Dominance BTC ${data.bitcoin_dominance_percentage?.toFixed(2)}%`,
    publishedAt: Date.now(),
    source: 'CoinPaprika',
    category: feed.category,
    value: Number(data.market_cap_usd),
    secondaryValue: Number(data.volume_24h_usd),
    dominance: Number(data.bitcoin_dominance_percentage)
  }]),
  'coinpaprika-tickers': (data, feed) => data.slice(0, 10).map((coin) => ({
    title: `${coin.name} (${coin.symbol})`,
    url: `https://coinpaprika.com/coin/${coin.id}/`,
    summary: `Price $${coin.quotes.USD.price.toFixed(2)} | 24h ${coin.quotes.USD.percent_change_24h?.toFixed(2)}%`,
    publishedAt: Date.now(),
    source: 'CoinPaprika',
    category: feed.category,
    value: Number(coin.quotes.USD.price),
    change24h: Number(coin.quotes.USD.percent_change_24h),
    symbol: coin.symbol
  })),
  'blockstream-mempool': (data, feed) => ([{
    title: `Bitcoin Mempool: ${formatNumber(data.count)} tx`,
    url: 'https://blockstream.info',
    summary: `vSize ${formatNumber(data.vsize)} | Fees ${formatNumber(data.total_fee)} sat`,
    publishedAt: Date.now(),
    source: 'Blockstream',
    category: feed.category
  }]),
  'openaq-api': (data, feed) => {
    const rows = Array.isArray(data?.results) ? data.results : [];
    if (!rows.length) return [];
    return rows.slice(0, 12).map((row) => {
      const coords = row.coordinates || {};
      const lat = Number(coords.latitude ?? coords.lat);
      const lon = Number(coords.longitude ?? coords.lon);
      const hasGeo = Number.isFinite(lat) && Number.isFinite(lon);
      const locality = row.locality || row.city || row.name;
      const country = row.country?.name || row.country?.code || row.country;
      const provider = row.provider?.name || row.provider || 'OpenAQ';
      const parameters = Array.isArray(row.parameters) ? row.parameters.map((p) => p.name || p.parameter).filter(Boolean) : [];
      const summaryParts = [];
      if (country) summaryParts.push(country);
      if (parameters.length) summaryParts.push(`Sensors: ${parameters.slice(0, 4).join(', ')}`);
      return {
        title: locality ? `${locality}` : 'Air Quality Station',
        url: row.id ? `https://openaq.org/locations/${row.id}` : 'https://openaq.org/',
        summary: summaryParts.length ? summaryParts.join(' | ') : 'Air quality station update.',
        publishedAt: row.updatedAt ? Date.parse(row.updatedAt) : Date.now(),
        source: provider,
        category: feed.category,
        alertType: 'Air Quality',
        regionTag: country,
        geo: hasGeo ? { lat, lon } : null,
        mapOnly: true
      };
    });
  },
  'foia-api': (data, feed) => {
    const ckanResults = Array.isArray(data?.result?.results) ? data.result.results : null;
    if (ckanResults) {
      return ckanResults.slice(0, 12).map((entry) => ({
        title: entry.title || entry.name || 'FOIA Dataset',
        url: entry.url || (entry.name ? `https://catalog.data.gov/dataset/${entry.name}` : ''),
        summary: entry.notes || '',
        publishedAt: entry.metadata_modified ? Date.parse(entry.metadata_modified) : Date.now(),
        source: entry.organization?.title || 'Data.gov',
        category: feed.category
      }));
    }
    const foiaRows = Array.isArray(data?.data) ? data.data : [];
    if (!foiaRows.length) return [];
    return foiaRows.slice(0, 12).map((entry) => ({
      title: entry.attributes?.name || entry.attributes?.title || 'FOIA Component',
      url: entry.links?.self || 'https://www.foia.gov/developer/',
      summary: entry.attributes?.description || '',
      publishedAt: Date.parse(entry.attributes?.updated_at || entry.attributes?.created_at) || Date.now(),
      source: 'FOIA.gov',
      category: feed.category
    }));
  },
  'treasury-debt': (data, feed) => (data.data || []).map((row) => ({
    title: `Debt to the Penny (${row.record_date})`,
    url: 'https://fiscaldata.treasury.gov/',
    summary: `Total: $${formatNumber(row.tot_pub_debt_out_amt || row.total_public_debt_outstanding_amt)} | Intragov: $${formatNumber(row.intragov_hold_amt || row.intragovernmental_holdings)}`,
    publishedAt: Date.parse(row.record_date) || Date.now(),
    source: 'US Treasury',
    category: feed.category,
    value: Number(row.tot_pub_debt_out_amt || row.total_public_debt_outstanding_amt),
    secondaryValue: Number(row.intragov_hold_amt || row.intragovernmental_holdings)
  })),
  'bls-cpi': (data, feed) => {
    const series = data.Results?.series?.[0]?.data?.[0];
    if (!series) return [];
    return [{
      title: `CPI (CUUR0000SA0) ${series.periodName} ${series.year}`,
      url: 'https://www.bls.gov/',
      summary: `Value ${series.value}`,
      publishedAt: Date.now(),
      source: 'BLS',
      category: feed.category,
      value: Number(series.value)
    }];
  },
  'cisa-kev': (data, feed) => (data.vulnerabilities || []).slice(0, 8).map((vuln) => ({
    title: `${vuln.cveID} | ${vuln.vendorProject}`,
    url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    summary: `${vuln.product} | Due ${vuln.dueDate}`,
    publishedAt: Date.parse(vuln.dateAdded) || Date.now(),
    source: 'CISA KEV',
    category: feed.category,
    alertType: 'Known Exploited',
    deadline: vuln.dueDate,
    severity: vuln.knownRansomwareCampaignUse && vuln.knownRansomwareCampaignUse !== 'Unknown'
      ? 'Ransomware'
      : 'Exploited'
  }))
};

function parseQuakes(data, feed) {
  return (data.features || []).map((feature) => ({
    title: `${feature.properties.mag.toFixed(1)}M - ${feature.properties.place}`,
    url: feature.properties.url,
    summary: `Depth ${feature.geometry.coordinates[2]} km`,
    publishedAt: feature.properties.time || Date.now(),
    source: 'USGS',
    category: feed.category,
    magnitude: feature.properties.mag,
    severity: (() => {
      const mag = feature.properties.mag;
      if (mag === null || mag === undefined) return null;
      const match = severityLabels.find((entry) => mag >= entry.min);
      return match ? `Magnitude ${mag.toFixed(1)} (${match.label})` : `Magnitude ${mag.toFixed(1)}`;
    })(),
    location: feature.properties.place,
    alertType: 'Earthquake',
    geo: {
      lat: feature.geometry.coordinates[1],
      lon: feature.geometry.coordinates[0]
    }
  }));
}

function geometryToPoint(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  if (geometry.type === 'Point') {
    return { lat: geometry.coordinates[1], lon: geometry.coordinates[0] };
  }
  if (geometry.type === 'MultiPoint') {
    const coords = geometry.coordinates;
    if (!coords?.length) return null;
    return { lat: coords[0][1], lon: coords[0][0] };
  }
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates;
    if (!coords?.length) return null;
    const mid = coords[Math.floor(coords.length / 2)];
    return { lat: mid[1], lon: mid[0] };
  }
  if (geometry.type === 'MultiLineString') {
    const coords = geometry.coordinates?.[0];
    if (!coords?.length) return null;
    const mid = coords[Math.floor(coords.length / 2)];
    return { lat: mid[1], lon: mid[0] };
  }
  const coords = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates[0][0]
      : null;
  if (!coords || !coords.length) return null;
  const sum = coords.reduce((acc, coord) => {
    acc.lat += coord[1];
    acc.lon += coord[0];
    return acc;
  }, { lat: 0, lon: 0 });
  return {
    lat: sum.lat / coords.length,
    lon: sum.lon / coords.length
  };
}

function formatNumber(value) {
  if (value === null || value === undefined) return '--';
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatShortDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function decodeHtmlEntities(input) {
  if (!input) return '';
  const doc = new DOMParser().parseFromString(input, 'text/html');
  return doc.documentElement.textContent || '';
}

function stripHtml(input) {
  if (!input) return '';
  let safe = input;
  if (safe.includes('&lt;') || safe.includes('&gt;')) {
    safe = decodeHtmlEntities(safe);
  }
  const doc = new DOMParser().parseFromString(`<div>${safe}</div>`, 'text/html');
  return doc.body.textContent || '';
}

function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const trimmed = text.slice(0, maxChars);
  const lastSpace = trimmed.lastIndexOf(' ');
  return `${trimmed.slice(0, lastSpace > 80 ? lastSpace : maxChars).trim()}…`;
}

function normalizeSummary(rawDesc, rawHtml) {
  const raw = rawHtml && rawHtml !== rawDesc ? rawHtml : rawDesc;
  if (!raw) return { summary: rawDesc || '', summaryHtml: '' };
  let decoded = raw;
  if (raw.includes('&lt;') || raw.includes('&gt;')) {
    decoded = decodeHtmlEntities(raw);
  }
  const hasTags = decoded.includes('<') && decoded.includes('>');
  if (hasTags) {
    const text = stripHtml(decoded).replace(/\s+/g, ' ').trim();
    return {
      summary: text || rawDesc || '',
      summaryHtml: decoded
    };
  }
  return { summary: rawDesc || decoded, summaryHtml: '' };
}

function getListLimit(id) {
  if (!id) return 6;
  if (!(id in state.listLimits)) {
    state.listLimits[id] = listDefaults[id] ?? 6;
  }
  return state.listLimits[id];
}

function bumpListLimit(id, total) {
  if (!id) return false;
  const current = getListLimit(id);
  if (current >= total) return false;
  state.listLimits[id] = Math.min(total, current + listPageSize);
  return true;
}

function sanitizeHtml(input) {
  if (!input) return '';
  let safeInput = input;
  if (safeInput.includes('&lt;') || safeInput.includes('&gt;')) {
    safeInput = decodeHtmlEntities(safeInput);
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${safeInput}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';

  const cleanNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      return;
    }
    const tag = node.tagName.toLowerCase();
    if (!allowedSummaryTags.has(tag)) {
      const text = doc.createTextNode(node.textContent || '');
      node.replaceWith(text);
      return;
    }
    [...node.attributes].forEach((attr) => {
      if (tag === 'a' && attr.name === 'href') return;
      node.removeAttribute(attr.name);
    });
    if (tag === 'a') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    [...node.childNodes].forEach(cleanNode);
  };

  [...root.childNodes].forEach(cleanNode);
  return root.innerHTML;
}

function formatCompactNumber(value, options = {}) {
  if (!Number.isFinite(value)) return '--';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
    ...options
  }).format(value);
}

function formatCompactCurrency(value) {
  if (!Number.isFinite(value)) return '--';
  return `$${formatCompactNumber(value)}`;
}

function getTickerKey(entry) {
  return `${entry.type}:${entry.lookup}`;
}

function formatTickerValue(ticker) {
  if (!Number.isFinite(ticker.value)) return '--';
  return ticker.isIndex ? formatCompactNumber(ticker.value) : formatCompactCurrency(ticker.value);
}

function extractStooqAsOf(summary = '') {
  if (!summary) return '';
  const parts = summary.split('|');
  if (parts.length < 2) return '';
  return parts[1].trim();
}

function buildCustomTickerItems() {
  const watchlist = state.settings.tickerWatchlist || [];
  if (!watchlist.length && !state.customTickers.length) return [];
  const resolved = new Map();
  state.customTickers.forEach((ticker) => {
    const key = getTickerKey({ type: ticker.type, lookup: ticker.lookup || ticker.symbol || ticker.label || '' });
    resolved.set(key, ticker);
  });
  return watchlist.map((entry) => {
    const key = getTickerKey(entry);
    const ticker = resolved.get(key);
    if (!ticker) {
      return {
        text: `${entry.label || entry.symbol}: --`,
        url: entry.url || '',
        change: null,
        pending: true
      };
    }
    const valueText = formatTickerValue(ticker);
    const deltaText = Number.isFinite(ticker.delta) ? `${ticker.delta > 0 ? '+' : ''}${ticker.delta.toFixed(2)}%` : '';
    const parts = [`${ticker.label}: ${valueText}`];
    if (deltaText) parts.push(`24h ${deltaText}`);
    return {
      text: parts.join(' | '),
      url: ticker.url,
      change: ticker.delta
    };
  });
}

function normalizeTickerSymbol(input) {
  return input
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9.^-]/g, '')
    .toUpperCase();
}

async function resolveSymbolWithAI(type, input) {
  if (!state.keys.openai?.key || !state.settings.aiTranslate) return null;
  const prompt = `Return the best ${type === 'market' ? 'market index' : 'equity'} ticker symbol for "${input}". Use ^ prefix for indices. Return only the symbol or UNKNOWN.`;
  try {
    const response = await callAssistant({
      messages: [{ role: 'user', content: prompt }],
      context: { mode: 'ticker_resolve', type },
      temperature: 0
    });
    const cleaned = (response || '').split(/\s+/)[0].replace(/[^a-zA-Z0-9.^-]/g, '').toUpperCase();
    if (!cleaned || cleaned.includes('UNKNOWN')) return null;
    return cleaned;
  } catch (err) {
    return null;
  }
}

async function resolveTickerInput(type, input) {
  const raw = input.trim();
  if (!raw) return null;
  if (type === 'crypto') {
    const res = await fetch(`https://api.coinpaprika.com/v1/search/?q=${encodeURIComponent(raw)}&c=currencies`);
    const data = await res.json();
    if (!data?.currencies?.length) return null;
    const normalized = raw.replace(/\s+/g, '').toLowerCase();
    const match = data.currencies.find((entry) => entry.symbol?.toLowerCase() === normalized) || data.currencies[0];
    if (!match) return null;
    return {
      type: 'crypto',
      symbol: match.symbol,
      label: `${match.name} (${match.symbol})`,
      lookup: match.id,
      source: 'CoinPaprika'
    };
  }

  let symbol = normalizeTickerSymbol(raw);
  if (!symbol) return null;
  if ((/\s/.test(raw) || raw.length > 6) && state.keys.openai?.key) {
    const resolved = await resolveSymbolWithAI(type, raw);
    if (resolved) symbol = resolved;
  }

  const isIndex = type === 'market' || symbol.startsWith('^');
  let lookup = symbol;
  if (type === 'market' && !symbol.startsWith('^')) {
    lookup = `^${symbol}`;
    symbol = `^${symbol}`;
  }
  if (!lookup.includes('.') && !lookup.startsWith('^')) {
    lookup = `${lookup}.US`;
  }
  return {
    type: type === 'market' ? 'market' : 'equity',
    symbol,
    label: symbol,
    lookup: lookup.toLowerCase(),
    isIndex,
    source: 'Stooq'
  };
}

async function fetchStooqQuote(symbol) {
  const feed = state.feeds.find((entry) => entry.id === 'stooq-quote');
  if (!feed) return null;
  if (isStaticMode()) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
    const proxies = ['allorigins', 'jina'];
    for (const proxy of proxies) {
      try {
        const proxied = applyCustomProxy(url, proxy);
        const response = await fetch(proxied);
        if (!response.ok) continue;
        const text = await response.text();
        const parsed = parseStooqCsv(text, feed);
        if (parsed?.[0]) return parsed[0];
      } catch {
        // try next proxy
      }
    }
    return null;
  }
  const result = await fetchFeed(feed, symbol, true);
  return result.items?.[0] || null;
}

async function fetchCryptoQuote(id) {
  const response = await fetch(`https://api.coinpaprika.com/v1/tickers/${id}`);
  const data = await response.json();
  if (!data || !data.quotes?.USD) return null;
  return {
    value: Number(data.quotes.USD.price),
    delta: Number(data.quotes.USD.percent_change_24h),
    url: `https://coinpaprika.com/coin/${data.id}/`,
    name: data.name,
    symbol: data.symbol
  };
}

function renderWatchlistChips() {
  const containers = document.querySelectorAll('[data-watchlist]');
  containers.forEach((container) => {
    container.innerHTML = '';
    const watchlist = state.settings.tickerWatchlist || [];
    if (!watchlist.length) {
      const empty = document.createElement('div');
      empty.className = 'ticker-builder-hint';
      empty.textContent = 'No custom tickers yet.';
      container.appendChild(empty);
      return;
    }
    watchlist.forEach((entry) => {
      const chip = document.createElement('div');
      chip.className = `ticker-chip ${entry.type}`;
      const label = document.createElement('span');
      label.textContent = entry.label || entry.symbol;
      const remove = document.createElement('button');
      remove.className = 'ticker-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.dataset.key = getTickerKey(entry);
      chip.appendChild(label);
      chip.appendChild(remove);
      container.appendChild(chip);
    });
  });
}

async function refreshEnergyMarketQuotes() {
  if (isStaticMode() && !state.settings.superMonitor) {
    try {
      const response = await fetch(getAssetUrl(`/data/energy-market.json?ts=${Date.now()}`), { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.items) {
          state.energyMarket = payload.items;
          return;
        }
      }
    } catch {
      // fall through to live fetch
    }
  }
  const [wti, gas, gold] = await Promise.all([
    fetchStooqQuote('cl.f'),
    fetchStooqQuote('ng.f'),
    fetchStooqQuote('xauusd')
  ]);
  const next = {};
  if (wti?.value) {
    next.wti = {
      label: 'WTI Crude',
      value: wti.value,
      delta: Number.isFinite(wti.deltaPct) ? wti.deltaPct : null,
      url: wti.url,
      asOf: extractStooqAsOf(wti.summary || ''),
      symbol: wti.symbol
    };
  }
  if (gas?.value) {
    next.gas = {
      label: 'Nat Gas',
      value: gas.value,
      delta: Number.isFinite(gas.deltaPct) ? gas.deltaPct : null,
      url: gas.url,
      asOf: extractStooqAsOf(gas.summary || ''),
      symbol: gas.symbol
    };
  }
  if (gold?.value) {
    next.gold = {
      label: 'Gold',
      value: gold.value,
      delta: Number.isFinite(gold.deltaPct) ? gold.deltaPct : null,
      url: gold.url,
      asOf: extractStooqAsOf(gold.summary || ''),
      symbol: gold.symbol
    };
  }
  state.energyMarket = next;
}

async function refreshCustomTickers() {
  const watchlist = state.settings.tickerWatchlist || [];
  if (!watchlist.length) {
    state.customTickers = [];
    renderWatchlistChips();
    await refreshEnergyMarketQuotes();
    return;
  }
  const results = await Promise.all(watchlist.map(async (entry) => {
    if (entry.type === 'crypto') {
      const quote = await fetchCryptoQuote(entry.lookup);
      if (!quote || !Number.isFinite(quote.value)) return null;
      return {
        label: entry.label || `${quote.name} (${quote.symbol})`,
        value: quote.value,
        delta: Number.isFinite(quote.delta) ? quote.delta : null,
        url: quote.url,
        type: entry.type,
        isIndex: false,
        lookup: entry.lookup,
        symbol: entry.symbol
      };
    }
    const quote = await fetchStooqQuote(entry.lookup);
    if (!quote || !Number.isFinite(quote.value)) return null;
    return {
      label: entry.label || quote.symbol || entry.symbol,
      value: quote.value,
      delta: Number.isFinite(quote.deltaPct) ? quote.deltaPct : null,
      url: quote.url,
      type: entry.type,
      isIndex: entry.isIndex || entry.symbol?.startsWith('^') || quote.symbol?.startsWith('^'),
      lookup: entry.lookup,
      symbol: entry.symbol || quote.symbol
    };
  }));
  state.customTickers = results.filter(Boolean);
  renderWatchlistChips();
  await refreshEnergyMarketQuotes();
}

function setTickerBuilderStatus(builder, message, tone) {
  const status = builder.querySelector('.ticker-builder-status');
  if (!status) return;
  status.textContent = message || '';
  status.classList.remove('error', 'success');
  if (tone) status.classList.add(tone);
}

async function handleTickerAdd(builder) {
  const typeSelect = builder.querySelector('.ticker-type');
  const queryInput = builder.querySelector('.ticker-query');
  if (!typeSelect || !queryInput) return;
  const type = typeSelect.value;
  const query = queryInput.value.trim();
  if (!query) return;
  setTickerBuilderStatus(builder, 'Searching...', null);
  try {
    const resolved = await resolveTickerInput(type, query);
    if (!resolved) {
      setTickerBuilderStatus(builder, 'No match found. Try a symbol like AAPL, ^SPX, BTC.', 'error');
      return;
    }
    const key = getTickerKey(resolved);
    const existing = (state.settings.tickerWatchlist || []).some((entry) => getTickerKey(entry) === key);
    if (existing) {
      setTickerBuilderStatus(builder, 'Already in watchlist.', 'error');
      return;
    }
    state.settings.tickerWatchlist = [...(state.settings.tickerWatchlist || []), resolved];
    saveSettings();
    queryInput.value = '';
    setTickerBuilderStatus(builder, 'Added. Fetching quote…', 'success');
    await refreshCustomTickers();
    const resolvedNow = state.customTickers.some((ticker) => getTickerKey({ type: ticker.type, lookup: ticker.lookup || ticker.symbol || ticker.label || '' }) === key);
    setTickerBuilderStatus(builder, resolvedNow ? 'Added to watchlist.' : 'Added, quote pending. Will refresh shortly.', resolvedNow ? 'success' : 'error');
    renderTicker();
    renderFinanceSpotlight();
  } catch (err) {
    setTickerBuilderStatus(builder, 'Unable to add ticker right now.', 'error');
  }
}

function removeTickerFromWatchlist(key) {
  state.settings.tickerWatchlist = (state.settings.tickerWatchlist || []).filter((entry) => getTickerKey(entry) !== key);
  saveSettings();
  refreshCustomTickers().then(() => {
    renderTicker();
    renderFinanceSpotlight();
  });
}

function buildFinanceKPIs() {
  const items = applyFreshnessFilter(state.items);
  const byFeed = (id) => items.filter((item) => item.feedId === id);
  const pickFirst = (id) => byFeed(id)[0];
  const pickCoin = (symbol) => byFeed('coinpaprika-tickers').find((item) => item.symbol === symbol);

  const kpis = [];

  const debt = pickFirst('treasury-debt');
  if (debt?.value) {
    kpis.push({
      label: 'US Debt',
      value: formatCompactCurrency(debt.value),
      meta: debt.secondaryValue ? `Intragov ${formatCompactCurrency(debt.secondaryValue)}` : '',
      source: debt.source,
      url: debt.url,
      category: 'finance'
    });
  }

  const cpi = pickFirst('bls-cpi');
  if (cpi?.value) {
    kpis.push({
      label: 'CPI',
      value: formatCompactNumber(cpi.value),
      meta: cpi.title.replace('CPI (CUUR0000SA0) ', ''),
      source: cpi.source,
      url: cpi.url,
      category: 'finance'
    });
  }

  const marketWti = state.energyMarket?.wti;
  const wti = pickFirst('energy-eia');
  if (marketWti?.value || wti?.value) {
    const sourceItem = marketWti?.value ? marketWti : wti;
    const meta = marketWti?.value
      ? (marketWti.asOf ? `Market ${marketWti.asOf}` : 'Market')
      : wti.summary.split(':')[0];
    kpis.push({
      label: 'WTI Crude',
      value: formatCompactCurrency(sourceItem.value),
      meta,
      delta: Number.isFinite(sourceItem.delta ?? sourceItem.deltaPct) ? (sourceItem.delta ?? sourceItem.deltaPct) : null,
      source: sourceItem.source || (marketWti?.value ? 'Stooq' : wti.source),
      url: sourceItem.url || wti.url,
      category: 'energy'
    });
  }

  const brent = pickFirst('energy-eia-brent');
  if (brent?.value) {
    kpis.push({
      label: 'Brent',
      value: formatCompactCurrency(brent.value),
      meta: brent.summary.split(':')[0],
      delta: Number.isFinite(brent.deltaPct) ? brent.deltaPct : null,
      source: brent.source,
      url: brent.url,
      category: 'energy'
    });
  }

  const marketGas = state.energyMarket?.gas;
  const gas = pickFirst('energy-eia-ng');
  if (marketGas?.value || gas?.value) {
    const sourceItem = marketGas?.value ? marketGas : gas;
    const meta = marketGas?.value
      ? (marketGas.asOf ? `Market ${marketGas.asOf}` : 'Market')
      : gas.summary.split(':')[0];
    kpis.push({
      label: 'Nat Gas',
      value: formatCompactCurrency(sourceItem.value),
      meta,
      delta: Number.isFinite(sourceItem.delta ?? sourceItem.deltaPct) ? (sourceItem.delta ?? sourceItem.deltaPct) : null,
      source: sourceItem.source || (marketGas?.value ? 'Stooq' : gas.source),
      url: sourceItem.url || gas.url,
      category: 'energy'
    });
  }

  const marketGold = state.energyMarket?.gold;
  if (marketGold?.value) {
    kpis.push({
      label: 'Gold',
      value: formatCompactCurrency(marketGold.value),
      meta: marketGold.asOf ? `Market ${marketGold.asOf}` : 'Market',
      delta: Number.isFinite(marketGold.delta) ? marketGold.delta : null,
      source: marketGold.source || 'Stooq',
      url: marketGold.url,
      category: 'finance'
    });
  }

  const globalCap = pickFirst('coinpaprika-global');
  if (globalCap?.value) {
    kpis.push({
      label: 'Crypto Mkt Cap',
      value: formatCompactCurrency(globalCap.value),
      meta: globalCap.dominance ? `BTC Dom ${globalCap.dominance.toFixed(2)}%` : '',
      source: globalCap.source,
      url: globalCap.url,
      category: 'crypto'
    });
  }

  const btc = pickCoin('BTC');
  if (btc?.value) {
    kpis.push({
      label: 'Bitcoin',
      value: formatCompactCurrency(btc.value),
      delta: Number.isFinite(btc.change24h) ? btc.change24h : null,
      meta: '24h',
      source: btc.source,
      url: btc.url,
      category: 'crypto'
    });
  }

  const eth = pickCoin('ETH');
  if (eth?.value) {
    kpis.push({
      label: 'Ethereum',
      value: formatCompactCurrency(eth.value),
      delta: Number.isFinite(eth.change24h) ? eth.change24h : null,
      meta: '24h',
      source: eth.source,
      url: eth.url,
      category: 'crypto'
    });
  }

  const watchlist = state.settings.tickerWatchlist || [];
  const resolved = new Map();
  state.customTickers.forEach((ticker) => {
    const key = getTickerKey({ type: ticker.type, lookup: ticker.lookup || ticker.symbol || ticker.label || '' });
    resolved.set(key, ticker);
  });
  const custom = watchlist.map((entry) => {
    const key = getTickerKey(entry);
    const ticker = resolved.get(key);
    if (!ticker) {
      return {
        label: entry.label || entry.symbol,
        value: '--',
        meta: 'Awaiting quote',
        delta: null,
        url: entry.url || '',
        category: entry.type === 'crypto' ? 'crypto' : 'finance'
      };
    }
    return {
      label: ticker.label || ticker.symbol,
      value: formatTickerValue(ticker),
      meta: ticker.type === 'crypto' ? '24h' : 'Session',
      delta: Number.isFinite(ticker.delta) ? ticker.delta : null,
      url: ticker.url,
      category: ticker.type === 'crypto' ? 'crypto' : 'finance'
    };
  });

  const seen = new Set();
  const merged = [...custom, ...kpis].filter((entry) => {
    if (!entry.label) return false;
    const key = entry.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return merged;
}

function renderFinanceCards(container, kpis, variant = 'spotlight') {
  if (!container) return;
  container.innerHTML = '';
  kpis.forEach((kpi) => {
    const card = document.createElement('a');
    card.className = `finance-card ${variant}`;
    if (Number.isFinite(kpi.delta)) {
      card.classList.add(kpi.delta >= 0 ? 'up' : 'down');
    }
    if (kpi.url) {
      card.href = kpi.url;
      card.target = '_blank';
      card.rel = 'noopener';
    }
    const label = document.createElement('div');
    label.className = 'finance-label';
    label.textContent = kpi.label;
    const value = document.createElement('div');
    value.className = 'finance-value';
    value.textContent = kpi.value || '--';
    const meta = document.createElement('div');
    meta.className = 'finance-meta';
    const deltaText = Number.isFinite(kpi.delta) ? `${kpi.delta > 0 ? '+' : ''}${kpi.delta.toFixed(2)}%` : '';
    meta.textContent = [kpi.meta, deltaText].filter(Boolean).join(' • ');
    card.appendChild(label);
    card.appendChild(value);
    card.appendChild(meta);
    container.appendChild(card);
  });
}

function renderFinanceSpotlight() {
  if (!elements.financeSpotlight) return;
  const kpis = buildFinanceKPIs().slice(0, 8);
  renderFinanceCards(elements.financeSpotlight, kpis, 'spotlight');
}

function extractLocationCandidates(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.replace(/https?:\/\/\S+/g, '');
  const candidates = new Set();

  const travelMatch = (item.title || '').match(/Travel Advisory\s*[-–]\s*([A-Za-z\s.'-]+)/i);
  if (travelMatch) {
    candidates.add(travelMatch[1].trim());
  }

  const commaMatch = text.match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}),\s*([A-Z]{2})/);
  if (commaMatch) {
    candidates.add(`${commaMatch[1]}, ${commaMatch[2]}`);
  }

  const dashMatch = (item.title || '').match(/-\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})$/);
  if (dashMatch) {
    candidates.add(dashMatch[1]);
  }

  const locationRegex = /\b(?:in|near|at|outside|north of|south of|east of|west of)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/g;
  let match;
  while ((match = locationRegex.exec(text)) !== null) {
    candidates.add(match[1]);
  }

  return [...candidates].filter(Boolean);
}

async function geocodeItems(items, maxItems = 12) {
  const eligible = items.filter((item) => item && !item.geo && item.category !== 'crypto' && item.category !== 'finance');
  const seen = new Set();
  let updated = false;

  for (const item of eligible.slice(0, maxItems)) {
    const candidates = extractLocationCandidates(item);
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const cached = state.geoCache[key];
      if (cached) {
        if (!cached.notFound && cached.lat) {
          item.geo = { lat: cached.lat, lon: cached.lon };
          item.geoLabel = cached.displayName || candidate;
          updated = true;
          break;
        }
        continue;
      }

      try {
        const { data: payload, error } = await apiJson(`/api/geocode?q=${encodeURIComponent(candidate)}`);
        if (error || !payload) {
          state.geoCache[key] = { query: candidate, notFound: true };
          saveGeoCache();
          continue;
        }
        state.geoCache[key] = payload;
        saveGeoCache();
        if (!payload.notFound && payload.lat) {
          item.geo = { lat: payload.lat, lon: payload.lon };
          item.geoLabel = payload.displayName || candidate;
          updated = true;
          break;
        }
      } catch (err) {
        state.geoCache[key] = { query: candidate, notFound: true };
        saveGeoCache();
      }
    }
  }

  return updated;
}

async function fetchFeed(feed, query, force = false) {
  if (feed.isCustom) {
    return fetchCustomFeedDirect(feed, query);
  }
  const params = new URLSearchParams();
  params.set('id', feed.id);
  if (query) params.set('query', query);
  if (force) params.set('force', '1');
  const keyConfig = getKeyConfig(feed);
  if (keyConfig.key) {
    params.set('key', keyConfig.key);
    if (keyConfig.keyParam) params.set('keyParam', keyConfig.keyParam);
    if (keyConfig.keyHeader) params.set('keyHeader', keyConfig.keyHeader);
  }
  try {
    const res = await apiFetch(`/api/feed?${params.toString()}`);
    const payload = await res.json();
    const items = payload.error ? [] : (feed.format === 'rss' ? parseRss(payload.body, feed) : parseJson(payload.body, feed));
    const enriched = items.map((item) => ({ ...item, tags: feed.tags || [], feedId: feed.id, feedName: feed.name }));
    return {
      feed,
      items: enriched,
      error: payload.error,
      errorMessage: payload.message,
      httpStatus: payload.httpStatus,
      fetchedAt: payload.fetchedAt
    };
  } catch (err) {
    return {
      feed,
      items: [],
      error: 'fetch_failed',
      errorMessage: err.message,
      httpStatus: 0,
      fetchedAt: Date.now()
    };
  }
}

function applyCustomProxy(url, proxy) {
  if (!proxy) return url;
  if (Array.isArray(proxy)) {
    return applyCustomProxy(url, proxy[0]);
  }
  if (proxy === 'allorigins') {
    return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  }
  if (proxy === 'jina') {
    const stripped = url.replace(/^https?:\/\//, '');
    return `https://r.jina.ai/http://${stripped}`;
  }
  return url;
}

function shouldFetchLiveInStatic(feed) {
  if (!isStaticMode() || !state.settings.superMonitor) return false;
  if (feed.keySource === 'server') return false;
  if (feed.requiresKey) {
    const keyConfig = getKeyConfig(feed);
    if (!keyConfig.key) return false;
  }
  return true;
}

function applyQueryToUrl(url, query) {
  if (!query) return url;
  if (url.includes('{{query}}')) {
    return url.replaceAll('{{query}}', encodeURIComponent(query));
  }
  const parsed = new URL(url);
  parsed.searchParams.set('q', query);
  return parsed.toString();
}

async function fetchCustomFeedDirect(feed, query) {
  const keyConfig = getKeyConfig(feed);
  let url = applyQueryToUrl(feed.url, feed.supportsQuery ? (query || feed.defaultQuery || '') : '');
  if (keyConfig.key && keyConfig.keyParam) {
    const parsed = new URL(url);
    parsed.searchParams.set(keyConfig.keyParam, keyConfig.key);
    url = parsed.toString();
  }

  const headers = {};
  if (keyConfig.key && keyConfig.keyHeader) {
    headers[keyConfig.keyHeader] = keyConfig.key;
  }

  try {
    const proxyList = Array.isArray(feed.proxy) ? feed.proxy : (feed.proxy ? [feed.proxy] : []);
    const candidates = [url, ...proxyList.map((proxy) => applyCustomProxy(url, proxy))];
    let lastResponse = null;
    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(candidate, { headers });
        lastResponse = response;
        if (!response.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        const body = await response.text();
        const items = feed.format === 'rss' ? parseRss(body, feed) : parseJson(body, feed);
        const enriched = items.map((item) => ({ ...item, tags: feed.tags || [], feedId: feed.id, feedName: feed.name }));
        return {
          feed,
          items: enriched,
          error: null,
          errorMessage: null,
          httpStatus: response.status,
          fetchedAt: Date.now()
        };
      } catch (err) {
        // try next candidate
      }
    }
    const body = lastResponse ? await lastResponse.text() : '';
    const items = lastResponse && lastResponse.ok
      ? (feed.format === 'rss' ? parseRss(body, feed) : parseJson(body, feed))
      : [];
    const enriched = items.map((item) => ({ ...item, tags: feed.tags || [], feedId: feed.id, feedName: feed.name }));
    return {
      feed,
      items: enriched,
      error: lastResponse?.ok ? null : (lastResponse ? `http_${lastResponse.status}` : 'fetch_failed'),
      errorMessage: lastResponse?.ok ? null : (lastResponse ? `HTTP ${lastResponse.status}` : 'fetch failed'),
      httpStatus: lastResponse?.status || 0,
      fetchedAt: Date.now()
    };
  } catch (err) {
    return {
      feed,
      items: [],
      error: 'fetch_failed',
      errorMessage: err.message,
      httpStatus: 0,
      fetchedAt: Date.now()
    };
  }
}

function translateQuery(feed, query) {
  if (!feed || !query) return query;
  if (feed.id === 'gdelt-doc') {
    return query;
  }
  if (feed.id.startsWith('google-news')) {
    return query.includes('when:') ? query : `${query} when:1d`;
  }
  return query;
}

function getLiveSearchFeeds() {
  const ids = new Set(['gdelt-doc', 'google-news-search']);
  return state.feeds.filter((feed) => {
    if (!feed || !feed.supportsQuery) return false;
    if (feed.requiresKey || feed.keyParam || feed.keyHeader || feed.requiresConfig) return false;
    if (feed.isCustom) return false;
    return ids.has(feed.id) || (feed.tags || []).includes('search');
  });
}

async function translateQueryAsync(feed, query) {
  if (!feed || !query) return query;
  if (!state.settings.aiTranslate || !state.keys.openai?.key) {
    return translateQuery(feed, query);
  }
  try {
    const prompt = `Translate this search query for the feed "${feed.name}". Keep it short and compatible with the feed. Return only the final query string. Original: ${query}`;
    const response = await callAssistant({
      messages: [{ role: 'user', content: prompt }],
      context: { feed: { id: feed.id, name: feed.name, url: feed.url } },
      temperature: 0
    });
    const cleaned = (response || '').split('\n')[0].replace(/^\"|\"$/g, '').trim();
    return cleaned || translateQuery(feed, query);
  } catch (err) {
    return translateQuery(feed, query);
  }
}

function toRelativeTime(timestamp) {
  const delta = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(delta / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function ensurePanelUpdateBadges() {
  document.querySelectorAll('.panel[data-panel]').forEach((panel) => {
    if (panel.dataset.noUpdate) return;
    const panelId = panel.dataset.panel;
    const existing = panel.querySelector(`[data-panel-update="${panelId}"]`);
    if (existing) return;
    const header = panel.querySelector('.panel-header > div');
    if (!header) return;
    const badge = document.createElement('div');
    badge.className = 'panel-updated';
    badge.dataset.panelUpdate = panelId;
    badge.textContent = 'Updated --';
    header.appendChild(badge);
  });
}

function getLatestTimestamp(items) {
  if (!items || !items.length) return null;
  return items.reduce((max, item) => Math.max(max, item.publishedAt || 0), 0) || null;
}

function getLatestFeedTimestamp(categories) {
  const feeds = state.feeds.filter((feed) => categories.includes(feed.category));
  const stamps = feeds.map((feed) => state.feedStatus[feed.id]?.fetchedAt).filter(Boolean);
  if (!stamps.length) return null;
  return Math.max(...stamps);
}

function getPanelTimestamp(panelId) {
  const latestFromCategories = (categories) => {
    const scoped = state.scopedItems.filter((item) => categories.includes(item.category));
    const scopedStamp = getLatestTimestamp(scoped);
    if (scopedStamp) return scopedStamp;
    const global = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => categories.includes(item.category));
    const globalStamp = getLatestTimestamp(global);
    if (globalStamp) return globalStamp;
    return getLatestFeedTimestamp(categories) || state.lastFetch || null;
  };

  switch (panelId) {
    case 'map':
      return getLatestTimestamp(getMapItems()) || state.lastFetch || null;
    case 'ticker':
    case 'finance-spotlight':
      return latestFromCategories(['finance', 'crypto', 'energy']);
    case 'command':
    case 'signals':
      return state.lastFetch || null;
    case 'news': {
      const clusterStamp = state.clusters.reduce((max, cluster) => Math.max(max, cluster.updatedAt || 0), 0);
      return clusterStamp || getLatestFeedTimestamp(['news']) || state.lastFetch || null;
    }
    case 'finance':
      return latestFromCategories(['finance', 'energy', 'gov', 'cyber', 'agriculture']);
    case 'crypto':
      return latestFromCategories(['crypto']);
    case 'prediction':
      return latestFromCategories(['prediction']);
    case 'hazards':
      return latestFromCategories(['disaster', 'weather', 'space']);
    case 'local':
      return getLatestTimestamp(getLocalItems()) || state.lastFetch || null;
    case 'policy':
      return latestFromCategories(['gov']);
    case 'cyber':
      return latestFromCategories(['cyber']);
    case 'agriculture':
      return latestFromCategories(['agriculture']);
    case 'research':
      return latestFromCategories(['research']);
    case 'space':
      return latestFromCategories(['space']);
    case 'energy':
      return latestFromCategories(['energy']);
    case 'energy-map':
      return latestFromCategories(['energy']);
    case 'health':
      return latestFromCategories(['health']);
    case 'transport':
      return latestFromCategories(['transport']);
    default:
      return state.lastFetch || null;
  }
}

function updatePanelTimestamps() {
  ensurePanelUpdateBadges();
  document.querySelectorAll('.panel-updated[data-panel-update]').forEach((el) => {
    const panelId = el.dataset.panelUpdate;
    const stamp = getPanelTimestamp(panelId);
    el.textContent = stamp ? `Updated ${toRelativeTime(stamp)}` : 'Updated --';
  });
}

function isNonEnglish(text = '') {
  if (!text) return false;
  const nonLatinRegex = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u1100-\u11FF\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
  return nonLatinRegex.test(text);
}

function applyLanguageFilter(items) {
  if (state.settings.languageMode === 'all') return items;
  if (state.settings.languageMode === 'translate') {
    if (!state.keys.openai?.key) {
      return items.filter((item) => !item.isNonEnglish);
    }
    return items;
  }
  return items.filter((item) => !item.isNonEnglish);
}

function applyFreshnessFilter(items) {
  const cutoff = Date.now() - state.settings.maxAgeDays * 24 * 60 * 60 * 1000;
  return items.filter((item) => (item.publishedAt || Date.now()) >= cutoff);
}

function buildTickerItems() {
  const fresh = applyFreshnessFilter(state.items);
  const eligible = applyLanguageFilter(fresh);
  const byFeed = (id) => eligible.filter((item) => item.feedId === id);
  const pickFirst = (id) => byFeed(id)[0];
  const pickFirstFrom = (ids) => ids.map((id) => pickFirst(id)).find(Boolean);
  const pickSymbol = (symbol) => byFeed('coinpaprika-tickers').find((item) => item.title?.includes(`(${symbol})`));
  const parseChange = (item) => {
    if (!item?.summary) return null;
    const match = item.summary.match(/24h\s+(-?\d+(?:\.\d+)?)%/i);
    if (!match) return null;
    return Number(match[1]);
  };

  const items = [];
  buildCustomTickerItems().forEach((custom) => items.push(custom));
  const marketWti = state.energyMarket?.wti;
  const marketGas = state.energyMarket?.gas;
  const pushMarket = (entry, label) => {
    if (!entry?.value) return;
    const valueText = formatCompactCurrency(entry.value);
    const meta = entry.asOf ? `Market ${entry.asOf}` : 'Market';
    items.push({
      text: `${label}: ${valueText} • ${meta}`,
      url: entry.url,
      change: Number.isFinite(entry.delta) ? entry.delta : null
    });
  };
  pushMarket(marketWti, 'WTI Crude');
  pushMarket(marketGas, 'Nat Gas');
  const pushItem = (item, fallbackTitle) => {
    if (!item) return;
    const title = item.translatedTitle || item.title || fallbackTitle;
    const summary = item.summary || '';
    items.push({
      text: summary ? `${title} • ${summary}` : title,
      url: item.url,
      change: parseChange(item)
    });
  };

  pushItem(pickFirst('treasury-debt'), 'US Debt');
  pushItem(pickFirst('bls-cpi'), 'US CPI');
  if (!marketWti?.value) pushItem(pickFirst('energy-eia'), 'WTI Crude');
  pushItem(pickFirst('energy-eia-brent'), 'Brent Crude');
  if (!marketGas?.value) pushItem(pickFirst('energy-eia-ng'), 'Nat Gas');
  pushItem(pickFirst('coinpaprika-global'), 'Crypto Market Cap');
  ['BTC', 'ETH'].forEach((symbol) => pushItem(pickSymbol(symbol), symbol));
  pushItem(pickFirst('blockstream-mempool'), 'Bitcoin Mempool');

  const seen = new Set();
  return items.filter((item) => {
    const key = (item.text || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderTicker() {
  if (!elements.tickerTrack || !elements.tickerBar) return;
  const tickerItems = buildTickerItems();
  elements.tickerTrack.innerHTML = '';
  if (!tickerItems.length) {
    elements.tickerBar.classList.add('empty');
    elements.tickerTrack.textContent = 'No market signals yet.';
    return;
  }
  elements.tickerBar.classList.remove('empty');
  const group = document.createElement('div');
  group.className = 'ticker-group';
  tickerItems.forEach((item) => {
    const el = document.createElement(item.url ? 'a' : 'span');
    el.className = 'ticker-item';
    if (typeof item.change === 'number') {
      el.classList.add(item.change >= 0 ? 'up' : 'down');
    }
    el.textContent = item.text;
    if (item.url) {
      el.href = item.url;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    group.appendChild(el);
  });
  const clone = group.cloneNode(true);
  elements.tickerTrack.appendChild(group);
  elements.tickerTrack.appendChild(clone);
}

async function translateItem(item, titleEl, summaryEl) {
  if (!state.keys.openai?.key) return;
  if (!item || !item.isNonEnglish) return;
  const key = `${item.title}|${item.summary}`;
  if (state.translationCache[key]) {
    const cached = state.translationCache[key];
    if (cached.title && titleEl) titleEl.textContent = cached.title;
    return;
  }
  if (state.translationInFlight.has(key) || state.translationInFlight.size > 4) return;
  state.translationInFlight.add(key);
  try {
    const prompt = `Translate the following title to English. Return only the translated title.\nTitle: ${item.title}`;
    const response = await callAssistant({
      messages: [{ role: 'user', content: prompt }],
      context: { mode: 'translate' },
      temperature: 0
    });
    const translated = {
      title: (response || item.title || '').trim()
    };
    state.translationCache[key] = translated;
    if (translated.title && titleEl) titleEl.textContent = translated.title;
  } catch (err) {
    // Ignore translation failures.
  } finally {
    state.translationInFlight.delete(key);
  }
}

function getDomain(url) {
  if (!url) return '';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname;
  } catch (err) {
    return '';
  }
}

const tier1Domains = new Set([
  'reuters.com', 'apnews.com', 'bloomberg.com', 'wsj.com', 'nytimes.com',
  'ft.com', 'bbc.com', 'theguardian.com', 'washingtonpost.com', 'npr.org',
  'economist.com', 'aljazeera.com', 'cnn.com', 'foxnews.com', 'forbes.com',
  'wsj.com', 'nationalgeographic.com', 'nature.com', 'sciencemag.org'
]);
const tier2Domains = new Set([
  'yahoo.com', 'finance.yahoo.com', 'cnbc.com', 'axios.com', 'politico.com',
  'thehill.com', 'time.com', 'usatoday.com', 'abcnews.go.com', 'nbcnews.com',
  'cbsnews.com', 'newsweek.com', 'businessinsider.com', 'marketwatch.com'
]);

function getCredibilityTier(item) {
  const domain = getDomain(item.url || '');
  if (!domain) return null;
  if (domain.endsWith('.gov') || domain.endsWith('.mil') || domain.endsWith('.edu')) {
    return { label: 'Tier 1', className: 'tier-1' };
  }
  if (tier1Domains.has(domain)) return { label: 'Tier 1', className: 'tier-1' };
  if (tier2Domains.has(domain)) return { label: 'Tier 2', className: 'tier-2' };
  return { label: 'Tier 3', className: 'tier-3' };
}

function getTrendLabel(item) {
  if (!item.coverage) return null;
  const ageMinutes = (Date.now() - (item.publishedAt || Date.now())) / 60000;
  if (item.coverage >= 6 && ageMinutes < 120) return 'Spiking';
  if (item.coverage >= 4) return 'Broad';
  if (ageMinutes < 60) return 'Fresh';
  return null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInline(text) {
  let value = escapeHtml(text);
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/_([^_]+)_/g, '<em>$1</em>');
  value = value.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return value;
}

function formatBriefingText(text) {
  const cleanedText = String(text || '').replace(/```[\s\S]*?```/g, '').trim();
  const lines = cleanedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let html = '';
  let listType = null;
  lines.forEach((line) => {
    const unordered = /^[-*•‣–—]\s*/.test(line);
    const ordered = /^\d+[.)]\s+/.test(line);
    if (unordered || ordered) {
      const type = ordered ? 'ol' : 'ul';
      if (listType && listType !== type) {
        html += `</${listType}>`;
        listType = null;
      }
      if (!listType) {
        listType = type;
        html += `<${type}>`;
      }
      const content = line.replace(/^[-*•‣–—]\s*/, '').replace(/^\d+[.)]\s+/, '');
      html += `<li>${formatInline(content)}</li>`;
      return;
    }
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
    const heading = /^(#{1,3})\s+(.+)/.exec(line);
    if (heading) {
      html += `<div class="analysis-heading">${formatInline(heading[2])}</div>`;
      return;
    }
    const labelMatch = /^([A-Z][A-Za-z0-9 &/.-]{2,}):\s*(.+)$/.exec(line);
    if (labelMatch) {
      html += `<p><strong>${formatInline(labelMatch[1])}:</strong> ${formatInline(labelMatch[2])}</p>`;
      return;
    }
    html += `<p>${formatInline(line)}</p>`;
  });
  if (listType) {
    html += `</${listType}>`;
  }
  return html || `<p>${formatInline(text)}</p>`;
}

function setAnalysisOutput(text) {
  if (!elements.analysisBody) return;
  elements.analysisBody.innerHTML = formatBriefingText(text);
}

function getAnalysisSignature() {
  const items = state.scopedItems.length ? state.scopedItems : state.items;
  let latest = 0;
  items.forEach((item) => {
    const ts = new Date(item.publishedAt || item.updatedAt || 0).getTime();
    if (Number.isFinite(ts)) latest = Math.max(latest, ts);
  });
  return [
    items.length,
    latest,
    state.clusters.length,
    state.lastFetch || 0,
    state.lastBuildAt || 0,
    state.settings.scope,
    state.settings.radiusKm,
    state.settings.languageMode
  ].join('|');
}

function maybeAutoRunAnalysis() {
  const signature = getAnalysisSignature();
  if (signature === state.analysisSignature) return;
  state.analysisSignature = signature;
  if (state.keys.openai?.key) {
    runAiAnalysis({ emitChat: false, auto: true });
  } else {
    generateAnalysis(false);
  }
}

function getDistanceKm(item) {
  if (!item.geo) return null;
  const { lat, lon } = state.location;
  return haversineKm(lat, lon, item.geo.lat, item.geo.lon);
}

function extractRegionFromText(text) {
  if (!text) return '';
  const upper = text.toUpperCase();
  if (upper.includes('UNITED STATES') || upper.includes('U.S.') || upper.includes('USA')) {
    return 'US';
  }
  if (upper.includes('GLOBAL')) return 'Global';
  const stateMatches = upper.match(/\b[A-Z]{2}\b/g) || [];
  const state = stateMatches.find((code) => usStateCodes.has(code));
  if (state) return state;
  if (text.includes(',')) {
    const tail = text.split(',').pop().trim();
    if (tail && tail.length <= 24) return tail;
  }
  return '';
}

function extractTravelRegion(title = '') {
  if (/global/i.test(title)) return 'Global';
  const match = title.match(/\bin\s+([A-Za-z][A-Za-z\s.-]+)/i);
  if (match) return match[1].trim();
  return '';
}

function extractTravelLevel(title = '') {
  const match = title.match(/Level\s*(\d)/i);
  return match ? `Level ${match[1]}` : '';
}

function enrichItem(item) {
  const enriched = { ...item };
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();

  if (item.category === 'travel') {
    enriched.alertType = enriched.alertType || 'Travel Notice';
    const level = extractTravelLevel(item.title || '');
    if (level && !enriched.severity) enriched.severity = level;
    const region = extractTravelRegion(item.title || '');
    if (region) enriched.regionTag = region;
    if (/dengue|chikungunya|zika|malaria/.test(text)) enriched.hazardType = 'Mosquito-borne';
    else if (/rabies/.test(text)) enriched.hazardType = 'Zoonotic';
    else if (/rmsf|rocky mountain spotted fever|tick/.test(text)) enriched.hazardType = 'Tick-borne';
    else if (/cholera|diarrhea/.test(text)) enriched.hazardType = 'Waterborne';
    else if (/measles|respiratory/.test(text)) enriched.hazardType = 'Respiratory';
  }

  if (item.category === 'health' && !enriched.alertType) {
    if (/recall/.test(text)) enriched.alertType = 'Recall';
    else if (/outbreak|cases/.test(text)) enriched.alertType = 'Outbreak';
    else if (/advisory/.test(text)) enriched.alertType = 'Advisory';
    else if (/alert/.test(text)) enriched.alertType = 'Alert';
  }

  if (item.category === 'cyber' && !enriched.alertType) {
    if (/cve-\\d{4}-\\d+/i.test(item.title || '')) enriched.alertType = 'Vulnerability';
  }

  if (item.category === 'research') {
    if (/arxiv/i.test(item.source || '')) {
      const rawTopic = (item.source || '').replace(/arxiv/i, '').replace(/[()]/g, '').trim();
      enriched.topicTag = rawTopic || 'arXiv';
      const match = (item.url || '').match(/v(\\d+)$/);
      if (match && Number(match[1]) > 1) {
        enriched.alertType = 'Updated';
      } else {
        enriched.alertType = 'New';
      }
    }
  }

  if (item.category === 'news' && item.url) {
    const tier = getCredibilityTier(item);
    if (tier) enriched.credibility = tier.label;
  }

  if (!enriched.regionTag) {
    const region = extractRegionFromText(item.location || item.geoLabel || '');
    if (region) enriched.regionTag = region;
    else if (item.tags?.includes('us')) enriched.regionTag = 'US';
    else if (item.tags?.includes('global')) enriched.regionTag = 'Global';
  }

  return enriched;
}

const badgePriorityBase = {
  alertType: 10,
  severity: 20,
  hazardType: 30,
  deadline: 40,
  regionTag: 50,
  distance: 60,
  delta: 70,
  trend: 80,
  credibility: 90,
  topicTag: 100
};

const badgePriorityOverrides = {
  news: { alertType: 8, severity: 12, hazardType: 16, regionTag: 20, trend: 30, credibility: 40 },
  local: { distance: 5, alertType: 10, severity: 14, hazardType: 18, regionTag: 22 },
  travel: { severity: 5, hazardType: 8, regionTag: 12, alertType: 16 },
  research: { topicTag: 5, alertType: 10 },
  financeMarkets: { delta: 5, trend: 10, alertType: 20, severity: 24, regionTag: 28 },
  financePolicy: { alertType: 5, deadline: 10, regionTag: 16, severity: 20 },
  policy: { alertType: 5, deadline: 10, regionTag: 16, severity: 20 },
  cyber: { alertType: 5, severity: 10, deadline: 14, regionTag: 18 },
  health: { alertType: 5, severity: 10, hazardType: 14, regionTag: 18 },
  disaster: { severity: 5, alertType: 10, hazardType: 14, regionTag: 18 },
  crypto: { delta: 5, trend: 10, regionTag: 20 },
  energy: { delta: 5, trend: 10, alertType: 16 },
  transport: { alertType: 8, severity: 12, regionTag: 16 },
  agriculture: { alertType: 8, severity: 12, regionTag: 16 }
};

function resolveBadgeContext(contextId, item) {
  const map = {
    newsList: 'news',
    financeMarketsList: 'financeMarkets',
    financePolicyList: 'financePolicy',
    policyList: 'policy',
    cryptoList: 'crypto',
    disasterList: 'disaster',
    localList: 'local',
    cyberList: 'cyber',
    agricultureList: 'agriculture',
    researchList: 'research',
    spaceList: 'space',
    energyList: 'energy',
    healthList: 'health',
    transportList: 'transport'
  };
  if (contextId === 'searchResultsList') {
    const category = item.category === 'gov' ? 'policy' : item.category;
    return category || 'default';
  }
  return map[contextId] || (item.category === 'gov' ? 'policy' : item.category) || 'default';
}

function getBadgePriority(context, key) {
  const override = badgePriorityOverrides[context] || {};
  if (Object.prototype.hasOwnProperty.call(override, key)) return override[key];
  if (Object.prototype.hasOwnProperty.call(badgePriorityBase, key)) return badgePriorityBase[key];
  return 999;
}

function buildListBadges(item, contextId) {
  const context = resolveBadgeContext(contextId, item);
  const badges = [];
  const pushBadge = (key, label, className) => {
    badges.push({
      label,
      className,
      priority: getBadgePriority(context, key),
      order: badges.length
    });
  };

  if (item.category === 'news') {
    const tier = getCredibilityTier(item);
    if (tier) pushBadge('credibility', tier.label, `chip-badge ${tier.className}`);
    const trend = getTrendLabel(item);
    if (trend) pushBadge('trend', trend, 'chip-badge trend');
  }
  if (item.alertType) pushBadge('alertType', item.alertType, 'chip-badge alert');
  if (item.severity) pushBadge('severity', item.severity, 'chip-badge severity');
  if (Number.isFinite(item.delta)) {
    const deltaText = item.delta > 0 ? `+${formatNumber(item.delta)}` : formatNumber(item.delta);
    const unit = item.unit ? ` ${item.unit}` : '';
    pushBadge('delta', `Δ ${deltaText}${unit}`, 'chip-badge trend');
  }
  if (item.hazardType) pushBadge('hazardType', item.hazardType, 'chip-badge hazard');
  if (item.deadline) pushBadge('deadline', `Due ${formatShortDate(item.deadline)}`, 'chip-badge deadline');
  if (item.regionTag) pushBadge('regionTag', item.regionTag, 'chip-badge region');
  if (context === 'local') {
    const distance = getDistanceKm(item);
    if (Number.isFinite(distance)) {
      pushBadge('distance', `${Math.round(distance)} km`, 'chip-badge distance');
    }
  }
  if (item.topicTag) pushBadge('topicTag', item.topicTag, 'chip-badge topic');

  return badges
    .sort((a, b) => (a.priority - b.priority) || (a.order - b.order))
    .slice(0, 4);
}

function renderList(container, items, { withCoverage = false, append = false } = {}) {
  if (!container) return;
  if (!append) {
    container.innerHTML = '';
  }
  if (!items.length) {
    if (!append) {
      container.innerHTML = '<div class="list-item">No signals yet.</div>';
    }
    return;
  }
  let rendered = 0;
  const contextId = container?.dataset?.listContext || container?.id || '';
  items.forEach((item) => {
    if (state.settings.languageMode === 'en' && item.isNonEnglish) return;
    const div = document.createElement('div');
    div.className = 'list-item';

    const title = document.createElement(item.url ? 'a' : 'div');
    title.className = 'list-title';
    title.textContent = item.translatedTitle || item.title;
    if (item.url) {
      title.href = item.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.innerHTML = `<span>${item.source || 'Source'}</span><span>${toRelativeTime(item.publishedAt || Date.now())}</span>`;

    if (withCoverage && item.coverage) {
      const coverage = document.createElement('div');
      coverage.className = 'list-coverage';
      const dots = Array.from({ length: Math.min(item.coverage, 6) }).map(() => '<span class="cover-dot"></span>').join('');
      const extra = item.coverage - Math.min(item.coverage, 6);
      coverage.innerHTML = extra > 0 ? `${dots} <span>+${extra}</span>` : dots;
      meta.appendChild(coverage);
    }

    const badges = buildListBadges(item, contextId);
    if (badges.length) {
      const badgeRow = document.createElement('div');
      badgeRow.className = 'list-badges';
      badges.forEach((badge) => {
        const el = document.createElement('span');
        el.className = badge.className;
        el.textContent = badge.label;
        badgeRow.appendChild(el);
      });
      div.appendChild(badgeRow);
    }

    const summary = document.createElement('div');
    summary.className = 'list-summary';
    const isNewsList = contextId === 'newsList';
    const rawSummaryText = stripHtml(item.summaryHtml || item.summary || '').trim();
    if (isNewsList) {
      const baseText = item.translatedSummary || rawSummaryText;
      summary.textContent = truncateText(baseText, 240);
    } else if (item.summaryHtml) {
      summary.innerHTML = sanitizeHtml(item.summaryHtml);
    } else {
      summary.textContent = item.translatedSummary || rawSummaryText;
    }

    div.appendChild(title);
    div.appendChild(meta);
    const shouldShowSummary = Boolean(item.summary || item.summaryHtml)
      && !(state.settings.languageMode === 'translate' && item.isNonEnglish);
    if (shouldShowSummary) div.appendChild(summary);
    container.appendChild(div);
    rendered += 1;

    if (state.settings.languageMode === 'translate' && item.isNonEnglish) {
      translateItem(item, title, summary);
    }
  });
  if (!rendered && !append) {
    container.innerHTML = '<div class="list-item">No signals yet.</div>';
  }
}

function renderNews(clusters) {
  const items = buildNewsItems(clusters);
  const limit = Math.min(getListLimit(elements.newsList?.id), items.length);
  renderList(elements.newsList, items.slice(0, limit), { withCoverage: true });
}

function renderSignals() {
  const totalItems = state.scopedItems.length;
  const newsClusters = state.clusters.length;
  const localItems = getLocalItems();
  const marketSignals = applyLanguageFilter(applyFreshnessFilter(state.items))
    .filter((item) => item.category === 'crypto' || item.category === 'finance');

  const previous = state.previousSignals;
  const formatDelta = (value, prev) => {
    if (prev === null || prev === undefined) return '';
    const diff = value - prev;
    if (!diff) return '';
    return diff > 0 ? `• +${diff}` : `• ${diff}`;
  };

  elements.globalActivity.textContent = totalItems ? totalItems : '--';
  elements.globalActivityMeta.textContent = totalItems
    ? `Signals ingested: ${totalItems} ${formatDelta(totalItems, previous?.totalItems)}`.trim()
    : 'Awaiting signals';

  if (elements.summaryGlobalActivity) {
    elements.summaryGlobalActivity.textContent = totalItems ? totalItems : '--';
    elements.summaryGlobalActivityMeta.textContent = totalItems
      ? `Signals ingested: ${totalItems} ${formatDelta(totalItems, previous?.totalItems)}`.trim()
      : 'Awaiting signals';
  }

  elements.newsSaturation.textContent = newsClusters ? newsClusters : '--';
  elements.newsSaturationMeta.textContent = newsClusters
    ? `Clusters across sources ${formatDelta(newsClusters, previous?.newsClusters)}`.trim()
    : 'No clusters yet';

  if (elements.summaryNewsSaturation) {
    elements.summaryNewsSaturation.textContent = newsClusters ? newsClusters : '--';
    elements.summaryNewsSaturationMeta.textContent = newsClusters
      ? `Clusters across sources ${formatDelta(newsClusters, previous?.newsClusters)}`.trim()
      : 'No clusters yet';
  }

  elements.localEvents.textContent = localItems.length ? localItems.length : '--';
  elements.localEventsMeta.textContent = localItems.length
    ? (state.location.source === 'geo'
      ? `Within local radius ${formatDelta(localItems.length, previous?.localItems)}`
      : `Fallback region ${formatDelta(localItems.length, previous?.localItems)}`)
    : 'No local signals yet';

  if (elements.summaryLocalEvents) {
    elements.summaryLocalEvents.textContent = localItems.length ? localItems.length : '--';
    elements.summaryLocalEventsMeta.textContent = localItems.length
      ? (state.location.source === 'geo'
        ? `Within local radius ${formatDelta(localItems.length, previous?.localItems)}`
        : `Fallback region ${formatDelta(localItems.length, previous?.localItems)}`)
      : 'No local signals yet';
  }

  const marketCount = marketSignals.length;
  elements.marketPulse.textContent = marketCount ? marketCount : '--';
  elements.marketPulseMeta.textContent = marketCount
    ? `Markets + macro feeds ${formatDelta(marketCount, previous?.marketCount)}`.trim()
    : 'No market signals yet';

  if (elements.summaryMarketPulse) {
    elements.summaryMarketPulse.textContent = marketCount ? marketCount : '--';
    elements.summaryMarketPulseMeta.textContent = marketCount
      ? `Markets + macro feeds ${formatDelta(marketCount, previous?.marketCount)}`.trim()
      : 'No market signals yet';
  }

  if (elements.signalHealthChip) {
    const degraded = criticalFeedIds
      .map((id) => state.feedStatus[id])
      .filter((status) => status && status.error && status.error !== 'requires_key' && status.error !== 'requires_config' && status.error !== 'missing_server_key');
    if (degraded.length) {
      elements.signalHealthChip.textContent = `Feed Health: Degraded (${degraded.length})`;
      elements.signalHealthChip.classList.add('degraded');
      elements.signalHealthChip.classList.remove('healthy');
    } else {
      elements.signalHealthChip.textContent = 'Feed Health: Healthy';
      elements.signalHealthChip.classList.add('healthy');
      elements.signalHealthChip.classList.remove('degraded');
    }
  }

  state.previousSignals = {
    totalItems,
    newsClusters,
    localItems: localItems.length,
    marketCount
  };
}

function buildNewsItems(clusters) {
  return clusters.map((cluster, index) => ({
    title: cluster.primary.title,
    source: Array.from(cluster.sources).slice(0, 2).join(', '),
    summary: index < 3 ? truncateText(stripHtml(cluster.primary.summaryHtml || cluster.primary.summary || ''), 240) : '',
    summaryHtml: '',
    publishedAt: cluster.updatedAt,
    coverage: cluster.sources.size,
    url: cluster.primary.url,
    isNonEnglish: cluster.primary.isNonEnglish
  }));
}

function getLocalItemsForPanel() {
  let items = getLocalItems().filter((item) => !item.mapOnly);
  if (!items.length) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.tags?.includes('us') && !item.mapOnly);
  }
  return items;
}

function getEnergyNewsItems() {
  let items = state.scopedItems.filter((item) => item.feedId === 'eia-today');
  if (!items.length) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.feedId === 'eia-today');
  }
  if (!items.length) {
    items = state.scopedItems.filter((item) => item.category === 'energy');
  }
  if (!items.length) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.category === 'energy');
  }
  return dedupeItems(items);
}

function renderFeedHealth() {
  if (!elements.feedHealth) return;
  if (!Object.keys(state.feedStatus).length) {
    elements.feedHealth.innerHTML = '<div class="settings-note">Fetching feeds...</div>';
    return;
  }
  const entries = state.feeds.map((feed) => {
    const status = state.feedStatus[feed.id] || {};
    const code = status.httpStatus || (status.error ? 'ERR' : 'OK');
    const ok = !status.error && (status.httpStatus ? status.httpStatus < 400 : true);
    return { id: feed.id, name: feed.name, ok, code, error: status.error, message: status.errorMessage };
  });

  const issues = entries.filter((entry) => !entry.ok && entry.error !== 'requires_config');
  if (!issues.length) {
    elements.feedHealth.innerHTML = '<div class="settings-note">All feeds are healthy.</div>';
    return;
  }

  elements.feedHealth.innerHTML = '';
  issues.slice(0, 6).forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'feed-health-row';
    const name = document.createElement('div');
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'feed-health-meta';
    let message = entry.message;
    if (!message && entry.error === 'requires_key') message = 'Missing API key';
    if (!message && entry.error === 'missing_server_key') message = 'Missing server API key';
    meta.textContent = message ? message : (entry.error ? entry.error : `HTTP ${entry.code}`);
    row.appendChild(name);
    row.appendChild(meta);
    elements.feedHealth.appendChild(row);
  });
}

function buildChatContext() {
  return {
    generatedAt: new Date().toISOString(),
    scope: state.settings.scope,
    location: state.location,
    refreshMinutes: state.settings.refreshMinutes,
    signals: {
      totalItems: state.scopedItems.length,
      newsClusters: state.clusters.length,
      localEvents: getLocalItems().length
    },
    topClusters: state.clusters.slice(0, 8).map((cluster) => ({
      title: cluster.primary.title,
      sources: Array.from(cluster.sources),
      updatedAt: cluster.updatedAt,
      url: cluster.primary.url
    })),
    localSignals: getLocalItems().slice(0, 6).map((item) => ({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt,
      url: item.url
    })),
    marketSignals: state.scopedItems.filter((item) => item.category === 'finance' || item.category === 'crypto').slice(0, 6).map((item) => ({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt,
      url: item.url
    }))
  };
}

async function callOpenAIDirect({ messages, context, temperature = 0.2, model } = {}) {
  const key = (state.keys.openai?.key || '').trim();
  if (!key) {
    throw new Error('missing_api_key');
  }
  const payload = {
    model: model || 'gpt-4o-mini',
    input: [
      { role: 'system', content: 'You are an intelligence assistant for a situational awareness dashboard.' },
      ...(Array.isArray(messages) ? messages : [])
    ],
    temperature
  };
  if (context) {
    payload.metadata = { context };
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'openai_error');
  }
  return (data?.output_text || '').trim();
}

async function callAssistant({ messages, context, temperature = 0.2, model } = {}) {
  const proxyUrl = getOpenAiProxy();
  const key = (state.keys.openai?.key || '').trim();
  if (proxyUrl) {
    const payload = {
      messages: Array.isArray(messages) ? messages : [],
      context,
      temperature
    };
    if (model) payload.model = model;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (key) headers['x-openai-key'] = key;
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.error) {
      throw new Error(data.message || data.error);
    }
    return (data.text || '').trim();
  }

  if (isStaticMode()) {
    throw new Error('assistant_unavailable');
  }
  if (!key) {
    throw new Error('missing_api_key');
  }
  const payload = {
    messages: Array.isArray(messages) ? messages : [],
    context,
    temperature
  };
  if (model) payload.model = model;

  const response = await apiFetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openai-key': key
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.message || data.error);
  }
  return (data.text || '').trim();
}

function generateAnalysis(emitChat = false) {
  if (isStaticMode() && state.staticAnalysis?.text) {
    const stamp = state.staticAnalysis.generatedAt ? `\n\nUpdated ${toRelativeTime(state.staticAnalysis.generatedAt)}` : '';
    setAnalysisOutput(`${state.staticAnalysis.text}${stamp}`);
    return;
  }
  const totalItems = state.scopedItems.length;
  const newsClusters = state.clusters.length;
  const localCount = getLocalItems().length;
  const marketCount = applyLanguageFilter(applyFreshnessFilter(state.items))
    .filter((item) => item.category === 'crypto' || item.category === 'finance').length;

  if (!totalItems && !newsClusters) {
    const fallback = `Awaiting signals. Check feed health or refresh. Local radius: ${state.settings.radiusKm} km.`;
    setAnalysisOutput(fallback);
    if (emitChat) appendChatBubble(`Briefing: ${fallback}`, 'system');
    return;
  }

  const noise = new Set(['llc', 'inc', 'corp', 'news', 'update', 'report', 'alert', 'press', 'group']);
  const tokens = [];
  state.clusters.slice(0, 12).forEach((cluster) => {
    const normalized = normalizeTitle(cluster.primary.title);
    normalized.split(' ').forEach((token) => {
      if (!token || token.length < 3) return;
      if (noise.has(token)) return;
      if (/^\d+$/.test(token)) return;
      tokens.push(token);
    });
  });

  const counts = tokens.reduce((acc, token) => {
    acc[token] = (acc[token] || 0) + 1;
    return acc;
  }, {});

  const topThemes = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([token]) => token);

  const highCoverage = state.clusters.filter((cluster) => cluster.sources.size >= 3).slice(0, 3);
  const lines = [
    `Signals in view: ${totalItems || 'awaiting'} across ${newsClusters || 'no'} news clusters.`,
    `Local risks: ${localCount || 'no'} events within ${state.settings.radiusKm} km.`,
    `Market pulse: ${marketCount || 'no'} finance/crypto signals.`
  ];
  if (topThemes.length) {
    lines.push(`Top themes: ${topThemes.join(', ')}.`);
  } else if (highCoverage.length) {
    lines.push(`High coverage: ${highCoverage.map((c) => c.primary.title).join(' - ')}`);
  }
  const text = lines.join(' ');
  setAnalysisOutput(text);
  if (emitChat) {
    appendChatBubble(`Briefing: ${text}`, 'system');
  }
}

async function runAiAnalysis({ emitChat = true } = {}) {
  if (!elements.analysisRun || elements.analysisRun.disabled) return;
  const originalLabel = elements.analysisRun.textContent;
  elements.analysisRun.disabled = true;
  elements.analysisRun.classList.add('loading');
  elements.analysisRun.setAttribute('aria-busy', 'true');
  elements.analysisRun.textContent = 'Briefing…';
  state.analysisRunning = true;
  if (!state.keys.openai?.key) {
    generateAnalysis(emitChat);
    elements.analysisRun.disabled = false;
    elements.analysisRun.classList.remove('loading');
    elements.analysisRun.removeAttribute('aria-busy');
    elements.analysisRun.textContent = originalLabel;
    state.analysisRunning = false;
    return;
  }
  setAnalysisOutput('Generating AI briefing...');
  const progressBubble = emitChat ? appendChatBubble('Generating briefing…', 'system') : null;
  try {
    const text = await callAssistant({
      messages: [{
        role: 'user',
        content: 'Provide a concise situation briefing with 3 bullets: global pulse, local risks, and notable market/cyber signals. Mention sources when possible.'
      }],
      context: buildChatContext(),
      temperature: 0.2
    });
    const cleaned = text || 'No response yet.';
    setAnalysisOutput(cleaned);
    if (emitChat) {
      if (progressBubble) {
        progressBubble.className = 'chat-bubble assistant';
        progressBubble.innerHTML = formatBriefingText(cleaned);
      } else {
        appendChatBubble(cleaned, 'assistant');
      }
    }
  } catch (err) {
    const fallbackMessage = err?.message === 'assistant_unavailable'
      ? 'AI briefing requires a proxy on GitHub Pages. Showing heuristic analysis.'
      : 'AI briefing failed. Showing heuristic analysis.';
    setAnalysisOutput(fallbackMessage);
    if (progressBubble) {
      progressBubble.className = 'chat-bubble system';
      progressBubble.innerHTML = formatBriefingText(fallbackMessage);
    }
    generateAnalysis(emitChat);
  } finally {
    elements.analysisRun.disabled = false;
    elements.analysisRun.classList.remove('loading');
    elements.analysisRun.removeAttribute('aria-busy');
    elements.analysisRun.textContent = originalLabel;
    state.analysisRunning = false;
  }
}

function appendChatBubble(text, role) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  if (role === 'assistant' || role === 'system') {
    bubble.innerHTML = formatBriefingText(text);
  } else {
    bubble.textContent = text;
  }
  elements.chatLog.appendChild(bubble);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  return bubble;
}

async function sendChatMessage() {
  const text = elements.chatInput.value.trim();
  if (!text) return;
  appendChatBubble(text, 'user');
  elements.chatInput.value = '';

  if (!state.keys.openai?.key) {
    appendChatBubble('Add an OpenAI API key in Settings > API Keys to enable chat.', 'system');
    return;
  }

  const typing = appendChatBubble('Thinking...', 'system');
  state.chatHistory.push({ role: 'user', content: text });
  const history = state.chatHistory.slice(-6);

  try {
    const reply = await callAssistant({
      messages: history,
      context: buildChatContext(),
      temperature: 0.3
    });
    typing.textContent = reply || 'No response.';
    state.chatHistory.push({ role: 'assistant', content: reply || 'No response.' });
  } catch (err) {
    if (err.message === 'missing_api_key') {
      typing.textContent = 'Add an OpenAI API key in Settings.';
    } else if (err.message === 'assistant_unavailable') {
      typing.textContent = 'AI chat requires a proxy on GitHub Pages.';
    } else {
      typing.textContent = `Assistant error: ${err.message}`;
    }
  }
}

function exportSnapshot() {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    settings: state.settings,
    location: state.location,
    scope: state.settings.scope,
    feeds: state.feeds.map((feed) => ({ id: feed.id, name: feed.name, category: feed.category })),
    items: state.scopedItems,
    clusters: state.clusters.map((cluster) => ({
      title: cluster.primary.title,
      sources: Array.from(cluster.sources),
      updatedAt: cluster.updatedAt,
      url: cluster.primary.url
    }))
  };

  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = URL.createObjectURL(blob);
  link.download = `situation-room-snapshot-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);

  if (!isStaticMode()) {
    apiFetch('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    }).catch(() => {});
  }
}

function applyScope(items) {
  let filtered = applyFreshnessFilter(items);
  if (state.settings.scope === 'us') {
    filtered = filtered.filter((item) => item.tags?.includes('us'));
  }
  if (state.settings.scope === 'local') {
    filtered = filtered.filter((item) => item.geo && haversineKm(state.location.lat, state.location.lon, item.geo.lat, item.geo.lon) <= state.settings.radiusKm);
  }
  return applyLanguageFilter(filtered);
}

function getLocalItems() {
  const sourceItems = state.settings.scope === 'global'
    ? applyLanguageFilter(applyFreshnessFilter(state.items))
    : state.scopedItems;
  if (!sourceItems.length) return [];
  const { lat, lon } = state.location;
  const radius = state.settings.radiusKm;
  return sourceItems.filter((item) => item.geo && haversineKm(lat, lon, item.geo.lat, item.geo.lon) <= radius);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isInUsBounds(lat, lon) {
  return lat >= 24 && lat <= 49 && lon >= -125 && lon <= -66;
}

function getMapItems() {
  const fresh = applyLanguageFilter(applyFreshnessFilter(state.items));
  if (state.settings.scope === 'us') {
    return fresh.filter((item) => {
      if (!item.geo) return false;
      if (item.tags?.includes('us')) return true;
      return isInUsBounds(item.geo.lat, item.geo.lon);
    });
  }
  if (state.settings.scope === 'local') {
    const { lat, lon } = state.location;
    const radius = state.settings.radiusKm;
    return fresh.filter((item) => item.geo && haversineKm(lat, lon, item.geo.lat, item.geo.lon) <= radius);
  }
  return state.scopedItems.filter((item) => item.geo);
}

function renderLocal() {
  const items = getLocalItemsForPanel();
  const limit = Math.min(getListLimit(elements.localList?.id), items.length);
  renderList(elements.localList, items.slice(0, limit));
}

function getCategoryItems(category) {
  let items = state.scopedItems.filter((item) => item.category === category);
  if (!items.length && globalFallbackCategories.has(category)) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.category === category);
  }
  const originalItems = items;
  items = items.filter((item) => !item.mapOnly);
  if (category === 'health' && !items.length && originalItems.length) {
    return { items: [], mapOnlyNotice: true };
  }
  if (category === 'health' && items.length) {
    if (state.settings.mapLayers.health) {
      const nonAir = items.filter((item) => item.feedId !== 'openaq-api');
      if (nonAir.length) {
        items = nonAir;
      } else {
        return { items: [], mapOnlyNotice: true };
      }
    }
  }
  if (category === 'crypto') {
    items = [...items].sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0));
  }
  if (category === 'research') {
    items = dedupeItems(items);
  }
  return { items, mapOnlyNotice: false };
}

function renderCategory(category, container) {
  if (!container) return;
  const { items, mapOnlyNotice } = getCategoryItems(category);
  if (mapOnlyNotice) {
    container.innerHTML = '<div class="list-item"><div class="list-title">Air quality signals are shown on the map.</div><div class="list-summary">Toggle the Health layer in the map legend to filter air quality stations.</div></div>';
    return;
  }
  const limit = Math.min(getListLimit(container.id), items.length);
  renderList(container, items.slice(0, limit));
}

function getCombinedItems(categories) {
  let items = state.scopedItems.filter((item) => categories.includes(item.category));
  if (categories.includes('weather') || categories.includes('disaster') || categories.includes('space')) {
    items = dedupeItems(items.map((item) => ({
      ...item,
      _dedupeKey: `${normalizeTitle(item.alertType || '')}|${normalizeTitle(item.title || '')}|${normalizeTitle(item.location || item.geoLabel || '')}`
    }))).map((item) => {
      const { _dedupeKey, ...rest } = item;
      return rest;
    });
  }
  return items;
}

function renderCombined(categories, container) {
  if (!container) return;
  const items = getCombinedItems(categories);
  const limit = Math.min(getListLimit(container.id), items.length);
  renderList(container, items.slice(0, limit));
}

function renderEnergyNews() {
  if (!elements.energyList) return;
  const items = getEnergyNewsItems();
  const limit = Math.min(getListLimit(elements.energyList.id), items.length);
  renderList(elements.energyList, items.slice(0, limit));
}

function getPredictionItems() {
  const items = getCategoryItems('prediction').items;
  if (!items.length) return [];
  const byVolume = [...items].sort((a, b) => (b.volume24 || 0) - (a.volume24 || 0)).slice(0, 2);
  const seen = new Set(byVolume.map((item) => item.title));
  const byNewest = [...items]
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .filter((item) => !seen.has(item.title))
    .slice(0, 2);
  const combined = [...byVolume, ...byNewest];
  const remaining = items.filter((item) => !combined.includes(item));
  return [...combined, ...remaining];
}

function renderPrediction() {
  if (!elements.predictionList) return;
  const items = getPredictionItems();
  const limit = Math.min(getListLimit(elements.predictionList.id), items.length);
  renderList(elements.predictionList, items.slice(0, limit));
}

async function loadEnergyGeoJson() {
  if (state.energyGeo) return state.energyGeo;
  const response = await fetch(getAssetUrl('/geo/us-states.geojson'));
  const data = await response.json();
  state.energyGeo = data;
  return data;
}

async function fetchEnergyMapData() {
  const cacheTtl = 60 * 60 * 1000;
  if (state.energyMapData && Date.now() - state.energyMapFetchedAt < cacheTtl) {
    return state.energyMapData;
  }
  try {
    const { data: payload, error } = await apiJson('/api/energy-map');
    if (error || !payload) {
      state.energyMapError = 'fetch_failed';
      return null;
    }
    if (payload?.error) {
      state.energyMapError = payload.error;
      return null;
    }
    state.energyMapError = null;
    state.energyMapData = payload;
    state.energyMapFetchedAt = Date.now();
    return payload;
  } catch (err) {
    state.energyMapError = 'fetch_failed';
    return null;
  }
}

function getEnergyMapColor(value, min, max) {
  if (!Number.isFinite(value)) return 'rgba(90, 100, 120, 0.2)';
  const clamped = (value - min) / (max - min || 1);
  const light = elements.app?.dataset?.theme === 'light';
  const hue = 200;
  const sat = light ? 70 : 75;
  const l = light ? 85 - clamped * 35 : 55 - clamped * 25;
  return `hsl(${hue}, ${sat}%, ${l}%)`;
}

async function renderEnergyMap() {
  if (!elements.energyMap || !window.L) return;
  const [geo, energyData] = await Promise.all([
    loadEnergyGeoJson(),
    fetchEnergyMapData()
  ]);
  if (!geo || !energyData) {
    if (elements.energyMapEmpty) {
      const message = state.energyMapError === 'missing_server_key'
        ? 'Energy map needs the server EIA key to be configured.'
        : 'Energy map unavailable right now.';
      elements.energyMapEmpty.textContent = message;
      elements.energyMapEmpty.style.display = 'flex';
    }
    return;
  }
  if (elements.energyMapEmpty) elements.energyMapEmpty.style.display = 'none';

  if (!state.energyMap) {
    state.energyMap = window.L.map(elements.energyMap, {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false
    });
  }

  if (state.energyMapLayer) {
    state.energyMap.removeLayer(state.energyMapLayer);
  }

  state.energyMapLayer = window.L.geoJSON(geo, {
    style: (feature) => {
      const abbr = feature?.properties?.STUSPS;
      const entry = energyData.values?.[abbr];
      return {
        color: 'rgba(60, 80, 110, 0.6)',
        weight: 1,
        fillColor: getEnergyMapColor(entry?.value, energyData.min, energyData.max),
        fillOpacity: 0.8
      };
    },
    onEachFeature: (feature, layer) => {
      const abbr = feature?.properties?.STUSPS;
      const name = feature?.properties?.NAME || abbr || 'Unknown';
      const entry = energyData.values?.[abbr];
      const valueText = entry ? `${entry.value.toFixed(2)} ${energyData.units}` : 'No data';
      const period = entry?.period || energyData.period;
      layer.bindTooltip(`${name} (${abbr}) • ${valueText} ${period ? `• ${period}` : ''}`, {
        sticky: true,
        direction: 'top'
      });
      layer.on('mouseover', () => {
        layer.setStyle({ weight: 2, fillOpacity: 0.95 });
      });
      layer.on('mouseout', () => {
        layer.setStyle({ weight: 1, fillOpacity: 0.8 });
      });
    }
  }).addTo(state.energyMap);

  const excluded = new Set(['AK', 'HI', 'PR', 'GU', 'VI', 'MP', 'AS']);
  const viewFeatures = (geo.features || []).filter((feature) => !excluded.has(feature?.properties?.STUSPS));
  const bounds = viewFeatures.length
    ? window.L.geoJSON(viewFeatures).getBounds()
    : state.energyMapLayer.getBounds();
  if (bounds.isValid()) {
    state.energyMap.fitBounds(bounds, { padding: [10, 10], maxZoom: 5 });
  }
  setTimeout(() => state.energyMap.invalidateSize(), 80);

  if (elements.energyMapLegend) {
    elements.energyMapLegend.innerHTML = `
      <div class="energy-map-legend-title">Price (cents/kWh)</div>
      <div class="energy-map-legend-scale">
        <span>${energyData.min.toFixed(1)}</span>
        <span>${energyData.max.toFixed(1)}</span>
      </div>
      <div class="energy-map-legend-bar"></div>
      <div class="energy-map-legend-meta">Residential • ${energyData.period}</div>
    `;
  }
}

function renderTravelTicker() {
  if (!elements.travelTicker || !elements.travelTickerTrack) return;
  elements.travelTicker.classList.toggle('hidden', !state.settings.showTravelTicker);
  if (!state.settings.showTravelTicker) return;

  let items = state.scopedItems.filter((item) => item.category === 'travel');
  if (!items.length) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.category === 'travel');
  }
  items = dedupeItems(items).slice(0, 14);

  elements.travelTickerTrack.innerHTML = '';
  if (!items.length) {
    elements.travelTickerTrack.innerHTML = '<span class="map-travel-item">No travel advisories in the current window.</span>';
    return;
  }

  const buildGroup = () => {
    const group = document.createElement('div');
    group.className = 'map-travel-group';
    items.forEach((item) => {
      const link = document.createElement(item.url ? 'a' : 'span');
      link.className = 'map-travel-item';
      if (item.url) {
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      const parts = [];
      if (item.severity) parts.push(`<span class="map-travel-chip">${item.severity}</span>`);
      if (item.regionTag) parts.push(`<span class="map-travel-chip">${item.regionTag}</span>`);
      parts.push(`<span class="map-travel-text">${truncateText(item.title || '', 120)}</span>`);
      link.innerHTML = parts.join('');
      group.appendChild(link);
    });
    return group;
  };

  const group = buildGroup();
  elements.travelTickerTrack.appendChild(group);
  if (items.length > 4) {
    elements.travelTickerTrack.appendChild(buildGroup());
  }
}

function renderAllPanels() {
  renderNews(state.clusters);
  renderCombined(['finance', 'energy'], elements.financeMarketsList);
  renderCombined(['gov', 'cyber', 'agriculture'], elements.financePolicyList);
  renderCategory('crypto', elements.cryptoList);
  renderPrediction();
  renderCombined(['disaster', 'weather', 'space'], elements.disasterList);
  renderCategory('gov', elements.policyList);
  renderCategory('cyber', elements.cyberList);
  renderCategory('agriculture', elements.agricultureList);
  renderCategory('research', elements.researchList);
  renderCategory('space', elements.spaceList);
  renderEnergyNews();
  renderEnergyMap();
  renderCategory('health', elements.healthList);
  renderCategory('transport', elements.transportList);
  renderLocal();
  renderTravelTicker();
  renderFinanceSpotlight();
  updatePanelTimestamps();
}

function openListModal(listId) {
  const config = listModalConfigMap[listId];
  if (!config || !elements.listModalList) return;
  const items = config.getItems() || [];
  if (elements.listModalTitle) {
    elements.listModalTitle.textContent = config.title || 'Panel Items';
  }
  if (elements.listModalMeta) {
    elements.listModalMeta.textContent = items.length
      ? `${items.length} items`
      : 'No signals yet';
  }
  elements.listModalList.dataset.listContext = config.id;
  renderList(elements.listModalList, items, { withCoverage: config.withCoverage });
  toggleListModal(true);
}

function closeListModal() {
  toggleListModal(false);
}

function initListModal() {
  if (elements.listModalClose) {
    elements.listModalClose.addEventListener('click', () => closeListModal());
  }
  if (elements.listOverlay) {
    elements.listOverlay.addEventListener('click', (event) => {
      if (event.target === elements.listOverlay) {
        closeListModal();
      }
    });
  }
}

function initCommunityEmbed() {
  if (!elements.communityConnect || !elements.communityFrame) return;
  const frame = elements.communityFrame;
  const loadFrame = () => {
    if (frame.src) return;
    const src = frame.dataset.src;
    if (!src) return;
    frame.src = src;
  };
  elements.communityConnect.addEventListener('click', () => {
    loadFrame();
  });
}

function initSidebarNav() {
  const navLinks = [...document.querySelectorAll('.nav-link[data-panel-target]')];
  if (!navLinks.length) return;
  const panels = [...document.querySelectorAll('.panel[data-panel]')];

  const setActive = (target) => {
    navLinks.forEach((link) => {
      link.classList.toggle('active', link.dataset.panelTarget === target);
    });
  };

  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      const target = link.dataset.panelTarget;
      const panel = panels.find((entry) => entry.dataset.panel === target);
      if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      setActive(target);
      setNavOpen(false);
    });
  });

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const offset = 140;
      let active = panels[0]?.dataset.panel;
      panels.forEach((panel) => {
        const rect = panel.getBoundingClientRect();
        if (rect.top - offset <= 0) {
          active = panel.dataset.panel;
        }
      });
      if (active) {
        setActive(active);
      }
      ticking = false;
    });
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function initCommandSections() {
  const sections = [...document.querySelectorAll('.command-section')];
  sections.forEach((section) => {
    const toggle = section.querySelector('.command-section-toggle');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', section.classList.contains('is-open') ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      const isOpen = section.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  });
}

function initInfiniteScroll() {
  const configs = [
    { id: 'newsList', withCoverage: true, getItems: () => buildNewsItems(state.clusters) },
    { id: 'financeMarketsList', getItems: () => getCombinedItems(['finance', 'energy']) },
    { id: 'financePolicyList', getItems: () => getCombinedItems(['gov', 'cyber', 'agriculture']) },
    { id: 'cryptoList', getItems: () => getCategoryItems('crypto').items },
    { id: 'predictionList', getItems: () => getPredictionItems() },
    { id: 'disasterList', getItems: () => getCombinedItems(['disaster', 'weather', 'space']) },
    { id: 'localList', getItems: () => getLocalItemsForPanel() },
    { id: 'policyList', getItems: () => getCategoryItems('gov').items },
    { id: 'cyberList', getItems: () => getCategoryItems('cyber').items },
    { id: 'agricultureList', getItems: () => getCategoryItems('agriculture').items },
    { id: 'researchList', getItems: () => getCategoryItems('research').items },
    { id: 'spaceList', getItems: () => getCategoryItems('space').items },
    { id: 'energyList', getItems: () => getEnergyNewsItems() },
    { id: 'healthList', getItems: () => getCategoryItems('health').items },
    { id: 'transportList', getItems: () => getCategoryItems('transport').items }
  ];

  configs.forEach((config) => {
    const container = document.getElementById(config.id);
    if (!container) return;
    container.addEventListener('scroll', () => {
      if (container.scrollTop + container.clientHeight < container.scrollHeight - 60) return;
      const items = config.getItems();
      if (!items || !items.length) return;
      const current = getListLimit(config.id);
      if (current >= items.length) return;
      const next = Math.min(items.length, current + listPageSize);
      state.listLimits[config.id] = next;
      renderList(container, items.slice(current, next), { withCoverage: config.withCoverage, append: true });
    });
  });
}

function getRecentIsoDate(offsetDays = 1) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - offsetDays);
  return date.toISOString().slice(0, 10);
}

function buildGibsTileUrl(layer, date, format = 'jpg', matrixSet = 'GoogleMapsCompatible_Level9') {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/${matrixSet}/{z}/{y}/{x}.${format}`;
}

function buildSarTileUrl(date) {
  return `https://services.terrascope.be/wmts/v2/wmts?service=WMTS&request=GetTile&version=1.0.0&layer=CGS_S1_GRD_SIGMA0&style=default&format=image/png&tilematrixset=EPSG:3857&tilematrix=EPSG:3857:{z}&tilerow={y}&tilecol={x}&time=${date}`;
}

function buildSarTileUrlForTile(date, z, y, x) {
  return `https://services.terrascope.be/wmts/v2/wmts?service=WMTS&request=GetTile&version=1.0.0&layer=CGS_S1_GRD_SIGMA0&style=default&format=image/png&tilematrixset=EPSG:3857&tilematrix=EPSG:3857:${z}&tilerow=${y}&tilecol=${x}&time=${date}`;
}

function sampleTileUrl(template) {
  return template.replace('{z}', '2').replace('{y}', '1').replace('{x}', '1');
}

function checkTileAvailable(url, timeout = 5000) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      resolve(false);
    }, timeout);
    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const cacheBust = url.includes('?') ? '&' : '?';
    img.src = `${url}${cacheBust}cb=${Date.now()}`;
  });
}

function latLonToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y, z };
}

function buildSarSampleUrls(date) {
  const zoom = 4;
  const samples = [
    { lat: 50.0, lon: 4.5 },   // Western Europe
    { lat: 34.0, lon: -118.2 }, // US West
    { lat: 35.6, lon: 139.6 }  // Japan
  ];
  return samples.map(({ lat, lon }) => {
    const { x, y } = latLonToTile(lat, lon, zoom);
    return buildSarTileUrlForTile(date, zoom, y, x);
  });
}

function shiftIsoDate(base, offsetDays) {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function getDefaultImageryDate(layerKey) {
  const layer = GIBS_LAYERS[layerKey] || null;
  if (layer?.defaultDate) return layer.defaultDate;
  return getRecentIsoDate(1);
}

async function resolveLatestImageryDate() {
  if (state.imageryResolveInFlight || state.imageryDateManual) return;
  state.imageryResolveInFlight = true;
  try {
    const activeKey = state.settings.mapBasemap?.startsWith('gibs') ? state.settings.mapBasemap : 'gibs-viirs';
    const layer = GIBS_LAYERS[activeKey] || GIBS_LAYERS['gibs-viirs'];
    if (layer?.defaultDate) {
      updateImageryDate(layer.defaultDate);
      return;
    }
    const base = getRecentIsoDate(0);
    for (let i = 0; i < 8; i += 1) {
      const candidate = shiftIsoDate(base, -i);
      const url = sampleTileUrl(buildGibsTileUrl(layer.id, candidate, layer.format, layer.matrixSet));
      // eslint-disable-next-line no-await-in-loop
      const ok = await checkTileAvailable(url);
      if (ok) {
        updateImageryDate(candidate);
        return;
      }
    }
  } finally {
    state.imageryResolveInFlight = false;
  }
}

async function resolveLatestSarDate() {
  if (state.sarResolveInFlight || state.sarDateManual) return;
  if (!state.settings.mapRasterOverlays?.sar) {
    updateMapDateUI();
    return;
  }
  state.sarResolveInFlight = true;
  try {
    const base = getRecentIsoDate(0);
    for (let i = 0; i < 12; i += 1) {
      const candidate = shiftIsoDate(base, -i);
      const urls = buildSarSampleUrls(candidate);
      for (const url of urls) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await checkTileAvailable(url);
        if (ok) {
          updateSarDate(candidate);
          return;
        }
      }
    }
  } finally {
    state.sarResolveInFlight = false;
  }
}

function updateImageryDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  state.imageryDate = date;
  state.settings.mapImageryDate = date;
  Object.entries(state.mapBaseLayers || {}).forEach(([key, layer]) => {
    if (!key.startsWith('gibs')) return;
    const layerConfig = GIBS_LAYERS[key];
    if (!layerConfig) return;
    layer.setUrl(buildGibsTileUrl(layerConfig.id, date, layerConfig.format, layerConfig.matrixSet));
    layer.redraw();
  });
  Object.entries(state.mapOverlayLayers || {}).forEach(([key, layer]) => {
    if (!key.startsWith('gibs-overlay')) return;
    const overlayKey = key.replace('gibs-overlay-', '');
    const overlayConfig = GIBS_OVERLAYS[overlayKey];
    if (!overlayConfig) return;
    layer.setUrl(buildGibsTileUrl(overlayConfig.id, date, overlayConfig.format, overlayConfig.matrixSet));
    layer.redraw();
  });
  updateMapDateUI();
  saveSettings();
}

function updateSarDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  state.sarDate = date;
  state.settings.mapSarDate = date;
  const layer = state.mapOverlayLayers?.sar;
  if (layer) {
    layer.setUrl(buildSarTileUrl(date));
    layer.redraw();
  }
  updateMapDateUI();
  saveSettings();
}

function applyMapPreset(preset) {
  if (preset === 'night') {
    applyMapBasemap('gibs-nightlights');
    state.settings.mapRasterOverlays = {
      ...state.settings.mapRasterOverlays,
      hillshade: false,
      sar: false,
      aerosol: false,
      thermal: false,
      fire: false
    };
    saveSettings();
    syncMapRasterOverlays();
    updateImageryPanelUI();
    updateMapLegendUI();
    resolveLatestImageryDate();
    return;
  }
  if (preset === 'thermal') {
    applyMapBasemap('gibs-viirs');
    state.settings.mapRasterOverlays = {
      ...state.settings.mapRasterOverlays,
      thermal: true,
      fire: true
    };
    saveSettings();
    syncMapRasterOverlays();
    updateImageryPanelUI();
    updateMapLegendUI();
    resolveLatestImageryDate();
  }
}

function resetImagerySettings() {
  state.settings.mapBasemap = 'osm';
  state.settings.mapRasterOverlays = {
    hillshade: false,
    sar: false,
    aerosol: false,
    thermal: false,
    fire: false
  };
  state.settings.mapOverlayOpacity = {
    hillshade: 0.45,
    sar: 0.55,
    aerosol: 0.45,
    thermal: 0.6,
    fire: 0.6
  };
  state.settings.mapImageryDate = '';
  state.settings.mapSarDate = '';
  state.imageryDateManual = false;
  state.sarDateManual = false;
  saveSettings();
  applyMapBasemap('osm');
  syncMapRasterOverlays();
  updateImageryPanelUI();
  updateMapLegendUI();
  updateMapDateUI();
}

function applyMapBasemap(basemap, { skipSave = false } = {}) {
  if (!state.map) return;
  const resolved = basemap === 'gibs' ? 'gibs-viirs' : basemap;
  const target = state.mapBaseLayers?.[resolved] || state.mapBaseLayers?.osm;
  if (!target) return;
  if (state.activeBaseLayer) {
    state.map.removeLayer(state.activeBaseLayer);
  }
  state.activeBaseLayer = target;
  target.addTo(state.map);
  state.settings.mapBasemap = resolved;
  if (target.options?.maxZoom) {
    state.map.setMaxZoom(target.options.maxZoom);
  } else {
    state.map.setMaxZoom(18);
  }
  if (!skipSave) {
    saveSettings();
    updateMapLegendUI();
  }
  if (basemap.startsWith('gibs')) {
    const layer = GIBS_LAYERS[resolved];
    if (layer?.defaultDate && !state.imageryDateManual) {
      updateImageryDate(layer.defaultDate);
    } else {
      resolveLatestImageryDate();
    }
  }
  updateImageryPanelUI();
}

function syncMapRasterOverlays() {
  if (!state.map) return;
  Object.entries(state.mapOverlayLayers || {}).forEach(([key, layer]) => {
    let overlayKey = key.startsWith('gibs-overlay-') ? key.replace('gibs-overlay-', '') : key;
    if (overlayKey.startsWith('fire')) {
      overlayKey = 'fire';
    }
    const shouldShow = Boolean(state.settings.mapRasterOverlays?.[overlayKey]);
    const isActive = state.map.hasLayer(layer);
    if (shouldShow && !isActive) {
      layer.addTo(state.map);
    }
    if (!shouldShow && isActive) {
      state.map.removeLayer(layer);
    }
    const opacity = getOverlayOpacity(overlayKey, layer.options?.opacity ?? 0.5);
    if (typeof layer.setOpacity === 'function' && Number.isFinite(opacity)) {
      layer.setOpacity(opacity);
    }
  });
}

function initMap() {
  if (!elements.mapBase || !window.L) return;
  state.map = window.L.map(elements.mapBase, {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true
  }).setView([state.location.lat, state.location.lon], 2);

  const defaultDate = getDefaultImageryDate(state.settings.mapBasemap || 'gibs-viirs');
  const gibsDate = state.settings.mapImageryDate || defaultDate;
  const sarDate = state.settings.mapSarDate || defaultDate;
  state.imageryDate = gibsDate;
  state.sarDate = sarDate;
  state.settings.mapImageryDate = gibsDate;
  state.settings.mapSarDate = sarDate;

  state.mapBaseLayers = {
    osm: window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors'
    }),
    esri: window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    }),
    'gibs-viirs': window.L.tileLayer(buildGibsTileUrl(GIBS_LAYERS['gibs-viirs'].id, gibsDate, GIBS_LAYERS['gibs-viirs'].format, GIBS_LAYERS['gibs-viirs'].matrixSet), {
      maxZoom: GIBS_LAYERS['gibs-viirs'].maxZoom,
      attribution: 'NASA GIBS (VIIRS True Color)'
    }),
    'gibs-modis-terra': window.L.tileLayer(buildGibsTileUrl(GIBS_LAYERS['gibs-modis-terra'].id, gibsDate, GIBS_LAYERS['gibs-modis-terra'].format, GIBS_LAYERS['gibs-modis-terra'].matrixSet), {
      maxZoom: GIBS_LAYERS['gibs-modis-terra'].maxZoom,
      attribution: 'NASA GIBS (MODIS Terra True Color)'
    }),
    'gibs-modis-aqua': window.L.tileLayer(buildGibsTileUrl(GIBS_LAYERS['gibs-modis-aqua'].id, gibsDate, GIBS_LAYERS['gibs-modis-aqua'].format, GIBS_LAYERS['gibs-modis-aqua'].matrixSet), {
      maxZoom: GIBS_LAYERS['gibs-modis-aqua'].maxZoom,
      attribution: 'NASA GIBS (MODIS Aqua True Color)'
    }),
    'gibs-nightlights': window.L.tileLayer(buildGibsTileUrl(GIBS_LAYERS['gibs-nightlights'].id, gibsDate, GIBS_LAYERS['gibs-nightlights'].format, GIBS_LAYERS['gibs-nightlights'].matrixSet), {
      maxZoom: GIBS_LAYERS['gibs-nightlights'].maxZoom,
      attribution: 'NASA GIBS (VIIRS Black Marble)'
    }),
    'gibs-daynight': window.L.tileLayer(buildGibsTileUrl(GIBS_LAYERS['gibs-daynight'].id, gibsDate, GIBS_LAYERS['gibs-daynight'].format, GIBS_LAYERS['gibs-daynight'].matrixSet), {
      maxZoom: GIBS_LAYERS['gibs-daynight'].maxZoom,
      attribution: 'NASA GIBS (VIIRS Day/Night Band)'
    })
  };

  state.mapOverlayLayers = {
    hillshade: window.L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16,
      opacity: getOverlayOpacity('hillshade', 0.45),
      attribution: 'Esri World Hillshade'
    }),
    sar: window.L.tileLayer(buildSarTileUrl(sarDate), {
      maxZoom: 13,
      opacity: getOverlayOpacity('sar', 0.55),
      attribution: 'Sentinel-1 SAR (Terrascope)'
    }),
    'gibs-overlay-aerosol': window.L.tileLayer(buildGibsTileUrl(GIBS_OVERLAYS.aerosol.id, gibsDate, GIBS_OVERLAYS.aerosol.format, GIBS_OVERLAYS.aerosol.matrixSet), {
      maxZoom: GIBS_OVERLAYS.aerosol.maxZoom,
      opacity: getOverlayOpacity('aerosol', GIBS_OVERLAYS.aerosol.opacity),
      attribution: 'NASA GIBS (Aerosol Index)'
    }),
    'gibs-overlay-thermal': window.L.tileLayer(buildGibsTileUrl(GIBS_OVERLAYS.thermal.id, gibsDate, GIBS_OVERLAYS.thermal.format, GIBS_OVERLAYS.thermal.matrixSet), {
      maxZoom: GIBS_OVERLAYS.thermal.maxZoom,
      opacity: getOverlayOpacity('thermal', GIBS_OVERLAYS.thermal.opacity),
      attribution: 'NASA GIBS (Thermal Anomalies)'
    }),
    'gibs-overlay-fire-east': window.L.tileLayer(buildGibsTileUrl(GIBS_OVERLAYS['fire-east'].id, gibsDate, GIBS_OVERLAYS['fire-east'].format, GIBS_OVERLAYS['fire-east'].matrixSet), {
      maxZoom: GIBS_OVERLAYS['fire-east'].maxZoom,
      opacity: getOverlayOpacity('fire', GIBS_OVERLAYS['fire-east'].opacity),
      attribution: 'NASA GIBS (GOES East Fire Temp)'
    }),
    'gibs-overlay-fire-west': window.L.tileLayer(buildGibsTileUrl(GIBS_OVERLAYS['fire-west'].id, gibsDate, GIBS_OVERLAYS['fire-west'].format, GIBS_OVERLAYS['fire-west'].matrixSet), {
      maxZoom: GIBS_OVERLAYS['fire-west'].maxZoom,
      opacity: getOverlayOpacity('fire', GIBS_OVERLAYS['fire-west'].opacity),
      attribution: 'NASA GIBS (GOES West Fire Temp)'
    })
  };

  applyMapBasemap(state.settings.mapBasemap, { skipSave: true });
  syncMapRasterOverlays();

  state.map.on('moveend zoomend', () => {
    drawMap();
  });
  state.map.on('movestart zoomstart', () => {
    hideMapDetail();
  });

  state.map.whenReady(() => {
    updateMapViewForScope();
    drawMap();
  });

  setTimeout(() => {
    state.map.invalidateSize();
    updateMapViewForScope();
    drawMap();
  }, 0);

  resolveLatestImageryDate();
  if (state.settings.mapRasterOverlays?.sar) {
    resolveLatestSarDate();
  }
}

function getLayerForItem(item) {
  if (item.feedId === 'noaa-incidentnews' || item.category === 'spill') return 'spill';
  if (item.feedId === 'state-travel-advisories' || item.feedId === 'cdc-travel-notices') return 'travel';
  if (item.category === 'travel') return 'travel';
  if (item.category === 'transport') return 'transport';
  if (item.category === 'security') return 'security';
  if (item.category === 'infrastructure') return 'infrastructure';
  if (item.category === 'weather') return 'weather';
  if (item.category === 'disaster') return 'disaster';
  if (item.category === 'space') return 'space';
  if (item.category === 'health') return 'health';
  return 'news';
}

function getLayerColor(layer) {
  if (layer === 'disaster') return 'rgba(255,106,106,0.9)';
  if (layer === 'weather') return 'rgba(55,214,214,0.9)';
  if (layer === 'space') return 'rgba(140,107,255,0.9)';
  if (layer === 'travel') return 'rgba(255,196,87,0.95)';
  if (layer === 'transport') return 'rgba(94,232,160,0.9)';
  if (layer === 'security') return 'rgba(255,144,99,0.92)';
  if (layer === 'infrastructure') return 'rgba(132,190,255,0.9)';
  if (layer === 'health') return 'rgba(109,209,255,0.9)';
  if (layer === 'spill') return 'rgba(255,125,36,0.92)';
  return 'rgba(255,184,76,0.9)';
}

function getSignalType(item) {
  if (!item) return 'news';
  if (item.feedId === 'noaa-incidentnews' || item.category === 'spill') return 'spill';
  if (item.feedId === 'usgs-quakes-hour' || item.feedId === 'usgs-quakes-day') return 'quake';
  if (item.feedId === 'arcgis-border-crisis') return 'border';
  if (item.feedId === 'arcgis-kinetic-oconus' || item.feedId === 'arcgis-kinetic-domestic') return 'kinetic';
  if (item.feedId === 'arcgis-drone-reports') return 'drone';
  if (item.feedId === 'arcgis-logistics-shortages') return 'logistics';
  if (item.feedId === 'arcgis-hms-fire') return 'fire';
  if (item.feedId?.startsWith('arcgis-noaa-')) return 'warning';
  if (item.feedId === 'arcgis-power-plants') return 'power';
  if (item.feedId === 'state-travel-advisories' || item.feedId === 'cdc-travel-notices') return 'travel';
  if (item.feedId === 'transport-opensky') return 'air';
  if (item.category === 'travel') return 'travel';
  if (item.category === 'spill') return 'spill';
  if (item.category === 'weather') return 'weather';
  if (item.category === 'disaster') return 'disaster';
  if (item.category === 'space') return 'space';
  if (item.category === 'health') return 'health';
  if (item.category === 'transport') return 'transport';
  if (item.category === 'security') return 'security';
  if (item.category === 'infrastructure') return 'infrastructure';
  return 'news';
}

function getSignalIcon(type) {
  if (type === 'quake') return 'Q';
  if (type === 'border') return 'B';
  if (type === 'kinetic') return 'K';
  if (type === 'drone') return 'V';
  if (type === 'logistics') return 'L';
  if (type === 'fire') return 'F';
  if (type === 'warning') return 'W';
  if (type === 'power') return 'P';
  if (type === 'travel') return 'T';
  if (type === 'air') return 'A';
  if (type === 'health') return 'H';
  if (type === 'transport') return 'R';
  if (type === 'weather') return 'W';
  if (type === 'disaster') return 'D';
  if (type === 'space') return 'S';
  if (type === 'security') return 'C';
  if (type === 'infrastructure') return 'I';
  if (type === 'spill') return 'O';
  return 'N';
}

function clusterMapPoints(points, radius = 24) {
  const clusters = [];
  points.forEach((point) => {
    let target = null;
    for (const cluster of clusters) {
      const dx = cluster.x - point.x;
      const dy = cluster.y - point.y;
      if (Math.sqrt(dx * dx + dy * dy) < radius) {
        target = cluster;
        break;
      }
    }
    if (!target) {
      clusters.push({
        x: point.x,
        y: point.y,
        points: [point]
      });
    } else {
      target.points.push(point);
      const count = target.points.length;
      target.x = (target.x * (count - 1) + point.x) / count;
      target.y = (target.y * (count - 1) + point.y) / count;
    }
  });

  return clusters.map((cluster) => {
    const count = cluster.points.length;
    const layerCounts = cluster.points.reduce((acc, point) => {
      acc[point.layer] = (acc[point.layer] || 0) + 1;
      return acc;
    }, {});
    const dominant = Object.entries(layerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'news';
    const typeCounts = cluster.points.reduce((acc, point) => {
      acc[point.type] = (acc[point.type] || 0) + 1;
      return acc;
    }, {});
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'news';
    const primary = cluster.points
      .map((point) => point.item)
      .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))[0];
    const radiusPx = count === 1 ? 4 : Math.min(16, 4 + Math.sqrt(count) * 2);
    return {
      x: cluster.x,
      y: cluster.y,
      count,
      layer: dominant,
      type: dominantType,
      icon: getSignalIcon(dominantType),
      color: getLayerColor(dominant),
      primary,
      items: cluster.points.map((point) => point.item),
      radius: radiusPx
    };
  });
}

function drawMap() {
  const canvas = elements.mapCanvas;
  const ctx = canvas.getContext('2d');
  const baseRect = (elements.mapBase || canvas).getBoundingClientRect();
  const { width, height } = baseRect;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  state.mapPoints = [];

  if (!state.map) {
    for (let x = 0; x <= width; x += width / 6) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    for (let y = 0; y <= height; y += height / 4) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  const rawPoints = getMapItems().map((item) => {
    const { lat, lon } = item.geo;
    let x;
    let y;
    if (state.map) {
      const point = state.map.latLngToContainerPoint([lat, lon]);
      x = point.x;
      y = point.y;
    } else {
      x = ((lon + 180) / 360) * width;
      y = ((90 - lat) / 180) * height;
    }
    const layer = getLayerForItem(item);
    const type = getSignalType(item);
    return { x, y, item, layer, type };
  }).filter((point) => state.settings.mapLayers[point.layer]);

  if (elements.mapEmpty) {
    elements.mapEmpty.classList.toggle('show', rawPoints.length === 0);
  }

  const clusters = clusterMapPoints(rawPoints);
  const zoomLevel = state.map ? state.map.getZoom() : 2;
  clusters.forEach((cluster) => {
    ctx.beginPath();
    ctx.fillStyle = cluster.color;
    ctx.arc(cluster.x, cluster.y, cluster.radius, 0, Math.PI * 2);
    ctx.fill();

    if (cluster.count > 1) {
      ctx.strokeStyle = 'rgba(10, 15, 20, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#0a0f14';
      ctx.font = '600 11px "Atkinson Hyperlegible", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cluster.count > 99 ? '99+' : String(cluster.count), cluster.x, cluster.y);
      return;
    }

    if (zoomLevel >= 3) {
      ctx.fillStyle = '#0a0f14';
      const iconText = cluster.icon || 'N';
      const fontSize = iconText.length > 1 ? 9 : 10;
      ctx.font = `700 ${fontSize}px "Atkinson Hyperlegible", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(iconText, cluster.x, cluster.y);
    }
  });

  state.mapPoints = clusters;

  if (state.location && state.settings.mapLayers.local) {
    let x;
    let y;
    let radius;
    if (state.map) {
      const center = state.map.latLngToContainerPoint([state.location.lat, state.location.lon]);
      const metersPerPixel = 156543.03392 * Math.cos(state.location.lat * Math.PI / 180) / Math.pow(2, state.map.getZoom());
      radius = (state.settings.radiusKm * 1000) / metersPerPixel;
      x = center.x;
      y = center.y;
    } else {
      x = ((state.location.lon + 180) / 360) * width;
      y = ((90 - state.location.lat) / 180) * height;
      radius = (state.settings.radiusKm / 20037) * width * 2;
    }

    ctx.strokeStyle = 'rgba(200,255,106,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function updateMapViewForScope() {
  if (!state.map) return;
  const padding = { padding: [40, 40], maxZoom: 7 };
  if (state.settings.scope === 'global') {
    state.map.fitBounds([[-60, -180], [75, 180]], { padding: [20, 20], maxZoom: 3 });
    return;
  }
  if (state.settings.scope === 'us') {
    state.map.fitBounds([[24, -125], [49, -66]], padding);
    return;
  }
  if (state.settings.scope === 'local') {
    const { lat, lon } = state.location;
    const latDelta = state.settings.radiusKm / 110.574;
    const lonDelta = state.settings.radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    state.map.fitBounds([[lat - latDelta, lon - lonDelta], [lat + latDelta, lon + lonDelta]], { padding: [30, 30], maxZoom: 9 });
  }
}

function updateMapTooltip(event) {
  const rect = elements.mapCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = state.mapPoints.find((point) => {
    const dx = point.x - x;
    const dy = point.y - y;
    return Math.sqrt(dx * dx + dy * dy) < (point.radius + 6);
  });

  if (!hit) {
    elements.mapTooltip.style.display = 'none';
    if (elements.mapWrap) elements.mapWrap.style.cursor = 'default';
    return;
  }

  if (elements.mapWrap) elements.mapWrap.style.cursor = 'pointer';
  elements.mapTooltip.style.display = 'block';
  elements.mapTooltip.style.left = `${Math.min(x + 12, rect.width - 220)}px`;
  elements.mapTooltip.style.top = `${Math.max(y - 12, 10)}px`;
  if (hit.count > 1) {
    const preview = hit.items.slice(0, 2).map((item) => item.translatedTitle || item.title).join(' | ');
    elements.mapTooltip.textContent = `${hit.count} signals: ${preview}`;
  } else {
    elements.mapTooltip.textContent = hit.primary.translatedTitle || hit.primary.title;
  }
}

function hideMapDetail() {
  if (!elements.mapDetail) return;
  elements.mapDetail.classList.remove('show');
}

function showMapDetail(cluster, x, y) {
  if (!elements.mapDetail || !elements.mapDetailList) return;
  const list = elements.mapDetailList;
  list.innerHTML = '';
  const rect = (elements.mapWrap || elements.mapCanvas).getBoundingClientRect();
  const left = Math.min(x + 12, rect.width - 320);
  const top = Math.min(y + 12, rect.height - 220);
  elements.mapDetail.style.left = `${Math.max(12, left)}px`;
  elements.mapDetail.style.top = `${Math.max(12, top)}px`;
  if (elements.mapDetailMeta) {
    elements.mapDetailMeta.textContent = `${cluster.count} signals in view`;
  }

  const resolveLocation = (item) => {
    if (item.geoLabel) return item.geoLabel;
    if (item.location) return item.location;
    if (item.area) return item.area;
    if (item.title && item.title.includes(' - ')) {
      const parts = item.title.split(' - ');
      if (parts[1]) return parts.slice(1).join(' - ').trim();
    }
    if (item.geo && Number.isFinite(item.geo.lat) && Number.isFinite(item.geo.lon)) {
      return `${item.geo.lat.toFixed(2)}, ${item.geo.lon.toFixed(2)}`;
    }
    return '';
  };

  const resolveSeverity = (item) => {
    if (item.severity) return item.severity;
    if (item.category === 'travel' && item.title) {
      const match = item.title.match(/Level\\s*(\\d)/i);
      if (match) return `Level ${match[1]}`;
    }
    return '';
  };

  const resolveAlertType = (item) => {
    if (item.alertType) return item.alertType;
    if (item.category === 'travel') return 'Travel Notice';
    if (item.category === 'space') return 'Space Weather';
    if (item.category === 'weather') return 'Weather Alert';
    if (item.category === 'disaster') return 'Disaster';
    if (item.category === 'transport') return 'Transport';
    return '';
  };

  const resolveRegionChips = (item) => {
    const chips = new Set();
    if (item.tags?.includes('us')) chips.add('US');
    if (item.tags?.includes('global')) chips.add('Global');
    if (item.category === 'travel') {
      const travelRegion = extractTravelRegion(item.title || '');
      if (travelRegion) chips.add(travelRegion);
    }
    const locationText = item.geoLabel || item.location || item.area || '';
    const region = extractRegionFromText(locationText);
    if (region) chips.add(region);
    return Array.from(chips).slice(0, 3);
  };

  cluster.items.slice(0, 8).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'map-detail-item';
    const title = document.createElement('div');
    title.className = 'map-detail-title';
    title.textContent = item.translatedTitle || item.title;
    const meta = document.createElement('div');
    meta.className = 'map-detail-meta';
    meta.textContent = `${item.source || 'Source'} • ${toRelativeTime(item.publishedAt || Date.now())}`;
    const badges = document.createElement('div');
    badges.className = 'map-detail-badges';
    const categoryBadge = document.createElement('span');
    categoryBadge.className = `badge badge-${item.category || 'news'}`;
    categoryBadge.textContent = categoryLabels[item.category] || item.category || 'Signal';
    badges.appendChild(categoryBadge);
    const alertType = resolveAlertType(item);
    if (alertType) {
      const alertBadge = document.createElement('span');
      alertBadge.className = 'badge badge-alert';
      alertBadge.textContent = alertType;
      badges.appendChild(alertBadge);
    }
    const regions = resolveRegionChips(item);
    regions.forEach((region) => {
      const regionBadge = document.createElement('span');
      regionBadge.className = 'badge badge-region';
      regionBadge.textContent = region;
      badges.appendChild(regionBadge);
    });
    const locationText = resolveLocation(item);
    const severityText = resolveSeverity(item);
    const info = document.createElement('div');
    info.className = 'map-detail-info';
    if (locationText) {
      const locationRow = document.createElement('div');
      locationRow.className = 'map-detail-info-row';
      locationRow.innerHTML = `<span>Location</span><strong>${locationText}</strong>`;
      info.appendChild(locationRow);
    }
    if (severityText) {
      const severityRow = document.createElement('div');
      severityRow.className = 'map-detail-info-row';
      severityRow.innerHTML = `<span>Severity</span><strong>${severityText}</strong>`;
      info.appendChild(severityRow);
    }
    const summaryText = (item.translatedSummary || item.summary || '').trim();
    const summary = document.createElement('div');
    summary.className = 'map-detail-summary';
    summary.textContent = summaryText || 'Tap to open full details.';
    row.appendChild(title);
    row.appendChild(badges);
    row.appendChild(meta);
    if (info.childNodes.length) {
      row.appendChild(info);
    }
    row.appendChild(summary);
    row.addEventListener('click', () => {
      if (item.url) {
        window.open(item.url, '_blank', 'noopener');
      }
    });
    list.appendChild(row);
    if (state.settings.languageMode === 'translate' && item.isNonEnglish) {
      translateItem(item, title, null);
    }
  });

  if (cluster.count > 8) {
    const more = document.createElement('div');
    more.className = 'map-detail-more';
    more.textContent = `+${cluster.count - 8} more signals`;
    list.appendChild(more);
  }

  elements.mapDetail.classList.add('show');
}

function handleMapClick(event) {
  const rect = elements.mapCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = state.mapPoints.find((point) => {
    const dx = point.x - x;
    const dy = point.y - y;
    return Math.sqrt(dx * dx + dy * dy) < (point.radius + 6);
  });
  if (!hit) {
    hideMapDetail();
    return;
  }
  showMapDetail(hit, x, y);
}

function updateChatStatus() {
  if (!elements.chatLog) return;
  let bubble = elements.chatLog.querySelector('.chat-bubble.system');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'chat-bubble system';
    elements.chatLog.prepend(bubble);
  }
  const key = state.keys.openai?.key;
  if (isStaticMode()) {
    const proxyUrl = getOpenAiProxy();
    if (proxyUrl) {
      bubble.textContent = key
        ? 'AI connected via proxy (using your key).'
        : 'AI connected via proxy. Add a key to override.';
      return;
    }
    if (state.settings.superMonitor) {
      bubble.textContent = state.keys.openai?.key
        ? 'Super Monitor Mode: OpenAI key stored (proxy required on GitHub Pages).'
        : 'Super Monitor Mode is on. Add an OpenAI key; chat still needs a proxy.';
    } else {
      bubble.textContent = 'Static mode: AI chat needs a proxy. Briefings use the cached snapshot when available.';
    }
    return;
  }
  bubble.textContent = state.keys.openai?.key
    ? 'AI connected. Ask a question or request a briefing.'
    : 'Connect an AI provider to enable live responses.';
}

function showSearchResults(items, label) {
  if (!elements.searchResults || !elements.searchResultsList) return;
  elements.searchResultsList.innerHTML = '';
  renderList(elements.searchResultsList, items.slice(0, 25));
  if (elements.searchResultsMeta) {
    elements.searchResultsMeta.textContent = label;
  }
  elements.searchResults.classList.add('open');
}

function hideSearchResults() {
  if (!elements.searchResults) return;
  elements.searchResults.classList.remove('open');
  if (elements.searchResultsList) {
    elements.searchResultsList.innerHTML = '';
  }
  if (elements.searchResultsMeta) {
    elements.searchResultsMeta.textContent = 'Awaiting query';
  }
}

async function refreshAll(force = false) {
  setRefreshing(true);
  setHealth('Fetching feeds');
  try {
    if (isStaticMode()) {
      await loadStaticAnalysis();
      await loadStaticBuild();
    }
    const results = await Promise.all(state.feeds.map(async (feed) => {
      const query = feed.supportsQuery ? translateQuery(feed, feed.defaultQuery || '') : undefined;
      if (shouldFetchLiveInStatic(feed)) {
        try {
          const live = await fetchCustomFeedDirect(feed, query);
          if (!live.error) return live;
          const fallback = await fetchFeed(feed, query, force);
          return fallback;
        } catch {
          // fall through to static cache
        }
      }
      return fetchFeed(feed, query, force).catch(() => ({
        feed,
        items: [],
        error: 'fetch_failed',
        httpStatus: 0,
        fetchedAt: Date.now()
      }));
    }));

    results.forEach((result) => {
    state.feedStatus[result.feed.id] = {
      httpStatus: result.httpStatus,
      error: result.error,
      errorMessage: result.errorMessage,
      fetchedAt: result.fetchedAt,
      count: result.items.length
    };
    });

    const items = results.flatMap((result) => result.items || []);
    state.items = items.map((item) => enrichItem({
      ...item,
      url: canonicalUrl(item.url),
      isNonEnglish: isNonEnglish(`${item.title || ''} ${item.summary || ''}`),
      feedId: item.feedId || null
    }));

    state.scopedItems = applyScope(state.items);
    state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
    state.lastFetch = Date.now();
    updateDataFreshBadge();
    const issueCount = countCriticalIssues(results);
    setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');

    renderAllPanels();
    renderSignals();
    renderFeedHealth();
    drawMap();
    generateAnalysis(false);
    maybeAutoRunAnalysis();
    await refreshCustomTickers();
    renderTicker();
    renderFinanceSpotlight();

    geocodeItems(state.items).then((geocodeUpdated) => {
      if (!geocodeUpdated) return;
      state.scopedItems = applyScope(state.items);
      if (state.settings.scope === 'local') {
        state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
        renderAllPanels();
      } else {
        renderLocal();
      }
      renderSignals();
      renderFeedHealth();
      drawMap();
      renderTicker();
    }).catch(() => {});
    if (issueCount) {
      retryFailedFeeds();
    }
    retryStaleFeeds(results);
  } finally {
    setRefreshing(false);
  }
}

async function retryFailedFeeds() {
  if (state.retryingFeeds) return;
  const failedFeeds = state.feeds.filter((feed) => state.feedStatus[feed.id]?.error === 'fetch_failed');
  if (!failedFeeds.length) return;
  state.retryingFeeds = true;

  const seen = new Set(state.items.map((item) => item.url || item.title));
  const newItems = [];

  for (const feed of failedFeeds) {
    const query = feed.supportsQuery ? translateQuery(feed, feed.defaultQuery || '') : undefined;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchFeed(feed, query, true);
      state.feedStatus[result.feed.id] = {
        httpStatus: result.httpStatus,
        error: result.error,
        errorMessage: result.errorMessage,
        fetchedAt: result.fetchedAt,
        count: result.items.length
      };
      result.items.forEach((item) => {
        const key = item.url || item.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        newItems.push({
          ...item,
          url: canonicalUrl(item.url)
        });
      });
    } catch (err) {
      // Keep original error status.
    }
  }

  if (newItems.length) {
    state.items = [...state.items, ...newItems];
    state.scopedItems = applyScope(state.items);
    state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
    renderAllPanels();
    renderSignals();
    drawMap();
  }

  renderFeedHealth();
  const issueCount = countCriticalIssues(state.feeds.map((feed) => ({
    feed,
    ...state.feedStatus[feed.id]
  })));
  setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');
  state.retryingFeeds = false;
}

async function retryStaleFeeds(results) {
  if (state.staleRetrying) return;
  if (isStaticMode() && !state.settings.superMonitor) return;
  const now = Date.now();
  if (now - state.lastStaleRetry < 2 * 60 * 1000) return;
  const staleFeeds = state.feeds.filter((feed) => {
    const status = state.feedStatus[feed.id];
    if (!status || status.error) return false;
    if (isStaticMode() && feed.keySource === 'server') return false;
    return isFeedStale(feed, status);
  });
  if (!staleFeeds.length) return;
  state.staleRetrying = true;
  state.lastStaleRetry = now;

  const seen = new Set(state.items.map((item) => item.url || item.title));
  const newItems = [];

  for (const feed of staleFeeds) {
    const query = feed.supportsQuery ? translateQuery(feed, feed.defaultQuery || '') : undefined;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchFeed(feed, query, true);
      state.feedStatus[result.feed.id] = {
        httpStatus: result.httpStatus,
        error: result.error,
        errorMessage: result.errorMessage,
        fetchedAt: result.fetchedAt,
        count: result.items.length
      };
      result.items.forEach((item) => {
        const key = item.url || item.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        newItems.push({
          ...item,
          url: canonicalUrl(item.url)
        });
      });
    } catch {
      // keep existing data
    }
  }

  if (newItems.length) {
    state.items = [...state.items, ...newItems];
    state.scopedItems = applyScope(state.items);
    state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
    renderAllPanels();
    renderSignals();
    drawMap();
  }

  renderFeedHealth();
  const issueCount = countCriticalIssues(state.feeds.map((feed) => ({
    feed,
    ...state.feedStatus[feed.id]
  })));
  setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');
  state.staleRetrying = false;
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => refreshAll(), state.settings.refreshMinutes * 60 * 1000);
}

async function handleSearch() {
  const query = elements.searchInput.value.trim();
  const scope = elements.feedScope.value || 'all';
  if (!query) {
    elements.searchHint.textContent = 'Enter a search term to query signals.';
    showSearchResults([], 'Enter a search term');
    return;
  }

  const originalLabel = elements.searchBtn?.textContent;
  if (elements.searchBtn) {
    elements.searchBtn.disabled = true;
    elements.searchBtn.textContent = 'Searching...';
  }

  try {
    const normalizedQuery = query.toLowerCase();
    const liveSearchFeeds = isStaticMode() && state.settings.liveSearch ? getLiveSearchFeeds() : [];
    const runLiveSearch = async (feeds) => {
      if (!feeds.length) return [];
      const results = await Promise.all(feeds.map(async (feed) => {
        const translated = await translateQueryAsync(feed, query);
        return fetchCustomFeedDirect(feed, translated);
      }));
      return results.flatMap((result) => result.items || []);
    };
    if (state.searchCategories.length) {
      const selected = state.searchCategories;
      const filtered = state.scopedItems.filter((item) => selected.includes(item.category)).filter((item) => {
        const text = `${item.title} ${item.summary || ''}`.toLowerCase();
        return text.includes(normalizedQuery);
      });
      const liveFeeds = liveSearchFeeds.filter((feed) => selected.includes(feed.category));
      if (liveFeeds.length) {
        elements.searchHint.textContent = 'Searching live sources...';
      }
      const liveItems = await runLiveSearch(liveFeeds);
      const combined = [...filtered, ...liveItems];
      const deduped = dedupeItems(combined);
      const freshFiltered = applyFreshnessFilter(deduped);
      showSearchResults(freshFiltered, `${freshFiltered.length} matches in ${selected.map((cat) => categoryLabels[cat] || cat).join(', ')}`);
      elements.searchHint.textContent = liveFeeds.length
        ? 'Showing cached + live search results.'
        : 'Showing multi-category search results.';
      return;
    }

    if (scope === 'all') {
      const filtered = state.scopedItems.filter((item) => {
        const text = `${item.title} ${item.summary || ''}`.toLowerCase();
        return text.includes(normalizedQuery);
      });
      if (liveSearchFeeds.length) {
        elements.searchHint.textContent = 'Searching live sources...';
      }
      const liveItems = await runLiveSearch(liveSearchFeeds);
      const combined = [...filtered, ...liveItems];
      const deduped = dedupeItems(combined);
      const freshFiltered = applyFreshnessFilter(deduped);
      showSearchResults(freshFiltered, `${freshFiltered.length} matches across all feeds`);
      elements.searchHint.textContent = liveSearchFeeds.length
        ? `Showing cached + live results (${freshFiltered.length}).`
        : `Showing ${freshFiltered.length} matches across all feeds.`;
      return;
    }

    if (scope.startsWith('cat:')) {
      const category = scope.replace('cat:', '');
      const filtered = state.scopedItems.filter((item) => item.category === category).filter((item) => {
        const text = `${item.title} ${item.summary || ''}`.toLowerCase();
        return text.includes(normalizedQuery);
      });
      const liveFeeds = liveSearchFeeds.filter((feed) => feed.category === category);
      if (liveFeeds.length) {
        elements.searchHint.textContent = 'Searching live sources...';
      }
      const liveItems = await runLiveSearch(liveFeeds);
      const combined = [...filtered, ...liveItems];
      const deduped = dedupeItems(combined);
      const freshFiltered = applyFreshnessFilter(deduped);
      showSearchResults(freshFiltered, `${freshFiltered.length} matches in ${categoryLabels[category] || category}`);
      elements.searchHint.textContent = liveFeeds.length
        ? `Showing cached + live results (${freshFiltered.length}).`
        : `Showing ${freshFiltered.length} matches in ${categoryLabels[category] || category}.`;
      return;
    }

    const feed = state.feeds.find((f) => f.id === scope);
    if (!feed) {
      elements.searchHint.textContent = 'Select a feed or category to search.';
      showSearchResults([], 'Select a feed or category');
      return;
    }
    elements.searchHint.textContent = 'Translating query...';
    const translated = await translateQueryAsync(feed, query);
    try {
      if (liveSearchFeeds.find((entry) => entry.id === feed.id)) {
        const result = await fetchCustomFeedDirect(feed, translated);
        const items = applyFreshnessFilter(result.items || []);
        showSearchResults(items, `${items.length} live results from ${feed.name}`);
        elements.searchHint.textContent = `Live search results from ${feed.name}.`;
      } else {
        const result = await fetchFeed(feed, translated, true);
        const items = applyFreshnessFilter(result.items || []);
        showSearchResults(items, `${items.length} results from ${feed.name}`);
        elements.searchHint.textContent = `Search results from ${feed.name}.`;
      }
    } catch (error) {
      elements.searchHint.textContent = `Search failed for ${feed.name}.`;
      showSearchResults([], `Search failed for ${feed.name}`);
    }
  } finally {
    if (elements.searchBtn) {
      elements.searchBtn.disabled = false;
      elements.searchBtn.textContent = originalLabel || 'Search';
    }
  }
}

function requestLocation() {
  if (!elements.geoLocateBtn) return;
  const resetLabel = () => {
    elements.geoLocateBtn.disabled = false;
    elements.geoLocateBtn.textContent = 'Locate Me';
  };

  if (!navigator.geolocation) {
    state.location.source = 'fallback';
    updateSettingsUI();
    elements.geoLocateBtn.textContent = 'Location Unsupported';
    setTimeout(resetLabel, 2200);
    return;
  }

  elements.geoLocateBtn.disabled = true;
  elements.geoLocateBtn.textContent = 'Locating...';

  navigator.geolocation.getCurrentPosition((position) => {
    state.location = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      source: 'geo'
    };
    if (state.map) {
      updateMapViewForScope();
    }
    state.scopedItems = applyScope(state.items);
    updateSettingsUI();
    drawMap();
    renderLocal();
    renderSignals();
    elements.geoLocateBtn.textContent = 'Geolocated';
    setTimeout(resetLabel, 1800);
  }, () => {
    state.location.source = 'fallback';
    updateSettingsUI();
    elements.geoLocateBtn.textContent = 'Location Blocked';
    setTimeout(resetLabel, 2400);
  }, { enableHighAccuracy: false, timeout: 7000 });
}

function initEvents() {
  elements.exportSnapshot.addEventListener('click', exportSnapshot);
  elements.refreshNow.addEventListener('click', () => refreshAll(true));
  elements.settingsToggle.addEventListener('click', () => toggleSettings(true));
  elements.settingsClose.addEventListener('click', () => toggleSettings(false));
  if (elements.sidebarSettings) {
    elements.sidebarSettings.addEventListener('click', () => {
      toggleSettings(true);
      setNavOpen(false);
    });
  }
  if (elements.sidebarAbout) {
    elements.sidebarAbout.addEventListener('click', () => {
      toggleAbout(true);
      setNavOpen(false);
    });
  }
  if (elements.navToggle) {
    elements.navToggle.addEventListener('click', () => {
      const isOpen = elements.app?.classList.contains('nav-open');
      setNavOpen(!isOpen);
    });
  }
  if (elements.sidebarScrim) {
    elements.sidebarScrim.addEventListener('click', () => setNavOpen(false));
  }
  if (elements.aboutOpen) {
    elements.aboutOpen.addEventListener('click', () => toggleAbout(true));
  }
  if (elements.aboutOpenSettings) {
    elements.aboutOpenSettings.addEventListener('click', () => toggleAbout(true));
  }
  if (elements.aboutClose) {
    elements.aboutClose.addEventListener('click', () => toggleAbout(false));
  }
  if (elements.aboutOverlay) {
    elements.aboutOverlay.addEventListener('click', (event) => {
      if (event.target === elements.aboutOverlay) {
        toggleAbout(false);
      }
    });
  }
  elements.feedScope.addEventListener('change', () => {
    if (elements.feedScope.value !== 'all' && !elements.feedScope.value.startsWith('cat:')) {
      state.searchCategories = [];
      updateCategoryFilters();
    }
  });
  elements.searchBtn.addEventListener('click', handleSearch);
  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleSearch();
  });
  if (elements.liveSearchToggle) {
    elements.liveSearchToggle.addEventListener('click', () => {
      state.settings.liveSearch = !state.settings.liveSearch;
      saveSettings();
      updateSettingsUI();
    });
  }
  if (elements.savedSearches) {
    elements.savedSearches.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-query]');
      if (!btn) return;
      elements.searchInput.value = btn.dataset.query || '';
      handleSearch();
    });
  }
  if (elements.financeTabs) {
    elements.financeTabs.addEventListener('click', (event) => {
      const btn = event.target.closest('.tab');
      if (!btn) return;
      const tab = btn.dataset.tab;
      elements.financeTabs.querySelectorAll('.tab').forEach((el) => {
        el.classList.toggle('active', el === btn);
      });
      document.querySelectorAll('.finance-panel .tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === (tab === 'markets' ? 'financeMarketsList' : 'financePolicyList'));
      });
    });
  }
  if (elements.statusToggle) {
    elements.statusToggle.addEventListener('click', () => {
      state.settings.showStatus = !state.settings.showStatus;
      saveSettings();
      updateSettingsUI();
    });
  }
  if (elements.keyToggle) {
    elements.keyToggle.addEventListener('click', () => {
      state.settings.showKeys = !state.settings.showKeys;
      saveSettings();
      updateSettingsUI();
    });
  }
  if (elements.travelTickerBtn) {
    elements.travelTickerBtn.addEventListener('click', () => {
      state.settings.showTravelTicker = !state.settings.showTravelTicker;
      saveSettings();
      updateSettingsUI();
      renderTravelTicker();
    });
  }

  document.querySelectorAll('.ticker-builder-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const builder = document.querySelector(`.ticker-builder[data-builder="${target}"]`);
      if (!builder) return;
      builder.classList.toggle('open');
    });
  });

  document.querySelectorAll('.ticker-builder').forEach((builder) => {
    const addBtn = builder.querySelector('.ticker-add');
    const queryInput = builder.querySelector('.ticker-query');
    if (addBtn) {
      addBtn.addEventListener('click', () => handleTickerAdd(builder));
    }
    if (queryInput) {
      queryInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          handleTickerAdd(builder);
        }
      });
    }
  });

  document.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.ticker-remove');
    if (!removeBtn) return;
    const key = removeBtn.dataset.key;
    if (!key) return;
    removeTickerFromWatchlist(key);
  });

  elements.refreshRange.addEventListener('input', (event) => {
    state.settings.refreshMinutes = Number(event.target.value);
    saveSettings();
    updateSettingsUI();
    startAutoRefresh();
  });

  elements.radiusRange.addEventListener('input', (event) => {
    state.settings.radiusKm = Number(event.target.value);
    saveSettings();
    updateSettingsUI();
    renderLocal();
    drawMap();
    maybeAutoRunAnalysis();
  });

  if (elements.maxAgeRange) {
    elements.maxAgeRange.addEventListener('input', (event) => {
      state.settings.maxAgeDays = Number(event.target.value);
      saveSettings();
      updateSettingsUI();
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      renderAllPanels();
      renderSignals();
      drawMap();
      maybeAutoRunAnalysis();
    });
  }

  if (elements.languageToggle) {
    elements.languageToggle.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      state.settings.languageMode = btn.dataset.language;
      saveSettings();
      updateSettingsUI();
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      renderAllPanels();
      renderSignals();
      drawMap();
      maybeAutoRunAnalysis();
    });
  }

  elements.themeToggle.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    applyTheme(btn.dataset.theme);
    saveSettings();
    updateSettingsUI();
  });

  if (elements.ageToggle) {
    elements.ageToggle.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      const age = Number(btn.dataset.age);
      if (!Number.isFinite(age)) return;
      state.settings.maxAgeDays = age;
      saveSettings();
      updateSettingsUI();
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      renderAllPanels();
      renderSignals();
      drawMap();
    });
  }

  elements.scopeToggle.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    state.settings.scope = btn.dataset.scope;
    state.scopedItems = applyScope(state.items);
    state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
    updateScopeButtons();
    updateMapViewForScope();
    renderAllPanels();
    renderSignals();
    drawMap();
    maybeAutoRunAnalysis();
  });

  if (elements.geoLocateBtn) {
    elements.geoLocateBtn.addEventListener('click', requestLocation);
  }

  if (elements.aiTranslateToggle) {
    elements.aiTranslateToggle.addEventListener('change', (event) => {
      state.settings.aiTranslate = event.target.checked;
      saveSettings();
      updateSettingsUI();
      maybeAutoRunAnalysis();
    });
  }

  if (elements.superMonitorToggle) {
    elements.superMonitorToggle.addEventListener('change', (event) => {
      state.settings.superMonitor = event.target.checked;
      saveSettings();
      updateSettingsUI();
      updateChatStatus();
      maybeAutoRunAnalysis();
    });
  }

  if (elements.mapLegendBtn && elements.mapLegend) {
    elements.mapLegendBtn.addEventListener('click', () => {
      elements.mapLegend.classList.toggle('show');
    });

    elements.mapLegend.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-layer]');
      if (input) {
        const layer = input.dataset.layer;
        state.settings.mapLayers[layer] = input.checked;
        saveSettings();
        drawMap();
        return;
      }
      const baseInput = event.target.closest('input[data-basemap]');
      if (baseInput) {
        applyMapBasemap(baseInput.dataset.basemap);
        drawMap();
        return;
      }
      const overlayInput = event.target.closest('input[data-overlay]');
      if (overlayInput) {
        const overlay = overlayInput.dataset.overlay;
        state.settings.mapRasterOverlays[overlay] = overlayInput.checked;
        saveSettings();
        syncMapRasterOverlays();
        if (overlay === 'sar' && overlayInput.checked) {
          resolveLatestSarDate();
        }
      }
    });

    document.addEventListener('click', (event) => {
      if (!elements.mapLegend.classList.contains('show')) return;
      if (elements.mapLegend.contains(event.target) || elements.mapLegendBtn.contains(event.target)) return;
      elements.mapLegend.classList.remove('show');
    });
  }

  if (elements.imageryDateInput) {
    elements.imageryDateInput.addEventListener('change', (event) => {
      state.imageryDateManual = true;
      updateImageryDate(event.target.value);
    });
  }

  if (elements.sarDateInput) {
    elements.sarDateInput.addEventListener('change', (event) => {
      state.sarDateManual = true;
      updateSarDate(event.target.value);
    });
  }

  if (elements.imageryDatePanel) {
    elements.imageryDatePanel.addEventListener('change', (event) => {
      state.imageryDateManual = true;
      updateImageryDate(event.target.value);
    });
  }

  if (elements.sarDatePanel) {
    elements.sarDatePanel.addEventListener('change', (event) => {
      state.sarDateManual = true;
      updateSarDate(event.target.value);
    });
  }

  const triggerImageryAuto = () => {
    state.imageryDateManual = false;
    resolveLatestImageryDate();
  };
  const triggerSarAuto = () => {
    state.sarDateManual = false;
    resolveLatestSarDate();
  };
  if (elements.imageryAutoBtn) {
    elements.imageryAutoBtn.addEventListener('click', triggerImageryAuto);
  }
  if (elements.imageryPanelAutoBtn) {
    elements.imageryPanelAutoBtn.addEventListener('click', triggerImageryAuto);
  }
  if (elements.sarAutoBtn) {
    elements.sarAutoBtn.addEventListener('click', triggerSarAuto);
  }
  if (elements.sarPanelAutoBtn) {
    elements.sarPanelAutoBtn.addEventListener('click', triggerSarAuto);
  }
  if (elements.imageryResetBtn) {
    elements.imageryResetBtn.addEventListener('click', resetImagerySettings);
  }
  if (elements.imageryResetPanelBtn) {
    elements.imageryResetPanelBtn.addEventListener('click', resetImagerySettings);
  }

  document.querySelectorAll('[data-imagery-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      applyMapPreset(button.dataset.imageryPreset);
    });
  });

  document.querySelectorAll('[data-imagery-basemap]').forEach((button) => {
    button.addEventListener('click', () => {
      applyMapBasemap(button.dataset.imageryBasemap);
      updateImageryPanelUI();
    });
  });

  document.querySelectorAll('[data-imagery-overlay]').forEach((button) => {
    button.addEventListener('click', () => {
      const overlay = button.dataset.imageryOverlay;
      const next = !state.settings.mapRasterOverlays?.[overlay];
      state.settings.mapRasterOverlays[overlay] = next;
      saveSettings();
      syncMapRasterOverlays();
      if (overlay === 'sar' && next) {
        resolveLatestSarDate();
      }
      updateImageryPanelUI();
      updateMapLegendUI();
    });
  });

  document.querySelectorAll('[data-overlay-opacity]').forEach((input) => {
    input.addEventListener('input', () => {
      const overlay = input.dataset.overlayOpacity;
      const value = Math.max(0, Math.min(100, Number(input.value))) / 100;
      state.settings.mapOverlayOpacity[overlay] = value;
      saveSettings();
      syncMapRasterOverlays();
      updateImageryPanelUI();
    });
  });

  if (elements.customFeedToggle) {
    elements.customFeedToggle.addEventListener('click', () => {
      const isHidden = elements.customFeedForm?.classList.contains('hidden');
      if (isHidden) {
        resetCustomFeedForm();
      }
      toggleCustomFeedForm(isHidden);
    });
  }
  if (elements.customFeedExport) {
    elements.customFeedExport.addEventListener('click', () => {
      exportCustomFeedsJson();
    });
  }
  if (elements.customFeedDownload) {
    elements.customFeedDownload.addEventListener('click', () => {
      const jsonText = elements.customFeedJson?.value?.trim() || getCustomFeedsExportString();
      const blob = new Blob([jsonText], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'custom-feeds.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      if (elements.customFeedJsonStatus) {
        elements.customFeedJsonStatus.textContent = 'Downloaded custom feeds JSON.';
      }
    });
  }
  if (elements.customFeedOpen) {
    elements.customFeedOpen.addEventListener('click', () => {
      const url = getAssetUrl('data/feeds.json');
      window.open(url, '_blank', 'noopener');
    });
  }
  if (elements.customFeedImportToggle) {
    elements.customFeedImportToggle.addEventListener('click', () => {
      const isHidden = elements.customFeedJsonPanel?.classList.contains('hidden');
      toggleCustomFeedJsonPanel(isHidden);
    });
  }
  if (elements.customFeedJsonCopy) {
    elements.customFeedJsonCopy.addEventListener('click', async () => {
      if (!elements.customFeedJson) return;
      try {
        await navigator.clipboard.writeText(elements.customFeedJson.value || '');
        if (elements.customFeedStatus) elements.customFeedStatus.textContent = 'Copied feed JSON to clipboard.';
      } catch (error) {
        if (elements.customFeedStatus) elements.customFeedStatus.textContent = 'Copy failed. Select and copy manually.';
      }
    });
  }
  if (elements.customFeedJsonApply) {
    elements.customFeedJsonApply.addEventListener('click', () => {
      applyCustomFeedsJson();
    });
  }
  if (elements.customFeedCancel) {
    elements.customFeedCancel.addEventListener('click', () => {
      toggleCustomFeedForm(false);
    });
  }
  if (elements.customFeedSave) {
    elements.customFeedSave.addEventListener('click', () => {
      const { feed, error } = collectCustomFeedForm();
      if (error) {
        if (elements.customFeedStatus) {
          elements.customFeedStatus.textContent = error;
        }
        return;
      }
      if (editingCustomFeedId) {
        state.customFeeds = state.customFeeds.filter((entry) => entry.id !== editingCustomFeedId);
      }
      if (!feed.id) {
        feed.id = `custom-${hashString(feed.url || feed.name)}`;
      }
      state.customFeeds = [...state.customFeeds, feed];
      saveCustomFeeds();
      state.feeds = mergeCustomFeeds(state.baseFeeds, state.customFeeds);
      buildCustomFeedList();
      buildFeedOptions();
      buildKeyManager();
      toggleCustomFeedForm(false);
      refreshAll(true);
    });
  }

  if (elements.customFeedRequiresKey) {
    elements.customFeedRequiresKey.addEventListener('change', () => {
      const enabled = elements.customFeedRequiresKey.checked;
      elements.customFeedKeyParam.disabled = !enabled;
      elements.customFeedKeyHeader.disabled = !enabled;
    });
  }
  if (elements.customFeedSupportsQuery) {
    elements.customFeedSupportsQuery.addEventListener('change', () => {
      elements.customFeedDefaultQuery.disabled = !elements.customFeedSupportsQuery.checked;
    });
  }
  if (elements.mapDetailClose) {
    elements.mapDetailClose.addEventListener('click', hideMapDetail);
  }
  if (elements.searchResultsClose) {
    elements.searchResultsClose.addEventListener('click', hideSearchResults);
  }

  const mapTarget = elements.mapBase || elements.mapCanvas;
  mapTarget.addEventListener('mousemove', updateMapTooltip);
  mapTarget.addEventListener('mouseleave', () => {
    elements.mapTooltip.style.display = 'none';
  });
  mapTarget.addEventListener('click', handleMapClick);

  elements.analysisRun.addEventListener('click', runAiAnalysis);

  elements.resetLayout.addEventListener('click', resetLayout);

  elements.chatSend.addEventListener('click', sendChatMessage);
  elements.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChatMessage();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') {
      applyTheme('system');
    }
  });

  window.addEventListener('resize', () => {
    if (state.map) {
      state.map.invalidateSize();
    }
    if (state.energyMap) {
      state.energyMap.invalidateSize();
    }
    drawMap();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      toggleAbout(false);
      toggleListModal(false);
      setNavOpen(false);
    }
  });
}

async function init() {
  loadSettings();
  loadKeys();
  loadKeyGroups();
  loadKeyStatus();
  loadGeoCache();
  state.customFeeds = loadCustomFeeds();
  applyTheme(state.settings.theme);
  updateSettingsUI();
  loadPanelState();
  state.panels.defaultOrder = getPanelRegistry().map((panel) => panel.id);
  if (state.panels.order.length && state.panels.order.length !== state.panels.defaultOrder.length) {
    state.panels.order = [...state.panels.defaultOrder];
    savePanelState();
  }
  applyPanelOrder();
  applyPanelVisibility();
  applyPanelSizes();
  buildPanelToggles();
  updateCategoryFilters();
  initPanelDrag();
  initPanelResize();
  document.querySelectorAll('.key-chip').forEach((el) => el.remove());

  let payload;
  try {
    const result = await apiJson('/api/feeds');
    payload = result.data;
    if (result.error || !payload) {
      throw new Error('Feed API unreachable');
    }
  } catch (err) {
    setHealth('API offline');
    if (elements.feedHealth) {
      elements.feedHealth.innerHTML = isStaticMode()
        ? '<div class="settings-note">Static snapshot mode: feeds load from the latest published cache.</div>'
        : '<div class="settings-note">Feed API unreachable. Check proxy configuration.</div>';
    }
    payload = { feeds: [] };
  }
  state.baseFeeds = (payload.feeds || []).filter((feed) => feed.url || feed.requiresKey || feed.requiresConfig);
  state.feeds = mergeCustomFeeds(state.baseFeeds, state.customFeeds);

  buildFeedOptions();
  populateCustomFeedCategories();
  buildCustomFeedList();
  buildKeyManager();
  updateChatStatus();
  attachKeyButtons();
  initMap();
  updateMapDateUI();
  initEvents();
  initListModal();
  initCommunityEmbed();
  initSidebarNav();
  initCommandSections();
  ensurePanelUpdateBadges();
  renderWatchlistChips();
  requestLocation();
  const params = new URLSearchParams(window.location.search);
  if (params.has('about') || window.location.hash === '#about') {
    toggleAbout(true);
  }
  await loadStaticAnalysis();
  await refreshAll();
  startAutoRefresh();
}

init();
