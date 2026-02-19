export function createFeedManager({ state, elements, helpers }) {
  const {
    setRefreshing,
    setHealth,
    updateProxyHealth,
    isStaticMode,
    loadStaticAnalysis,
    loadStaticBuild,
    translateQuery,
    shouldFetchLiveInStatic,
    fetchCustomFeedDirect,
    fetchFeed,
    isFeedStale,
    canonicalUrl,
    isNonEnglish,
    enrichItem,
    applyScope,
    clusterNews,
    updateDataFreshBadge,
    countCriticalIssues,
    renderAllPanels,
    renderSignals,
    renderFeedHealth,
    drawMap,
    generateAnalysis,
    maybeAutoRunAnalysis,
    refreshCustomTickers,
    renderTicker,
    renderFinanceSpotlight,
    geocodeItems,
    renderLocal,
    updatePanelErrors
  } = helpers;

  const runUiStep = async (label, task) => {
    try {
      await task();
    } catch (err) {
      console.error(`[refresh] ${label} failed`, err);
    }
  };

  const fetchFeedBatch = async (feeds, force = false) => {
    const liveOverride = force && isStaticMode();
    return Promise.all((feeds || []).map(async (feed) => {
      const query = feed.supportsQuery ? translateQuery(feed, feed.defaultQuery || '') : undefined;
      if (liveOverride || shouldFetchLiveInStatic(feed)) {
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
  };

  const updateFeedStatusFromResults = (results) => {
    results.forEach((result) => {
      const stale = !result.error && isFeedStale(result.feed, result);
      state.feedStatus[result.feed.id] = {
        httpStatus: result.httpStatus,
        error: result.error,
        errorMessage: result.errorMessage,
        fetchedAt: result.fetchedAt,
        count: result.items.length,
        stale
      };
    });
  };

  const normalizeItemsForState = (items = []) => items.map((item) => enrichItem({
    ...item,
    url: canonicalUrl(item.url),
    isNonEnglish: isNonEnglish(`${item.title || ''} ${item.summary || ''}`),
    feedId: item.feedId || null
  }));

  const refreshFeeds = async (feedIds = [], options = {}) => {
    const requestedIds = Array.isArray(feedIds) ? feedIds : [feedIds];
    const idSet = new Set(requestedIds.filter(Boolean));
    if (!idSet.size) return [];
    const targetFeeds = state.feeds.filter((feed) => idSet.has(feed.id));
    if (!targetFeeds.length) return [];
    const force = Boolean(options.force);
    const rerender = options.rerender !== false;
    setRefreshing(true);
    try {
      const results = await fetchFeedBatch(targetFeeds, force);
      updateFeedStatusFromResults(results);

      const targetFeedIds = new Set(targetFeeds.map((feed) => feed.id));
      const preservedItems = state.items.filter((item) => !targetFeedIds.has(item.feedId));
      const refreshedItems = normalizeItemsForState(results.flatMap((result) => result.items || []));
      state.items = [...preservedItems, ...refreshedItems];
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      state.lastFetch = Date.now();
      updateDataFreshBadge();

      const issueCount = countCriticalIssues(state.feeds.map((feed) => ({
        feed,
        ...state.feedStatus[feed.id]
      })));
      setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');

      if (rerender) {
        await runUiStep('renderAllPanels', () => renderAllPanels());
        await runUiStep('renderSignals', () => renderSignals());
        await runUiStep('renderFeedHealth', () => renderFeedHealth());
        await runUiStep('drawMap', () => drawMap());
        await runUiStep('updatePanelErrors', () => updatePanelErrors());
      } else {
        await runUiStep('renderFeedHealth', () => renderFeedHealth());
      }
      return results;
    } finally {
      setRefreshing(false);
    }
  };

  const refreshAll = async (force = false) => {
    setRefreshing(true);
    setHealth('Fetching feeds');
    updateProxyHealth();
    try {
      if (isStaticMode()) {
        await loadStaticAnalysis();
        await loadStaticBuild();
      }
      const results = await fetchFeedBatch(state.feeds, force);
      updateFeedStatusFromResults(results);

      state.items = normalizeItemsForState(results.flatMap((result) => result.items || []));
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      state.lastFetch = Date.now();
      updateDataFreshBadge();
      const issueCount = countCriticalIssues(results);
      setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');

      await runUiStep('renderAllPanels', () => renderAllPanels());
      await runUiStep('renderSignals', () => renderSignals());
      await runUiStep('renderFeedHealth', () => renderFeedHealth());
      await runUiStep('drawMap', () => drawMap());
      await runUiStep('generateAnalysis', () => generateAnalysis(false));
      await runUiStep('maybeAutoRunAnalysis', () => maybeAutoRunAnalysis());
      await runUiStep('refreshCustomTickers', () => refreshCustomTickers());
      await runUiStep('renderTicker', () => renderTicker());
      await runUiStep('renderFinanceSpotlight', () => renderFinanceSpotlight());
      await runUiStep('updatePanelErrors', () => updatePanelErrors());

      geocodeItems(state.items).then(async (geocodeUpdated) => {
        if (!geocodeUpdated) return;
        state.scopedItems = applyScope(state.items);
        if (state.settings.scope === 'local') {
          state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
          await runUiStep('renderAllPanels (geocode)', () => renderAllPanels());
        } else {
          await runUiStep('renderLocal (geocode)', () => renderLocal());
        }
        await runUiStep('renderSignals (geocode)', () => renderSignals());
        await runUiStep('renderFeedHealth (geocode)', () => renderFeedHealth());
        await runUiStep('drawMap (geocode)', () => drawMap());
        await runUiStep('renderTicker (geocode)', () => renderTicker());
        await runUiStep('updatePanelErrors (geocode)', () => updatePanelErrors());
      }).catch(() => {});
      if (issueCount) {
        await retryFailedFeeds();
      }
      await retryStaleFeeds(results);
    } finally {
      setRefreshing(false);
    }
  };

  const retryFailedFeeds = async () => {
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
        const stale = !result.error && isFeedStale(result.feed, result);
        state.feedStatus[result.feed.id] = {
          httpStatus: result.httpStatus,
          error: result.error,
          errorMessage: result.errorMessage,
          fetchedAt: result.fetchedAt,
          count: result.items.length,
          stale
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
    updatePanelErrors();
    state.retryingFeeds = false;
  };

  const retryStaleFeeds = async (results) => {
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
        const stale = !result.error && isFeedStale(result.feed, result);
        state.feedStatus[result.feed.id] = {
          httpStatus: result.httpStatus,
          error: result.error,
          errorMessage: result.errorMessage,
          fetchedAt: result.fetchedAt,
          count: result.items.length,
          stale
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
    updatePanelErrors();
    const issueCount = countCriticalIssues(state.feeds.map((feed) => ({
      feed,
      ...state.feedStatus[feed.id]
    })));
    setHealth(issueCount ? `Degraded (${issueCount})` : 'Healthy');
    state.staleRetrying = false;
  };

  const startAutoRefresh = () => {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => refreshAll(), state.settings.refreshMinutes * 60 * 1000);
  };

  return {
    refreshAll,
    refreshFeeds,
    retryFailedFeeds,
    retryStaleFeeds,
    startAutoRefresh
  };
}
