# The Situation Room

A clean, high‑signal situational awareness dashboard with a unified news layer, geo‑tagged incidents, finance & crypto pulses, and an analysis panel.

## Run locally
```bash
cd "/Users/ashirgruder/projects/TheSituationRoom"
DATA_GOV="your_data_gov_key" \
EIA="your_eia_key" \
NASA_FIRMS="your_nasa_firms_key" \
OPEN_AQ="your_openaq_key" \
node server.mjs
```
Then open `http://localhost:5173`.

## Configure feeds
- Feed registry: `data/feeds.json`
- Add/edit feeds in the registry. Mark `requiresKey: true` for sources you’ll wire later.
- Some providers require a User‑Agent; update `app.userAgent` in `data/feeds.json`.

## API keys (in-app)
- Open Settings → API Keys.
- Paste your OpenAI key (BYO key) for chat + briefing.
- OpenAI keys are stored locally in browser storage and sent only to the `/api/chat` proxy.

## Panels & layout
- Drag panels to reorder.
- Toggle panels in Settings (visibility is saved).
- Reset layout restores the default order.

## Refresh + themes
- Default refresh is hourly. Use Settings to drop to 1 minute or switch theme (dark/light/system).
- Use **Refresh Now** to force a re-fetch.

## Snapshot export
- **Export Snapshot** downloads a JSON snapshot and saves a copy to `analysis/denario/snapshots/`.

## AI assistant + analysis
- Add your OpenAI key under **OpenAI Assistant** in Settings → API Keys.
- Chat, AI briefings, and AI query translation use `/api/chat` (OpenAI Responses API).
- Optional: set `OPENAI_API_KEY` on the server if you prefer not to send the key from the browser.

## Server-side proxy + secrets (GitHub Pages)
GitHub Pages is static, so API secrets must live in a server-side proxy. This repo includes a Cloudflare Worker that mirrors the local `/api/*` endpoints and keeps secrets out of the client bundle.
Avoid injecting secrets into built JavaScript; they will become public.

- Worker entry: `worker/index.mjs`
- Worker config: `wrangler.toml`
- GitHub Actions:
  - `deploy-worker.yml` (Cloudflare Worker)
  - `deploy-pages.yml` (GitHub Pages)
- Required secrets in the Worker:
  - `DATA_GOV`
  - `EIA`
  - `NASA_FIRMS`
  - `OPEN_AQ`
- Optional:
  - `OPENAI_API_KEY` or `OPEN_AI` (if you want server-side OpenAI)
  - `ALLOWED_ORIGIN` (restrict CORS; defaults to `*`)
  - `SNAPSHOT_KV` (KV namespace for snapshot storage)

### Configure the runtime API base
Static deployments use `public/config.js` to point the UI at the proxy.

Example:
```js
window.SR_CONFIG = {
  apiBase: 'https://your-worker.your-domain.workers.dev',
  basePath: '/TheSituationRoomAI'
};
```

## Deployment
1) Add Cloudflare secrets to GitHub:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
2) The `Deploy Worker` workflow will push secrets (`DATA_GOV`, `EIA`, `NASA_FIRMS`, `OPEN_AQ`, optional `OPEN_AI`) and deploy the Worker.
3) Update `public/config.js` with the Worker URL if it differs from the default `situation-room-proxy.<org>.workers.dev`.
4) The `Deploy GitHub Pages` workflow publishes `public/` to `gh-pages`.

## Troubleshooting
- "Feed API unreachable" in Settings → the Worker URL or CORS config is wrong.
- Energy map says the server key is missing → set `EIA` in the Worker or local env.
- Chat errors → add OpenAI key in Settings, or set `OPENAI_API_KEY` on the proxy.

## Geo enrichment
- The server geocodes inferred locations via OpenStreetMap Nominatim (`/api/geocode`).
- Results are cached in `analysis/geo/geocode_cache.json` and in browser storage.

## Source monitor (optional)
- Use `analysis/monitor/monitor_sources.mjs` to track API/dev‑page changes and log diffs.
- See `analysis/monitor/README.md` for setup.

## Notes
- News dedupe is enabled across all news sources to avoid repeated headlines. Coverage is shown as a visual indicator.
- Geo‑local mode uses browser geolocation. If blocked, it falls back to Asheville, NC.

## Analysis layer
- Heuristic analysis runs in the UI now.
- For deeper AI analysis, see `analysis/denario/README.md` for a Denario pipeline you can wire when ready.
