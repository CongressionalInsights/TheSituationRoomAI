// Optional runtime overrides for static deployments (GitHub Pages).
// Example:
// window.SR_CONFIG = {
//   apiBase: 'https://your-worker.your-domain.workers.dev',
//   basePath: '/TheSituationRoomAI'
// };
window.SR_CONFIG = window.SR_CONFIG || {};

(() => {
  if (!window.SR_CONFIG.apiBase) {
    const host = window.location.hostname || '';
    if (host.endsWith('.github.io')) {
      const owner = host.split('.')[0];
      window.SR_CONFIG.apiBase = `https://situation-room-proxy.${owner}.workers.dev`;
    }
  }
})();
