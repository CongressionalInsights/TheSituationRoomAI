export function initPanelScroll({ state, helpers }) {
  if (!helpers) return;
  const {
    buildNewsItems,
    getCombinedItems,
    getCategoryItems,
    getPredictionItems,
    getLocalItemsForPanel,
    getCongressItems,
    getEnergyNewsItems,
    renderList,
    getListLimit,
    LIST_PAGE_SIZE
  } = helpers;

  const configs = [
    { id: 'newsList', withCoverage: true, getItems: () => buildNewsItems(state.clusters) },
    { id: 'financeMarketsList', getItems: () => getCombinedItems(['finance', 'energy']) },
    { id: 'financePolicyList', getItems: () => getCombinedItems(['gov', 'cyber', 'agriculture']) },
    { id: 'cryptoList', getItems: () => getCategoryItems('crypto').items },
    { id: 'predictionList', getItems: () => getPredictionItems() },
    { id: 'disasterList', getItems: () => getCombinedItems(['disaster', 'weather', 'space']) },
    { id: 'localList', getItems: () => getLocalItemsForPanel() },
    { id: 'policyList', getItems: () => getCategoryItems('gov').items },
    { id: 'congressList', getItems: () => getCongressItems() },
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
      const next = Math.min(items.length, current + LIST_PAGE_SIZE);
      state.listLimits[config.id] = next;
      renderList(container, items.slice(current, next), { withCoverage: config.withCoverage, append: true });
    });
  });
}

export function initListAutoSizing({ state, helpers }) {
  if (typeof ResizeObserver === 'undefined' || !helpers) return;
  const {
    buildNewsItems,
    getCombinedItems,
    getCategoryItems,
    getPredictionItems,
    getLocalItemsForPanel,
    getCongressItems,
    getEnergyNewsItems,
    renderListWithLimit
  } = helpers;

  const configs = [
    { id: 'newsList', withCoverage: true, getItems: () => buildNewsItems(state.clusters) },
    { id: 'financeMarketsList', getItems: () => getCombinedItems(['finance', 'energy']) },
    { id: 'financePolicyList', getItems: () => getCombinedItems(['gov', 'cyber', 'agriculture']) },
    { id: 'cryptoList', getItems: () => getCategoryItems('crypto').items },
    { id: 'predictionList', getItems: () => getPredictionItems() },
    { id: 'disasterList', getItems: () => getCombinedItems(['disaster', 'weather', 'space']) },
    { id: 'localList', getItems: () => getLocalItemsForPanel() },
    { id: 'policyList', getItems: () => getCategoryItems('gov').items },
    { id: 'congressList', getItems: () => getCongressItems() },
    { id: 'cyberList', getItems: () => getCategoryItems('cyber').items },
    { id: 'agricultureList', getItems: () => getCategoryItems('agriculture').items },
    { id: 'researchList', getItems: () => getCategoryItems('research').items },
    { id: 'spaceList', getItems: () => getCategoryItems('space').items },
    { id: 'energyList', getItems: () => getEnergyNewsItems() },
    { id: 'healthList', getItems: () => getCategoryItems('health').items },
    { id: 'transportList', getItems: () => getCategoryItems('transport').items }
  ];

  const configMap = new Map(configs.map((config) => [config.id, config]));
  const observer = new ResizeObserver((entries) => {
    entries.forEach((entry) => {
      const config = configMap.get(entry.target.id);
      if (!config) return;
      const items = config.getItems();
      if (!items || !items.length) return;
      renderListWithLimit(entry.target, items, { withCoverage: config.withCoverage });
    });
  });

  configs.forEach((config) => {
    const container = document.getElementById(config.id);
    if (!container) return;
    observer.observe(container);
  });
}
