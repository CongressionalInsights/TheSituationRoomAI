import { applyStateSignalFilter, getStateSignalFilterCode } from './state-signals.js';

function normalizeSearchField(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSearchField(entry))
      .filter(Boolean)
      .join(' ');
  }
  return String(value).trim();
}

function buildStateSignalSearchHaystack(item) {
  const fields = [
    item?.title,
    item?.summary,
    item?.jurisdictionName,
    item?.jurisdictionCode,
    item?.agency,
    item?.signalType,
    item?.status,
    item?.docId,
    item?.tags
  ];
  return fields
    .map((field) => normalizeSearchField(field))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function buildSearchHaystack(item) {
  const isStateSignal = String(item?.jurisdictionLevel || '').toLowerCase() === 'state';
  if (isStateSignal) {
    return buildStateSignalSearchHaystack(item);
  }
  return [item?.title, item?.summary]
    .map((field) => normalizeSearchField(field))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesSearchQuery(item, normalizedQuery) {
  if (!normalizedQuery) return true;
  return buildSearchHaystack(item).includes(normalizedQuery);
}

export function initSearchUI({ state, elements, helpers }) {
  if (!elements || !helpers) return { handleSearch: null };
  const {
    showSearchResults,
    updateSearchHint,
    isStaticMode,
    getLiveSearchFeeds,
    translateQueryAsync,
    fetchCustomFeedDirect,
    applySearchFilters,
    CATEGORY_LABELS,
    fetchFeed,
    hasAssistantAccess,
    updateCategoryFilters
  } = helpers;

  const handleSearch = async () => {
    const query = elements.searchInput.value.trim();
    const scope = elements.feedScope.value || 'all';
    if (!query) {
      elements.searchHint.textContent = 'Enter a search term to query signals.';
      showSearchResults([], 'Enter a search term');
      updateSearchHint();
      return;
    }

    state.lastSearchQuery = query;
    state.lastSearchScope = scope;
    state.lastSearchCategories = [...state.searchCategories];
    const selectedState = getStateSignalFilterCode(state.settings.stateSignalFilter);
    const applyScopedStateFilter = (items, isGovContext = false) => (
      applyStateSignalFilter(items, selectedState, { includeFederal: !isGovContext })
    );

    state.lastSearchState = selectedState;

    const originalLabel = elements.searchBtn?.textContent;
    if (elements.searchBtn) {
      elements.searchBtn.disabled = true;
      elements.searchBtn.textContent = 'Searching...';
    }
    state.searching = true;

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
        const filtered = state.scopedItems.filter((item) => selected.includes(item.category));
        const liveFeeds = liveSearchFeeds.filter((feed) => selected.includes(feed.category));
        if (liveFeeds.length) {
          elements.searchHint.textContent = 'Searching live sources...';
        }
        const liveItems = await runLiveSearch(liveFeeds);
        const combined = [...filtered, ...liveItems];
        const freshFiltered = applySearchFilters(combined)
          .filter((item) => matchesSearchQuery(item, normalizedQuery));
        const scopedFiltered = applyScopedStateFilter(freshFiltered, selected.includes('gov'));
        showSearchResults(scopedFiltered, `${scopedFiltered.length} matches in ${selected.map((cat) => CATEGORY_LABELS[cat] || cat).join(', ')}`);
        elements.searchHint.textContent = liveFeeds.length
          ? 'Showing cached + live search results.'
          : 'Showing multi-category search results.';
        return;
      }

      if (scope === 'all') {
        const filtered = [...state.scopedItems];
        if (liveSearchFeeds.length) {
          elements.searchHint.textContent = 'Searching live sources...';
        }
        const liveItems = await runLiveSearch(liveSearchFeeds);
        const combined = [...filtered, ...liveItems];
        const freshFiltered = applySearchFilters(combined)
          .filter((item) => matchesSearchQuery(item, normalizedQuery));
        const scopedFiltered = applyScopedStateFilter(freshFiltered, false);
        showSearchResults(scopedFiltered, `${scopedFiltered.length} matches across all feeds`);
        elements.searchHint.textContent = liveSearchFeeds.length
          ? `Showing cached + live results (${scopedFiltered.length}).`
          : `Showing ${scopedFiltered.length} matches across all feeds.`;
        return;
      }

      if (scope.startsWith('cat:')) {
        const category = scope.replace('cat:', '');
        const filtered = state.scopedItems.filter((item) => item.category === category);
        const liveFeeds = liveSearchFeeds.filter((feed) => feed.category === category);
        if (liveFeeds.length) {
          elements.searchHint.textContent = 'Searching live sources...';
        }
        const liveItems = await runLiveSearch(liveFeeds);
        const combined = [...filtered, ...liveItems];
        const freshFiltered = applySearchFilters(combined)
          .filter((item) => matchesSearchQuery(item, normalizedQuery));
        const scopedFiltered = applyScopedStateFilter(freshFiltered, category === 'gov');
        showSearchResults(scopedFiltered, `${scopedFiltered.length} matches in ${CATEGORY_LABELS[category] || category}`);
        elements.searchHint.textContent = liveFeeds.length
          ? `Showing cached + live results (${scopedFiltered.length}).`
          : `Showing ${scopedFiltered.length} matches in ${CATEGORY_LABELS[category] || category}.`;
        return;
      }

      const feed = state.feeds.find((f) => f.id === scope);
      if (!feed) {
        elements.searchHint.textContent = 'Select a feed or category to search.';
        showSearchResults([], 'Select a feed or category');
        return;
      }
      elements.searchHint.textContent = state.settings.aiTranslate && hasAssistantAccess()
        ? 'Translating query...'
        : 'Preparing query...';
      const translated = await translateQueryAsync(feed, query);
      try {
        if (liveSearchFeeds.find((entry) => entry.id === feed.id)) {
          const result = await fetchCustomFeedDirect(feed, translated);
          const items = applySearchFilters(result.items || [])
            .filter((item) => matchesSearchQuery(item, normalizedQuery));
          const scopedItems = applyScopedStateFilter(items, feed.category === 'gov');
          showSearchResults(scopedItems, `${scopedItems.length} live results from ${feed.name}`);
          elements.searchHint.textContent = `Live search results from ${feed.name}.`;
        } else {
          const result = await fetchFeed(feed, translated, true);
          const items = applySearchFilters(result.items || [])
            .filter((item) => matchesSearchQuery(item, normalizedQuery));
          const scopedItems = applyScopedStateFilter(items, feed.category === 'gov');
          showSearchResults(scopedItems, `${scopedItems.length} results from ${feed.name}`);
          elements.searchHint.textContent = `Search results from ${feed.name}.`;
        }
      } catch {
        elements.searchHint.textContent = `Search failed for ${feed.name}.`;
        showSearchResults([], `Search failed for ${feed.name}`);
      }
    } finally {
      if (elements.searchBtn) {
        elements.searchBtn.disabled = false;
        elements.searchBtn.textContent = originalLabel || 'Search';
      }
      state.searching = false;
      updateSearchHint();
    }
  };

  if (elements.feedScope) {
    elements.feedScope.addEventListener('change', () => {
      if (elements.feedScope.value !== 'all' && !elements.feedScope.value.startsWith('cat:')) {
        state.searchCategories = [];
        if (updateCategoryFilters) updateCategoryFilters();
      }
    });
  }
  if (elements.searchBtn) {
    elements.searchBtn.addEventListener('click', handleSearch);
  }
  if (elements.searchInput) {
    elements.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleSearch();
    });
  }

  return { handleSearch };
}
