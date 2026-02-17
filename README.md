# The Situation Room

A clean, high‑signal situational awareness dashboard with a unified news layer, geo‑tagged incidents, finance & crypto pulses, and an analysis panel.

## Release notes (Jan 2026)
- Added **Money Flows** panel aggregating USAspending, LDA, OpenFEC, and SAM.gov results.
- New MCP tool: `money.flows` (JSON‑RPC via `/mcp`, use `tools/call` and `Accept: application/json, text/event-stream`).
- SAM.gov now supports a dedicated secret (`SAMGOV_API_KEY`) for authenticated access.

## Run locally
```bash
cd "~codex/projects/TheSituationRoom"
DATA_GOV="your_data_gov_key" \
EIA="your_eia_key" \
NASA_FIRMS="your_nasa_firms_key" \
OPEN_AQ="your_openaq_key" \
OPENSTATES="your_openstates_key" \
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

## Congress.gov summaries + detail validation
- Congress.gov summaries are merged into bill items for the Congressional Insights list (summary text is stripped of HTML for readability).
- As of February 17, 2026, the upstream `/committee-report` endpoint may ignore `sort=updateDate` ordering. Keep the current query but monitor sort health.
- Operational sort check (if top 5 citations for `desc` and `asc` are identical, treat sorting as degraded upstream):
```bash
BASE=http://127.0.0.1:5173
for SORT in 'updateDate+desc' 'updateDate+asc'; do
  echo "sort=$SORT"
  curl -sS --get "$BASE/api/congress-detail" \
    --data-urlencode "url=https://api.congress.gov/v3/committee-report?format=json&limit=20&sort=$SORT" \
    | jq -r '.reports[0:5][]?.citation'
done
```
- Validate Congress detail endpoints locally:
```bash
node server.mjs
node scripts/validate_congress_detail.mjs
```
- Or run against a deployed proxy:
```bash
node scripts/validate_congress_detail.mjs --base https://situation-room-feed-382918878290.us-central1.run.app
```
- Report output: `analysis/congress/congress-detail-404.json` (local only).

## Map imagery layers
- Open the map **Legend** to switch basemaps (OSM / Esri Satellite / NASA VIIRS True Color).
- Turn on **Terrain Hillshade** or **SAR (Sentinel‑1)** overlays.
- Use the **Imagery date** and **SAR date** pickers in the legend to view specific days.

## Refresh + themes
- Default refresh is hourly. Use Settings to drop to 1 minute or switch theme (dark/light/system).
- Use **Refresh Now** to force a re-fetch.

## Snapshot export
- **Export Snapshot** downloads a JSON snapshot and saves a copy to `analysis/denario/snapshots/`.

## AI assistant + analysis
- Add your OpenAI key under **OpenAI Assistant** in Settings → API Keys for local/server mode.
- Chat, AI briefings, and AI query translation use `/api/chat` (OpenAI Responses API).
- Optional: set `OPENAI_API_KEY` on the server if you prefer not to send the key from the browser.
- AI briefing context includes Congress.gov signals and the most recent search query/scope so legislative updates stay visible in the summary.

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
  - `OPENSTATES` (required for state legislation feeds)
  - `EARTHDATA_NASA` (optional, only needed if you add Earthdata‑protected feeds)
  - `OPEN_AI` (optional, enables build-time AI briefing cache)
  - `analysis.json` is generated at build time if `OPEN_AI` is set.

Static mode limits (optional):
- The **Refresh Now** button reloads cached JSON; it does not re-fetch live data.
- Search queries are limited to the cached/default feed queries.
- AI chat requires a server proxy. Without it, the briefing panel falls back to the cached `analysis.json` when available.
- You can enable **Live Search** to query GDELT + Google News directly on static hosting.
- If **Super Monitor Mode** is enabled, the browser will attempt live fetches for keyless feeds and merge them with cached data.
- If FOIA.gov is temporarily unavailable, the cache builder will fall back to the last published FOIA snapshot on GitHub Pages.

### Configure static mode (optional)
`public/config.js` now defaults to **live server mode** on GitHub Pages via the Feed Proxy (see below). If you want to run purely static, set:
```js
window.SR_CONFIG.staticMode = true;
window.SR_CONFIG.apiBase = ''; // disable the live feed proxy
```

## OpenAI proxy (Cloud Run on GCP)
To enable OpenAI chat on the live GitHub Pages site, deploy the proxy in `gcp/openai-proxy/` and set `window.SR_CONFIG.openAiProxy`.
This repo is already wired to use:
`https://situation-room-openai-382918878290.us-central1.run.app/api/chat`
when served from `*.github.io`.

