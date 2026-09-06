export function initSettingsUI({ elements, handlers }) {
  if (!elements || !handlers) return;

  if (elements.settingsToggle && handlers.onSettingsToggle) {
    elements.settingsToggle.addEventListener('click', handlers.onSettingsToggle);
  }
  if (elements.settingsScrim && handlers.onSettingsScrim) {
    elements.settingsScrim.addEventListener('click', handlers.onSettingsScrim);
  }
  if (elements.sidebarSettings && handlers.onSidebarSettings) {
    elements.sidebarSettings.addEventListener('click', handlers.onSidebarSettings);
  }

  if (elements.statusToggle && handlers.onStatusToggle) {
    elements.statusToggle.addEventListener('click', handlers.onStatusToggle);
  }
  if (elements.keyToggle && handlers.onKeyToggle) {
    elements.keyToggle.addEventListener('click', handlers.onKeyToggle);
  }
  if (elements.mcpToggle && handlers.onMcpToggle) {
    elements.mcpToggle.addEventListener('click', handlers.onMcpToggle);
  }
  if (elements.travelTickerBtn && handlers.onTravelTickerToggle) {
    elements.travelTickerBtn.addEventListener('click', handlers.onTravelTickerToggle);
  }

  if (elements.refreshRange && handlers.onRefreshRange) {
    elements.refreshRange.addEventListener('input', handlers.onRefreshRange);
  }
  if (elements.radiusRange && handlers.onRadiusRange) {
    elements.radiusRange.addEventListener('input', handlers.onRadiusRange);
  }
  if (elements.maxAgeRange && handlers.onMaxAgeRange) {
    elements.maxAgeRange.addEventListener('input', handlers.onMaxAgeRange);
  }
  if (elements.languageToggle && handlers.onLanguageToggle) {
    elements.languageToggle.addEventListener('click', handlers.onLanguageToggle);
  }
  if (elements.themeToggle && handlers.onThemeToggle) {
    elements.themeToggle.addEventListener('click', handlers.onThemeToggle);
  }
  if (elements.ageToggle && handlers.onAgeToggle) {
    elements.ageToggle.addEventListener('click', handlers.onAgeToggle);
  }
  if (elements.scopeToggle && handlers.onScopeToggle) {
    elements.scopeToggle.addEventListener('click', handlers.onScopeToggle);
  }
  if (elements.aiTranslateToggle && handlers.onAiTranslateToggle) {
    elements.aiTranslateToggle.addEventListener('change', handlers.onAiTranslateToggle);
  }
  if (elements.superMonitorToggle && handlers.onSuperMonitorToggle) {
    elements.superMonitorToggle.addEventListener('change', handlers.onSuperMonitorToggle);
  }
}
