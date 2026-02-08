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
        const freshFiltered = applySearchFilters(combined);
        showSearchResults(freshFiltered, `${freshFiltered.length} matches in ${selected.map((cat) => CATEGORY_LABELS[cat] || cat).join(', ')}`);
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
        const freshFiltered = applySearchFilters(combined);
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
        const freshFiltered = applySearchFilters(combined);
        showSearchResults(freshFiltered, `${freshFiltered.length} matches in ${CATEGORY_LABELS[category] || category}`);
        elements.searchHint.textContent = liveFeeds.length
          ? `Showing cached + live results (${freshFiltered.length}).`
          : `Showing ${freshFiltered.length} matches in ${CATEGORY_LABELS[category] || category}.`;
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
          const items = applySearchFilters(result.items || []);
          showSearchResults(items, `${items.length} live results from ${feed.name}`);
          elements.searchHint.textContent = `Live search results from ${feed.name}.`;
        } else {
          const result = await fetchFeed(feed, translated, true);
          const items = applySearchFilters(result.items || []);
          showSearchResults(items, `${items.length} results from ${feed.name}`);
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
