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
- For local/server mode, paste your OpenAI key (BYO key) for chat + briefing.
- OpenAI keys are stored locally in browser storage. On GitHub Pages they are forwarded to the proxy (see below) via `x-openai-key`.

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
- Add your OpenAI key under **OpenAI Assistant** in Settings → API Keys for local/server mode.
- Chat, AI briefings, and AI query translation use `/api/chat` (OpenAI Responses API).
- Optional: set `OPENAI_API_KEY` on the server if you prefer not to send the key from the browser.

## GitHub Pages static mode (recommended for this repo)
GitHub Pages cannot keep secrets at runtime, so this repo ships in **static snapshot mode** by default. A scheduled GitHub Action pulls all feeds using repo secrets and publishes the cached results under `public/data/`. The UI reads those cached JSON files when hosted on `*.github.io`.

- Static cache builder: `scripts/build_static_cache.mjs`
- Cache output: `public/data/feeds/*.json`, `public/data/feeds.json`, `public/data/energy-map.json`
- Schedule: hourly (see `.github/workflows/deploy-pages.yml`)
- Required repo secrets (used only during Actions):
  - `DATA_GOV`
  - `EIA`
  - `NASA_FIRMS`
  - `OPEN_AQ`
  - `OPEN_AI` (optional, enables build-time AI briefing cache)
  - `analysis.json` is generated at build time if `OPEN_AI` is set.

Static mode limits:
- The **Refresh Now** button reloads cached JSON; it does not re-fetch live data.
- Search queries are limited to the cached/default feed queries.
- AI chat requires a server proxy. Without it, the briefing panel falls back to the cached `analysis.json` when available.
- You can enable **Live Search** to query GDELT + Google News directly on static hosting.
- If **Super Monitor Mode** is enabled, the browser will attempt live fetches for keyless feeds and merge them with cached data.

### Configure static mode (default)
`public/config.js` sets `staticMode = true` when served from `*.github.io`. No extra configuration is required for GitHub Pages.

## OpenAI proxy (Cloud Run on GCP)
To enable OpenAI chat on the live GitHub Pages site, deploy the proxy in `gcp/openai-proxy/` and set `window.SR_CONFIG.openAiProxy`.
This repo is already wired to use:
`https://situation-room-openai-382918878290.us-central1.run.app/api/chat`
when served from `*.github.io`.

### Deploy steps
```bash
# create a project (must be lowercase / unique)
gcloud projects create situationroom-ai-20260112 --name="SituationRoom"
gcloud beta billing projects link situationroom-ai-20260112 --billing-account=014C72-E3E5EE-C38A59

# enable APIs
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# deploy the proxy (from repo root)
gcloud run deploy situation-room-openai \\
  --source gcp/openai-proxy \\
  --region us-central1 \\
  --allow-unauthenticated \\
  --env-vars-file /tmp/sr-openai-env.yaml
```

### Wire the proxy into the UI
Edit `public/config.js` if you deploy to a different URL:
```js
window.SR_CONFIG = window.SR_CONFIG || {};
window.SR_CONFIG.openAiProxy = 'https://<your-cloud-run-url>/api/chat';
```

Notes:
- The proxy accepts a user key via `x-openai-key` (so users can override). If no key is supplied, it will only work if you attach a server key.
- If billing quota blocks project creation, either increase quota or provide a different billing account.

## Optional: server-side proxy (advanced)
If you later add a full runtime backend, you can disable static mode and point the UI at your `/api/*` backend by setting `window.SR_CONFIG.apiBase` in `public/config.js`. This repo includes a Cloudflare Worker implementation in `worker/` for optional use.

## Troubleshooting
- "Feed API unreachable" → static cache failed to build; check the GitHub Actions logs.
- Energy map says the server key is missing → ensure `EIA` is set in repo secrets.
- Chat errors → AI chat is unavailable in static mode without a proxy.

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
