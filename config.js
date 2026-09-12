// Optional runtime overrides for static deployments (GitHub Pages).
// Example:
// window.SR_CONFIG = {
//   apiBase: 'https://your-worker.your-domain.workers.dev',
//   basePath: '/TheSituationRoomAI',
//   openAiProxy: 'https://your-cloud-run-url.run.app/api/chat'
// };
window.SR_CONFIG = window.SR_CONFIG || {};

(() => {
  const host = window.location.hostname || '';
  if (host.endsWith('.github.io')) {
    window.SR_CONFIG.apiBase = window.SR_CONFIG.apiBase
      || 'https://situation-room-feed-382918878290.us-central1.run.app';
    window.SR_CONFIG.staticMode = false;
    window.SR_CONFIG.openAiProxy = window.SR_CONFIG.openAiProxy
      || 'https://situation-room-openai-382918878290.us-central1.run.app/api/chat';
    window.SR_CONFIG.openSkyProxy = window.SR_CONFIG.openSkyProxy
      || 'https://situation-room-opensky-382918878290.us-central1.run.app/api/opensky';
    window.SR_CONFIG.acledProxy = window.SR_CONFIG.acledProxy
      || 'https://situation-room-acled-382918878290.us-central1.run.app/api/acled';
    window.SR_CONFIG.mcpProxy = window.SR_CONFIG.mcpProxy
      || 'https://situation-room-mcp-382918878290.us-central1.run.app/mcp';
  }
})();
