const DEFAULT_FOCUS_GEO_TARGET = 'geo';

export function createFocusController({
  elements,
  state,
  focusPanelExclude = new Set(),
  focusGeoTarget = DEFAULT_FOCUS_GEO_TARGET
} = {}) {
  const focusState = {
    active: false,
    target: null,
    panels: []
  };

  const buildPanelPlaceholder = (panel) => {
    const placeholder = document.createElement('div');
    placeholder.className = 'panel-placeholder';
    const rect = panel.getBoundingClientRect();
    placeholder.style.height = `${Math.round(rect.height)}px`;
    const computed = window.getComputedStyle(panel);
    const gridSpan = panel.style.gridColumnEnd || computed.gridColumnEnd;
    if (gridSpan && gridSpan !== 'auto') {
      placeholder.style.gridColumnEnd = gridSpan;
    }
    return placeholder;
  };

  const movePanelToFocus = (panel) => {
    const placeholder = buildPanelPlaceholder(panel);
    panel.parentNode.insertBefore(placeholder, panel);
    elements.focusBody.appendChild(panel);
    return { panel, placeholder };
  };

  const restoreFocusedPanels = () => {
    focusState.panels.forEach(({ panel, placeholder }) => {
      if (placeholder.parentNode) {
        placeholder.parentNode.insertBefore(panel, placeholder);
        placeholder.remove();
      }
    });
    focusState.panels = [];
    focusState.target = null;
  };

  const toggleFocusModal = (open) => {
    if (!elements.focusOverlay) return;
    elements.focusOverlay.classList.toggle('open', open);
    elements.focusOverlay.setAttribute('aria-hidden', open ? 'false' : 'true');
    elements.focusOverlay.inert = !open;
    if (!open && elements.focusBody) {
      elements.focusBody.innerHTML = '';
      elements.focusBody.classList.remove('focus-geo');
      elements.focusBody.classList.remove('focus-single');
    }
  };

  const getFocusPanels = (target) => {
    if (target === focusGeoTarget) {
      const mapPanel = document.querySelector('.panel[data-panel="map"]');
      const imageryPanel = document.querySelector('.panel[data-panel="imagery"]');
      return [mapPanel, imageryPanel].filter(Boolean);
    }
    const panel = document.querySelector(`.panel[data-panel="${target}"]`);
    return panel ? [panel] : [];
  };

  const applyFocusFilter = (query) => {
    if (!elements.focusBody) return;
    const normalized = String(query || '').trim().toLowerCase();
    const selectors = [
      '.list-item',
      '.summary-card',
      '.finance-card',
      '.map-detail-item',
      '.legend-item',
      '.legend-subitem',
      '.detail-card',
      '.trends-item',
      '.denario-item'
    ];
    const items = elements.focusBody.querySelectorAll(selectors.join(','));
    if (!items.length) return;
    items.forEach((item) => {
      if (!normalized) {
        item.style.display = '';
        return;
      }
      const text = item.textContent ? item.textContent.toLowerCase() : '';
      item.style.display = text.includes(normalized) ? '' : 'none';
    });
  };

  const openFocusModal = (target) => {
    if (!elements.focusBody) return;
    if (focusState.active) {
      closeFocusModal();
    }
    const panels = getFocusPanels(target);
    if (!panels.length) return;

    focusState.active = true;
    focusState.target = target;

    if (elements.focusTitle) {
      elements.focusTitle.textContent = target === focusGeoTarget ? 'Geo + Imagery' : (panels[0].querySelector('.panel-title')?.textContent || 'Panel');
    }
    if (elements.focusMeta) {
      elements.focusMeta.textContent = target === focusGeoTarget
        ? 'Live incidents & events + basemaps/overlays'
        : (panels[0].querySelector('.panel-sub')?.textContent || 'Expanded view');
    }

    elements.focusBody.innerHTML = '';
    if (target === focusGeoTarget) {
      elements.focusBody.classList.add('focus-geo');
    }
    elements.focusBody.classList.toggle('focus-single', panels.length === 1 && target !== focusGeoTarget);

    focusState.panels = panels.map((panel) => movePanelToFocus(panel));
    toggleFocusModal(true);

    if (elements.focusSearch) {
      elements.focusSearch.value = '';
      elements.focusSearch.oninput = () => applyFocusFilter(elements.focusSearch.value);
    }
    applyFocusFilter('');

    if (target === focusGeoTarget && state.map) {
      setTimeout(() => state.map.invalidateSize(), 120);
    }
  };

  const closeFocusModal = () => {
    if (!focusState.active) return;
    const wasGeo = focusState.target === focusGeoTarget;
    restoreFocusedPanels();
    toggleFocusModal(false);
    focusState.active = false;
    if (elements.focusSearch) {
      elements.focusSearch.value = '';
    }
    if (wasGeo && state.map) {
      setTimeout(() => state.map.invalidateSize(), 120);
    }
  };

  const initFocusModal = () => {
    const panels = [...document.querySelectorAll('.panel[data-panel]')];
    panels.forEach((panel) => {
      const panelId = panel.dataset.panel;
      if (focusPanelExclude.has(panelId)) return;
      const header = panel.querySelector('.panel-header');
      if (!header) return;
      let actions = header.querySelector('.panel-actions');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'panel-actions';
        header.appendChild(actions);
      }
      if (actions.querySelector('.panel-focus-btn')) return;
      const button = document.createElement('button');
      button.className = 'btn ghost panel-focus-btn';
      button.type = 'button';
      button.dataset.panelFocus = panelId === 'map' || panelId === 'imagery' ? focusGeoTarget : panelId;
      button.title = 'Focus panel';
      button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-expand"></use></svg><span class="sr-only">Focus</span>';
      button.addEventListener('click', () => openFocusModal(button.dataset.panelFocus));
      actions.appendChild(button);
    });

    if (elements.focusClose) {
      elements.focusClose.addEventListener('click', () => closeFocusModal());
    }
    if (elements.focusOverlay) {
      elements.focusOverlay.addEventListener('click', (event) => {
        if (event.target === elements.focusOverlay) {
          closeFocusModal();
        }
      });
    }
  };

  return {
    initFocusModal,
    openFocusModal,
    closeFocusModal,
    applyFocusFilter,
    isActive: () => focusState.active
  };
}
