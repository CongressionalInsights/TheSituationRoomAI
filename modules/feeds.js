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
    getFeedRefreshContext,
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

  // One entry per feed bounds retention; context includes source, query and credentials.
  const priorResults = new Map();
  const pendingRequests = new Map();
  const latestRequests = new Map();
  let activeRefreshes = 0;
  const beginRefresh = () => { activeRefreshes += 1; setRefreshing(true); };
  const endRefresh = () => { activeRefreshes -= 1; setRefreshing(activeRefreshes > 0); };
  const canReuse = (feed, result) => {
    const ttl = Number(feed.ttlMinutes) || state.settings.refreshMinutes;
    const age = Date.now() - result.fetchedAt;
    return !result.error && result.httpStatus >= 200 && result.httpStatus < 300
      && !result.reuseBlocked && !result.stale && !result.fallback && !result.fallbackUsed && !result.warning
      && Number.isFinite(result.fetchedAt) && result.fetchedAt > 0
      && age >= 0 && age < ttl * 60 * 1000 && !isFeedStale(feed, result);
  };
  const isCurrent = (entry) => !entry.managed || (
    latestRequests.get(entry.feed.id) === entry
    && entry.query === (entry.feed.supportsQuery ? translateQuery(entry.feed, entry.feed.defaultQuery || '') : undefined)
    && entry.context === getFeedRefreshContext(entry.feed, entry.query, entry.live)
    && state.feeds.some((feed) => feed.id === entry.feed.id
      && getFeedRefreshContext(feed, entry.query, entry.live) === entry.context)
  );
  const requestFeed = async (feed, query, force, live, task) => {
    const managed = !feed.isCustom && feed.id !== 'gpsjam' && Boolean(getFeedRefreshContext);
    if (!managed) return { feed, result: await task(), managed: false };
    const context = getFeedRefreshContext(feed, query, live);
    const protectedForce = latestRequests.get(feed.id);
    if (!force && protectedForce?.force && !protectedForce.applied && isCurrent(protectedForce)) {
      if (protectedForce.context === context) return protectedForce.promise;
      // A completed live request still belongs to its not-yet-applied manual batch.
      return { feed, managed: true };
    }
    const pending = pendingRequests.get(feed.id);
    if (!force && pending?.context === context) return pending.promise;
    const prior = priorResults.get(feed.id);
    if (!force && prior?.context === context && canReuse(feed, prior.result)) return prior;

    priorResults.delete(feed.id);
    const entry = { feed, query, context, live, managed, force };
    latestRequests.set(feed.id, entry);
    entry.promise = (async () => {
      try {
        entry.result = await task();
        if (isCurrent(entry) && canReuse(feed, entry.result)) priorResults.set(feed.id, entry);
        return entry;
      } finally {
        if (pendingRequests.get(feed.id) === entry) pendingRequests.delete(feed.id);
      }
    })();
    pendingRequests.set(feed.id, entry);
    return entry.promise;
  };
  const markResultsApplied = (results) => results.forEach((result) => {
    const entry = latestRequests.get(result.feed.id);
    if (entry?.result === result) entry.applied = true;
  });

  const runUiStep = async (label, task) => {
    try {
      await task();
    } catch (err) {
      console.error(`[refresh] ${label} failed`, err);
    }
  };

  const fetchFeedBatch = async (feeds, force = false, retry = false) => {
    const liveOverride = force && isStaticMode();
    const entries = await Promise.all((feeds || []).map(async (feed) => {
      const query = feed.supportsQuery ? translateQuery(feed, feed.defaultQuery || '') : undefined;
      const live = !retry && (liveOverride || shouldFetchLiveInStatic(feed));
      return requestFeed(feed, query, force, live, async () => {
        if (live) {
          try {
            const result = await fetchCustomFeedDirect(feed, query);
            if (!result.error) return result;
            const fallback = await fetchFeed(feed, query, force);
            return { ...fallback, fallbackUsed: true };
          } catch {
            // Fall through to static cache, but never retain a failed live attempt as healthy.
          }
        }
        const result = await fetchFeed(feed, query, force).catch(() => ({
          feed,
          items: [],
          error: 'fetch_failed',
          httpStatus: 0,
          fetchedAt: Date.now()
        }));
        return live ? { ...result, fallbackUsed: true } : result;
      });
    }));
    return entries.filter(isCurrent).map((entry) => entry.result);
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
    beginRefresh();
    try {
      const results = await fetchFeedBatch(targetFeeds, force);
      if (!results.length) return [];
      updateFeedStatusFromResults(results);

      const targetFeedIds = new Set(results.map((result) => result.feed.id));
      const priorItemsByFeed = new Map();
      state.items.forEach((item) => {
        if (!item?.feedId) return;
        if (!priorItemsByFeed.has(item.feedId)) {
          priorItemsByFeed.set(item.feedId, []);
        }
        priorItemsByFeed.get(item.feedId).push(item);
      });
      const preservedItems = state.items.filter((item) => !targetFeedIds.has(item.feedId));
      const refreshedItems = [];
      results.forEach((result) => {
        const feedId = result?.feed?.id;
        if (!feedId) return;
        if (result.error) {
          const priorItems = priorItemsByFeed.get(feedId) || [];
          if (priorItems.length && state.feedStatus[feedId]) {
            state.feedStatus[feedId].count = priorItems.length;
          }
          refreshedItems.push(...priorItems);
          return;
        }
        refreshedItems.push(...normalizeItemsForState(result.items || []));
      });
      state.items = [...preservedItems, ...refreshedItems];
      markResultsApplied(results);
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      if (results.some((result) => !result.error)) {
        state.lastFetch = Date.now();
        updateDataFreshBadge();
      }

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
      endRefresh();
    }
  };

  const refreshAll = async (force = false) => {
    beginRefresh();
    setHealth('Fetching feeds');
    updateProxyHealth();
    try {
      if (isStaticMode()) {
        await loadStaticAnalysis();
        await loadStaticBuild();
      }
      const results = await fetchFeedBatch(state.feeds, force);
      if (!results.length) return;
      updateFeedStatusFromResults(results);

      const updatedIds = new Set(results.map((result) => result.feed.id));
      const activeIds = new Set(state.feeds.map((feed) => feed.id));
      state.items = [
        ...state.items.filter((item) => activeIds.has(item.feedId) && !updatedIds.has(item.feedId)),
        ...normalizeItemsForState(results.flatMap((result) => result.items || []))
      ];
      markResultsApplied(results);
      state.scopedItems = applyScope(state.items);
      state.clusters = clusterNews(state.scopedItems.filter((item) => item.category === 'news'));
      state.lastFetch = Date.now();
      updateDataFreshBadge();
      const resultsById = new Map(results.map((result) => [result.feed.id, result]));
      const issueCount = countCriticalIssues(state.feeds.map((feed) => resultsById.get(feed.id)
        || { feed, ...state.feedStatus[feed.id] }));
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
      endRefresh();
    }
  };

  const retryFailedFeeds = async () => {
    if (state.retryingFeeds) return;
    const failedFeeds = state.feeds.filter((feed) => state.feedStatus[feed.id]?.error === 'fetch_failed');
    if (!failedFeeds.length) return;
    state.retryingFeeds = true;

    const seen = new Set(state.items.map((item) => item.url || item.title));
    const newItems = [];
    const appliedResults = [];

    for (const feed of failedFeeds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const [result] = await fetchFeedBatch([feed], true, true);
        if (!result) continue;
        appliedResults.push(result);
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

    markResultsApplied(appliedResults);
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
    const appliedResults = [];

    for (const feed of staleFeeds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const [result] = await fetchFeedBatch([feed], true, true);
        if (!result) continue;
        appliedResults.push(result);
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

    markResultsApplied(appliedResults);
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
