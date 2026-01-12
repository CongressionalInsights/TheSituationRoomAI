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
    window.SR_CONFIG.staticMode = true;
    window.SR_CONFIG.openAiProxy = window.SR_CONFIG.openAiProxy
      || 'https://situation-room-openai-382918878290.us-central1.run.app/api/chat';
  }
})();