### GitHub Actions (recommended)
There is a workflow that updates the Cloud Run proxy and injects the OpenAI key securely from GitHub secrets:

- Workflow: `.github/workflows/deploy-openai-proxy.yml`
- Required repo secrets:
  - `GCP_SA_KEY` (service account JSON for GCP)
  - `OPEN_AI` (OpenAI API key)
- The workflow writes `OPEN_AI` into GCP Secret Manager and binds it to the Cloud Run service.

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

## MCP proxy (Cloud Run, public read-only)
The MCP proxy exposes raw feed data plus normalized signals for agents (no auth required).

- Endpoint: `https://situation-room-mcp-382918878290.us-central1.run.app/mcp`
- Manifest: `https://situation-room-mcp-382918878290.us-central1.run.app/.well-known/mcp.json`
- Tools: `catalog.sources`, `raw.fetch`, `raw.history`, `signals.list`, `signals.get`, `search.smart`
- Supports full historical ranges where the upstream API allows it (the MCP server forwards query params).

### GitHub Actions (recommended)
- Workflow: `.github/workflows/deploy-mcp-proxy.yml`
- Required repo secrets:
  - `GCP_SA_KEY`
  - `DATA_GOV`
  - `EIA`
  - `NASA_FIRMS`
  - `OPEN_AQ`
  - `OPENSTATES`
  - `EARTHDATA_NASA`

## OpenSky proxy (Cloud Run on GCP)
OpenSky now requires OAuth2 client credentials. The live dashboard uses a Cloud Run proxy to keep credentials server-side and raise rate limits.
This repo is wired to use:
`https://situation-room-opensky-382918878290.us-central1.run.app/api/opensky`
when served from `*.github.io`.

### GitHub Actions (recommended)
- Workflow: `.github/workflows/deploy-opensky-proxy.yml`
- Required repo secrets:
  - `GCP_SA_KEY`
  - `OPENSKY_CLIENTID`
  - `OPENSKY_CLIENTSECRET`
- The workflow writes credentials into GCP Secret Manager and deploys the Cloud Run service.

### Wire the proxy into the UI
Edit `public/config.js` if you deploy to a different URL:
```js
window.SR_CONFIG = window.SR_CONFIG || {};
window.SR_CONFIG.openSkyProxy = 'https://<your-cloud-run-url>/api/opensky';
```

## Feed proxy (Cloud Run on GCP)
The live GitHub Pages site uses a **Feed Proxy** to fetch key‑protected feeds server‑side and keep data fresh without exposing secrets.
This repo is wired to use:
`https://situation-room-feed-382918878290.us-central1.run.app`
as `window.SR_CONFIG.apiBase` on `*.github.io`.

### GitHub Actions (recommended)
- Workflow: `.github/workflows/deploy-feed-proxy.yml`
- Required repo secrets:
  - `GCP_SA_KEY`
  - `DATA_GOV`
  - `EIA`
  - `NASA_FIRMS`
  - `OPEN_AQ`
  - `OPENSTATES`
  - `EARTHDATA_NASA`
- The workflow writes secrets into GCP Secret Manager and deploys the Cloud Run service.

### Wire the proxy into the UI
`public/config.js` sets the default API base on GitHub Pages. To use a different URL:
```js
window.SR_CONFIG = window.SR_CONFIG || {};
window.SR_CONFIG.apiBase = 'https://<your-cloud-run-url>';
```

## Optional: server-side proxy (advanced)
If you later add a full runtime backend, you can disable static mode and point the UI at your `/api/*` backend by setting `window.SR_CONFIG.apiBase` in `public/config.js`. This repo includes a Cloudflare Worker implementation in `worker/` for optional use.

## Troubleshooting
- "Feed API unreachable" → static cache failed to build; check the GitHub Actions logs.
- Energy map says the server key is missing → ensure `EIA` is set in repo secrets.
- State legislation requests fail with `missing_server_key`/`HTTP 403` → ensure `OPENSTATES` is set in repo secrets and redeploy Feed + MCP proxies.
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
