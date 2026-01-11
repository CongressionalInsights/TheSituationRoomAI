const LAYOUT_VERSION = 2;

const state = {
  feeds: [],
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
  customTickers: [],
  settings: {
    refreshMinutes: 60,
    theme: 'system',
    maxAgeDays: 30,
    languageMode: 'en',
    radiusKm: 150,
    scope: 'global',
    aiTranslate: true,
    showStatus: true,
    showTravelTicker: true,
    showKeys: true,
    tickerWatchlist: [],
    mapLayers: {
      weather: true,
      disaster: true,
      space: true,
      news: true,
      travel: true,
      transport: true,
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
  energyMap: null,
  energyMapLayer: null,
  energyGeo: null,
  energyMapData: null,
  energyMapFetchedAt: 0,
  refreshTimer: null,
  lastFetch: null,
  retryingFeeds: false,
  health: 'Initializing',
  previousSignals: null,
  analysisSignature: null,
  analysisRunning: false
};

const elements = {
  app: document.querySelector('.app'),
  panelGrid: document.getElementById('panelGrid'),
  exportSnapshot: document.getElementById('exportSnapshot'),
  refreshNow: document.getElementById('refreshNow'),
  statusText: document.getElementById('statusText'),
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
  keyManager: document.getElementById('keyManager'),
  feedHealth: document.getElementById('feedHealth'),
  aboutOverlay: document.getElementById('aboutOverlay'),
  aboutOpen: document.getElementById('aboutOpen'),
  aboutOpenSettings: document.getElementById('aboutOpenSettings'),
  aboutClose: document.getElementById('aboutClose'),
  feedScope: document.getElementById('feedScope'),
  searchInput: document.getElementById('searchInput'),
  searchBtn: document.getElementById('searchBtn'),
  searchHint: document.getElementById('searchHint'),
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
};

const defaultPanelSizes = {
  map: { cols: 12 },
  ticker: { cols: 12 },
  'finance-spotlight': { cols: 12 },
  command: { cols: 12 },
  signals: { cols: 5 },
  news: { cols: 6 },
  finance: { cols: 3 },
  crypto: { cols: 3 },
  hazards: { cols: 4 },
  local: { cols: 8 },
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

const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'on', 'with', 'at', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'has', 'have']);
const allowedSummaryTags = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'ul', 'ol', 'li', 'span', 'a', 'font']);
const docsMap = {
  openai: 'https://platform.openai.com/api-keys',
  'energy-eia': 'https://www.eia.gov/opendata/',
  'foia-api': 'https://www.foia.gov/developer/',
  'govinfo-api': 'https://api.govinfo.gov/docs/',
  'openaq-api': 'https://docs.openaq.org/',
  'nasa-firms': 'https://firms.modaps.eosdis.nasa.gov/api/'
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
  local: 'Local'
};
const categoryOrder = ['news', 'finance', 'gov', 'crypto', 'disaster', 'weather', 'space', 'cyber', 'agriculture', 'research', 'energy', 'health', 'travel', 'transport', 'local'];
const globalFallbackCategories = new Set(['crypto', 'research', 'space', 'travel']);
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
      Object.assign(state.settings, parsed);
      state.settings.mapLayers = { ...defaultLayers, ...(parsed.mapLayers || {}) };
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
      if (!Array.isArray(state.settings.tickerWatchlist)) {
        state.settings.tickerWatchlist = [];
      }
    } catch (err) {
      state.settings.aiTranslate = true;
      state.settings.showStatus = true;
      state.settings.showTravelTicker = true;
      state.settings.showKeys = true;
      state.settings.tickerWatchlist = [];
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
  if (mode === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    elements.app.dataset.theme = prefersDark ? 'dark' : 'light';
  } else {
    elements.app.dataset.theme = mode;
  }
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

function updateMapLegendUI() {
  if (!elements.mapLegend) return;
  elements.mapLegend.querySelectorAll('input[data-layer]').forEach((input) => {
    const layer = input.dataset.layer;
    input.checked = Boolean(state.settings.mapLayers[layer]);
  });
}

function getKeyFeeds() {
  const keyFeeds = state.feeds
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

async function testFeedKey(feed, statusEl) {
  const keyConfig = getKeyConfig(feed);
  if (!keyConfig.key) {
    setKeyStatus(feed.id, 'missing', statusEl, 'Missing API key');
    return;
  }
  setKeyStatus(feed.id, 'testing', statusEl, 'Testing key...');

  if (feed.id === 'openai') {
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
      setKeyStatus(feed.id, 'invalid', statusEl, err.message);
    }
    return;
  }

  const url = new URL('/api/feed', window.location.origin);
  url.searchParams.set('id', feed.id);
  url.searchParams.set('force', '1');
  if (feed.supportsQuery && feed.defaultQuery) {
    url.searchParams.set('query', feed.defaultQuery);
  }
  if (keyConfig.key) url.searchParams.set('key', keyConfig.key);
  if (keyConfig.keyParam) url.searchParams.set('keyParam', keyConfig.keyParam);
  if (keyConfig.keyHeader) url.searchParams.set('keyHeader', keyConfig.keyHeader);

  try {
    const res = await fetch(url.toString());
    const payload = await res.json();
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
    const key = canonicalUrl(item.url || '') || normalizeTitle(item.title || '');
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
      return feedParsers[feed.id] ? feedParsers[feed.id](text, feed) : [];
    }
    const data = JSON.parse(text);
    return feedParsers[feed.id] ? feedParsers[feed.id](data, feed) : [];
  } catch (err) {
    return [];
  }
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
  'stooq-quote': parseStooqCsv,
  'opensky-states': (data, feed) => {
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
  const doc = new DOMParser().parseFromString(`<div>${input}</div>`, 'text/html');
  return doc.body.textContent || '';
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

function buildCustomTickerItems() {
  if (!state.customTickers.length) return [];
  return state.customTickers.map((ticker) => {
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

async function refreshCustomTickers() {
  const watchlist = state.settings.tickerWatchlist || [];
  if (!watchlist.length) {
    state.customTickers = [];
    renderWatchlistChips();
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
        isIndex: false
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
      isIndex: entry.isIndex || entry.symbol?.startsWith('^') || quote.symbol?.startsWith('^')
    };
  }));
  state.customTickers = results.filter(Boolean);
  renderWatchlistChips();
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
    setTickerBuilderStatus(builder, 'Added to watchlist.', 'success');
    await refreshCustomTickers();
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

  const wti = pickFirst('energy-eia');
  if (wti?.value) {
    kpis.push({
      label: 'WTI Crude',
      value: formatCompactCurrency(wti.value),
      meta: wti.summary.split(':')[0],
      delta: Number.isFinite(wti.deltaPct) ? wti.deltaPct : null,
      source: wti.source,
      url: wti.url,
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

  const gas = pickFirst('energy-eia-ng');
  if (gas?.value) {
    kpis.push({
      label: 'Nat Gas',
      value: formatCompactCurrency(gas.value),
      meta: gas.summary.split(':')[0],
      delta: Number.isFinite(gas.deltaPct) ? gas.deltaPct : null,
      source: gas.source,
      url: gas.url,
      category: 'energy'
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

  const custom = state.customTickers.map((ticker) => ({
    label: ticker.label || ticker.symbol,
    value: formatTickerValue(ticker),
    meta: ticker.type === 'crypto' ? '24h' : 'Session',
    delta: Number.isFinite(ticker.delta) ? ticker.delta : null,
    url: ticker.url,
    category: ticker.type === 'crypto' ? 'crypto' : 'finance'
  }));

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
  const kpis = buildFinanceKPIs();
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
        const response = await fetch(`/api/geocode?q=${encodeURIComponent(candidate)}`);
        const payload = await response.json();
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
  const url = new URL('/api/feed', window.location.origin);
  url.searchParams.set('id', feed.id);
  if (query) url.searchParams.set('query', query);
  if (force) url.searchParams.set('force', '1');
  const keyConfig = getKeyConfig(feed);
  if (keyConfig.key) url.searchParams.set('key', keyConfig.key);
  if (keyConfig.keyParam) url.searchParams.set('keyParam', keyConfig.keyParam);
  if (keyConfig.keyHeader) url.searchParams.set('keyHeader', keyConfig.keyHeader);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
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
  } finally {
    clearTimeout(timeout);
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
  pushItem(pickFirst('energy-eia'), 'WTI Crude');
  pushItem(pickFirst('energy-eia-brent'), 'Brent Crude');
  pushItem(pickFirst('energy-eia-ng'), 'Nat Gas');
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
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let html = '';
  let listType = null;
  lines.forEach((line) => {
    const unordered = /^[-*•]\s+/.test(line);
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
      const content = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '');
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

function getEiaKey() {
  const groupKey = state.keyGroups?.eia?.key;
  if (groupKey) return groupKey;
  const direct = state.keys?.['energy-eia']?.key
    || state.keys?.['energy-eia-brent']?.key
    || state.keys?.['energy-eia-ng']?.key;
  return direct || '';
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

function renderList(container, items, { withCoverage = false } = {}) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="list-item">No signals yet.</div>';
    return;
  }
  let rendered = 0;
  const contextId = container?.id || '';
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
    if (item.translatedSummary) {
      summary.textContent = item.translatedSummary;
    } else if (item.summaryHtml) {
      summary.innerHTML = sanitizeHtml(item.summaryHtml);
    } else {
      summary.textContent = item.summary || '';
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
  if (!rendered) {
    container.innerHTML = '<div class="list-item">No signals yet.</div>';
  }
}

function renderNews(clusters) {
  const items = clusters.map((cluster) => ({
    title: cluster.primary.title,
    source: Array.from(cluster.sources).slice(0, 2).join(', '),
    summary: cluster.primary.summary,
    summaryHtml: cluster.primary.summaryHtml,
    publishedAt: cluster.updatedAt,
    coverage: cluster.sources.size,
    url: cluster.primary.url,
    isNonEnglish: cluster.primary.isNonEnglish
  }));
  renderList(elements.newsList, items, { withCoverage: true });
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

  elements.newsSaturation.textContent = newsClusters ? newsClusters : '--';
  elements.newsSaturationMeta.textContent = newsClusters
    ? `Clusters across sources ${formatDelta(newsClusters, previous?.newsClusters)}`.trim()
    : 'No clusters yet';

  elements.localEvents.textContent = localItems.length ? localItems.length : '--';
  elements.localEventsMeta.textContent = localItems.length
    ? (state.location.source === 'geo'
      ? `Within local radius ${formatDelta(localItems.length, previous?.localItems)}`
      : `Fallback region ${formatDelta(localItems.length, previous?.localItems)}`)
    : 'No local signals yet';

  const marketCount = marketSignals.length;
  elements.marketPulse.textContent = marketCount ? marketCount : '--';
  elements.marketPulseMeta.textContent = marketCount
    ? `Markets + macro feeds ${formatDelta(marketCount, previous?.marketCount)}`.trim()
    : 'No market signals yet';

  if (elements.signalHealthChip) {
    const degraded = criticalFeedIds
      .map((id) => state.feedStatus[id])
      .filter((status) => status && status.error && status.error !== 'requires_key' && status.error !== 'requires_config');
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

  const issues = entries.filter((entry) => !entry.ok);
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

async function callAssistant({ messages, context, temperature = 0.2, model } = {}) {
  const key = state.keys.openai?.key;
  if (!key) {
    throw new Error('missing_api_key');
  }
  const payload = {
    messages: Array.isArray(messages) ? messages : [],
    context,
    temperature
  };
  if (model) payload.model = model;

  const response = await fetch('/api/chat', {
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
    if (emitChat) appendChatBubble(cleaned, 'assistant');
  } catch (err) {
    setAnalysisOutput('AI briefing failed. Showing heuristic analysis.');
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
  bubble.textContent = text;
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
    typing.textContent = err.message === 'missing_api_key' ? 'Add an OpenAI API key in Settings.' : `Assistant error: ${err.message}`;
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

  fetch('/api/snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot)
  }).catch(() => {});
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
  const items = getLocalItems().slice(0, 8);
  renderList(elements.localList, items);
}

function renderCategory(category, container) {
  let items = state.scopedItems.filter((item) => item.category === category);
  if (!items.length && globalFallbackCategories.has(category)) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.category === category);
  }
  if (category === 'crypto') {
    items = [...items].sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0));
  }
  if (category === 'research') {
    items = dedupeItems(items);
  }
  items = items.slice(0, 10);
  renderList(container, items);
}

function renderCombined(categories, container) {
  const items = state.scopedItems.filter((item) => categories.includes(item.category)).slice(0, 12);
  renderList(container, items);
}

function renderEnergyNews() {
  if (!elements.energyList) return;
  let items = state.scopedItems.filter((item) => item.feedId === 'eia-today');
  if (!items.length) {
    items = applyLanguageFilter(applyFreshnessFilter(state.items))
      .filter((item) => item.feedId === 'eia-today');
  }
  items = dedupeItems(items).slice(0, 10);
  renderList(elements.energyList, items);
}

async function loadEnergyGeoJson() {
  if (state.energyGeo) return state.energyGeo;
  const response = await fetch('/geo/us-states.geojson');
  const data = await response.json();
  state.energyGeo = data;
  return data;
}

async function fetchEnergyMapData() {
  const key = getEiaKey();
  if (!key) return null;
  const cacheTtl = 60 * 60 * 1000;
  if (state.energyMapData && Date.now() - state.energyMapFetchedAt < cacheTtl) {
    return state.energyMapData;
  }
  const url = new URL('https://api.eia.gov/v2/electricity/retail-sales/data/');
  url.searchParams.set('api_key', key);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'price');
  url.searchParams.set('facets[sectorid][]', 'RES');
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('offset', '0');
  url.searchParams.set('length', '200');

  const response = await fetch(url.toString());
  const data = await response.json();
  const rows = Array.isArray(data?.response?.data) ? data.response.data : [];
  const latestByState = {};
  rows.forEach((row) => {
    if (!row.stateid || latestByState[row.stateid]) return;
    const value = Number(row.price);
    if (!Number.isFinite(value)) return;
    latestByState[row.stateid] = {
      value,
      period: row.period,
      state: row.stateDescription || row.stateid
    };
  });
  const values = Object.values(latestByState).map((entry) => entry.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const payload = {
    period: rows[0]?.period || '',
    units: rows[0]?.['price-units'] || 'cents/kWh',
    values: latestByState,
    min,
    max
  };
  state.energyMapData = payload;
  state.energyMapFetchedAt = Date.now();
  return payload;
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
  const key = getEiaKey();
  if (!key) {
    if (elements.energyMapEmpty) elements.energyMapEmpty.style.display = 'flex';
    return;
  }
  if (elements.energyMapEmpty) elements.energyMapEmpty.style.display = 'none';

  const [geo, energyData] = await Promise.all([
    loadEnergyGeoJson(),
    fetchEnergyMapData()
  ]);
  if (!geo || !energyData) return;

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
      parts.push(`<span class="map-travel-text">${item.title}</span>`);
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

function initMap() {
  if (!elements.mapBase || !window.L) return;
  state.map = window.L.map(elements.mapBase, {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true
  }).setView([state.location.lat, state.location.lon], 2);

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);

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
}

function getLayerForItem(item) {
  if (item.feedId === 'state-travel-advisories' || item.feedId === 'cdc-travel-notices') return 'travel';
  if (item.category === 'travel') return 'travel';
  if (item.category === 'transport') return 'transport';
  if (item.category === 'weather') return 'weather';
  if (item.category === 'disaster') return 'disaster';
  if (item.category === 'space') return 'space';
  return 'news';
}

function getLayerColor(layer) {
  if (layer === 'disaster') return 'rgba(255,106,106,0.9)';
  if (layer === 'weather') return 'rgba(55,214,214,0.9)';
  if (layer === 'space') return 'rgba(140,107,255,0.9)';
  if (layer === 'travel') return 'rgba(255,196,87,0.95)';
  if (layer === 'transport') return 'rgba(94,232,160,0.9)';
  return 'rgba(255,184,76,0.9)';
}

function getSignalType(item) {
  if (!item) return 'news';
  if (item.feedId === 'usgs-quakes-hour' || item.feedId === 'usgs-quakes-day') return 'quake';
  if (item.feedId === 'state-travel-advisories' || item.feedId === 'cdc-travel-notices') return 'travel';
  if (item.feedId === 'opensky-states') return 'air';
  if (item.category === 'travel') return 'travel';
  if (item.category === 'weather') return 'weather';
  if (item.category === 'disaster') return 'disaster';
  if (item.category === 'space') return 'space';
  if (item.category === 'transport') return 'transport';
  return 'news';
}

function getSignalIcon(type) {
  if (type === 'quake') return 'Q';
  if (type === 'travel') return 'T';
  if (type === 'air') return 'A';
  if (type === 'transport') return 'R';
  if (type === 'weather') return 'W';
  if (type === 'disaster') return 'D';
  if (type === 'space') return 'S';
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
      ctx.font = '700 10px "Atkinson Hyperlegible", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cluster.icon || 'N', cluster.x, cluster.y);
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
    const results = await Promise.all(state.feeds.map((feed) => {
      const query = feed.supportsQuery ? translateQuery(feed, feed.defaultQuery || '') : undefined;
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
    const issueCount = results.filter((result) => {
      if (result.error === 'requires_key' || result.error === 'requires_config') return false;
      return result.error || (result.httpStatus && result.httpStatus >= 400);
    }).length;
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
  const issueCount = Object.values(state.feedStatus).filter((status) => {
    if (status.error === 'requires_key' || status.error === 'requires_config') return false;
    return status.error || (status.httpStatus && status.httpStatus >= 400);
  }).length;
  setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');
  state.retryingFeeds = false;
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => refreshAll(), state.settings.refreshMinutes * 60 * 1000);
}

async function handleSearch() {
  const query = elements.searchInput.value.trim();
  const scope = elements.feedScope.value;
  if (!query) return;

  if (state.searchCategories.length) {
    const selected = state.searchCategories;
    const filtered = state.scopedItems.filter((item) => selected.includes(item.category)).filter((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
    const freshFiltered = applyFreshnessFilter(filtered);
    showSearchResults(freshFiltered, `${freshFiltered.length} matches in ${selected.map((cat) => categoryLabels[cat] || cat).join(', ')}`);
    elements.searchHint.textContent = 'Showing multi-category search results.';
  } else if (scope === 'all') {
    const filtered = state.scopedItems.filter((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
    const freshFiltered = applyFreshnessFilter(filtered);
    showSearchResults(freshFiltered, `${freshFiltered.length} matches across all feeds`);
    elements.searchHint.textContent = `Showing ${filtered.length} matches across all feeds.`;
  } else if (scope.startsWith('cat:')) {
    const category = scope.replace('cat:', '');
    const filtered = state.scopedItems.filter((item) => item.category === category).filter((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
    const freshFiltered = applyFreshnessFilter(filtered);
    showSearchResults(freshFiltered, `${freshFiltered.length} matches in ${categoryLabels[category] || category}`);
    elements.searchHint.textContent = `Showing ${filtered.length} matches in ${categoryLabels[category] || category}.`;
  } else {
    const feed = state.feeds.find((f) => f.id === scope);
    if (!feed) return;
    elements.searchHint.textContent = 'Translating query...';
    const translated = await translateQueryAsync(feed, query);
    fetchFeed(feed, translated, true).then((result) => {
      const items = applyFreshnessFilter(result.items || []);
      showSearchResults(items, `${items.length} results from ${feed.name}`);
      elements.searchHint.textContent = `Search results from ${feed.name}.`;
    });
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

  if (elements.mapLegendBtn && elements.mapLegend) {
    elements.mapLegendBtn.addEventListener('click', () => {
      elements.mapLegend.classList.toggle('show');
    });

    elements.mapLegend.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-layer]');
      if (!input) return;
      const layer = input.dataset.layer;
      state.settings.mapLayers[layer] = input.checked;
      saveSettings();
      drawMap();
    });

    document.addEventListener('click', (event) => {
      if (!elements.mapLegend.classList.contains('show')) return;
      if (elements.mapLegend.contains(event.target) || elements.mapLegendBtn.contains(event.target)) return;
      elements.mapLegend.classList.remove('show');
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
    }
  });
}

async function init() {
  loadSettings();
  loadKeys();
  loadKeyGroups();
  loadKeyStatus();
  loadGeoCache();
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

  const response = await fetch('/api/feeds');
  const payload = await response.json();
  state.feeds = payload.feeds.filter((feed) => feed.url || feed.requiresKey || feed.requiresConfig);

  buildFeedOptions();
  buildKeyManager();
  updateChatStatus();
  attachKeyButtons();
  initMap();
  initEvents();
  ensurePanelUpdateBadges();
  renderWatchlistChips();
  requestLocation();
  const params = new URLSearchParams(window.location.search);
  if (params.has('about') || window.location.hash === '#about') {
    toggleAbout(true);
  }
  await refreshAll();
  startAutoRefresh();
}

init();
