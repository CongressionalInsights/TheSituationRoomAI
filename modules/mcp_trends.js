const DEFAULT_QUERY = 'top signals';
const MCP_TRENDS_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 2500;
const RETRY_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000, 120000];

function safeNow() {
  return Date.now();
}

function formatRetryMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  return `${mins}m`;
}

export function initMcpTrendsController({ state, elements, mcpClient, helpers }) {
  if (!elements?.mcpTrendsPanel) return null;
  if (!helpers?.toRelativeTime || !helpers?.truncateText || !helpers?.stripHtml) return null;

  const { toRelativeTime, truncateText, stripHtml } = helpers;

  // Extend state shape without requiring migrations.
  if (!state.mcpTrends) state.mcpTrends = {};
  state.mcpTrends.lastSuccessAt ??= null;
  state.mcpTrends.lastAttemptAt ??= null;
  state.mcpTrends.retryAt ??= null;
  state.mcpTrends.retryInMs ??= 0;
  state.mcpTrends.lastGood ??= { signals: [], sources: [], summary: null };
  state.mcpTrends.inFlight ??= false;

  let retryTimer = null;
  let retryIndex = 0;

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    state.mcpTrends.retryAt = null;
    state.mcpTrends.retryInMs = 0;
  }

  function scheduleRetry() {
    clearRetry();
    const backoff = RETRY_BACKOFF_MS[Math.min(retryIndex, RETRY_BACKOFF_MS.length - 1)];
    retryIndex += 1;
    state.mcpTrends.retryInMs = backoff;
    state.mcpTrends.retryAt = safeNow() + backoff;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      fetchTrends(state.mcpTrends.query || '');
    }, backoff);
  }

  function effectiveSignals() {
    const signals = Array.isArray(state.mcpTrends.signals) ? state.mcpTrends.signals : [];
    if (signals.length) return signals;
    const last = state.mcpTrends.lastGood?.signals;
    return Array.isArray(last) ? last : [];
  }

  function effectiveSources() {
    const sources = Array.isArray(state.mcpTrends.sources) ? state.mcpTrends.sources : [];
    if (sources.length) return sources;
    const last = state.mcpTrends.lastGood?.sources;
    return Array.isArray(last) ? last : [];
  }

  function effectiveSummary() {
    return state.mcpTrends.summary || state.mcpTrends.lastGood?.summary || null;
  }

  function render() {
    const { loading, error, lastSuccessAt, retryAt, retryInMs } = state.mcpTrends;
    const signals = effectiveSignals();
    const sources = effectiveSources();
    const summary = effectiveSummary();

    if (elements.mcpTrendsSummary) {
      if (loading && !signals.length) {
        elements.mcpTrendsSummary.textContent = 'Fetching MCP signals…';
      } else if (loading && signals.length) {
        elements.mcpTrendsSummary.textContent = 'Refreshing MCP signals…';
      } else if (error) {
        const lastText = lastSuccessAt ? `Last update ${toRelativeTime(lastSuccessAt)}.` : 'No recent MCP update.';
        const retryText = retryAt ? ` Retrying in ${formatRetryMs(retryInMs)}.` : '';
        const showingText = signals.length ? ' Showing last known signals.' : '';
        elements.mcpTrendsSummary.textContent = `Data delayed. ${lastText}${showingText}${retryText}`;
      } else if (summary) {
        elements.mcpTrendsSummary.textContent = summary;
      } else if (signals.length) {
        const sourceCount = sources.length ? `${sources.length} sources` : 'multiple sources';
        elements.mcpTrendsSummary.textContent = `${signals.length} signals across ${sourceCount}.`;
      } else {
        elements.mcpTrendsSummary.textContent = 'Awaiting MCP signals.';
      }
    }

    if (elements.mcpTrendsMeta) {
      const stamp = lastSuccessAt || null;
      elements.mcpTrendsMeta.textContent = stamp ? `Updated ${toRelativeTime(stamp)}` : '—';
    }

    if (!elements.mcpTrendsList) return;
    elements.mcpTrendsList.innerHTML = '';
    if (loading && !signals.length) return;
    if (!signals.length) {
      elements.mcpTrendsList.innerHTML = '<div class="trends-empty">No MCP signals yet.</div>';
      return;
    }

    signals.slice(0, 12).forEach((item) => {
      const entry = document.createElement('div');
      entry.className = 'trends-item';
      const title = document.createElement(item.url ? 'a' : 'div');
      title.className = 'trends-title';
      title.textContent = item.title || item.name || item.label || 'Signal';
      if (item.url) {
        title.href = item.url;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
      }
      const meta = document.createElement('div');
      meta.className = 'trends-meta';
      const metaParts = [];
      if (item.source) metaParts.push(item.source);
      if (item.category) metaParts.push(item.category);
      const ts = item.publishedAt || item.updatedAt || item.timestamp;
      if (ts) metaParts.push(toRelativeTime(ts));
      meta.textContent = metaParts.filter(Boolean).join(' • ');
      entry.appendChild(title);
      entry.appendChild(meta);
      const summaryText = item.summary || item.detailSummary || item.description;
      if (summaryText) {
        const summaryEl = document.createElement('div');
        summaryEl.className = 'trends-summary-text';
        summaryEl.textContent = truncateText(stripHtml(summaryText), 140);
        entry.appendChild(summaryEl);
      }
      elements.mcpTrendsList.appendChild(entry);
    });
  }

  async function fetchTrends(queryOverride = '') {
    if (!mcpClient || typeof mcpClient.callTool !== 'function') return;
    if (state.mcpTrends.inFlight) return;
    const query = String(queryOverride || '').trim();
    state.mcpTrends.query = query;
    state.mcpTrends.inFlight = true;
    state.mcpTrends.loading = true;
    state.mcpTrends.error = null;
    state.mcpTrends.lastAttemptAt = safeNow();
    render();

    try {
      if (typeof mcpClient.healthCheck === 'function') {
        const health = await mcpClient.healthCheck(HEALTH_TIMEOUT_MS);
        if (!health?.ok) {
          state.mcpTrends.error = health?.message || 'MCP unavailable';
          state.mcpTrends.loading = false;
          render();
          scheduleRetry();
          return;
        }
      }

      const result = await mcpClient.callTool('search.smart', {
        query: query || DEFAULT_QUERY,
        limit: 30
      }, MCP_TRENDS_TIMEOUT_MS);

      if (result?.error) {
        state.mcpTrends.error = result.message || 'MCP unavailable';
        state.mcpTrends.loading = false;
        render();
        scheduleRetry();
        return;
      }

      const data = result?.data || {};
      const items = Array.isArray(data.items)
        ? data.items
        : (Array.isArray(data.results) ? data.results : (Array.isArray(data.signals) ? data.signals : []));
      const sources = Array.isArray(data.sources)
        ? data.sources
        : (Array.isArray(data.providers) ? data.providers : []);

      state.mcpTrends.signals = items;
      state.mcpTrends.sources = sources;
      state.mcpTrends.summary = data.summary || data.overview || null;
      state.mcpTrends.lastGood = {
        signals: items,
        sources,
        summary: state.mcpTrends.summary
      };
      state.mcpTrends.lastSuccessAt = safeNow();
      state.mcpTrends.error = null;
      retryIndex = 0;
      clearRetry();
    } catch (err) {
      state.mcpTrends.error = err?.message || 'MCP unavailable';
      scheduleRetry();
    } finally {
      state.mcpTrends.loading = false;
      state.mcpTrends.inFlight = false;
      render();
    }
  }

  function init() {
    if (elements.mcpTrendsRun) {
      elements.mcpTrendsRun.addEventListener('click', () => {
        fetchTrends(elements.mcpTrendsQuery?.value || '');
      });
    }
    if (elements.mcpTrendsQuery) {
      elements.mcpTrendsQuery.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          fetchTrends(elements.mcpTrendsQuery.value || '');
        }
      });
    }
    render();
    fetchTrends('');
  }

  init();
  return { render, refresh: fetchTrends };
}

