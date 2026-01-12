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

Static mode limits:
- The **Refresh Now** button reloads cached JSON; it does not re-fetch live data.
- Search queries are limited to the cached/default feed queries.
- AI chat requires a server proxy (not available on pure static hosting).

### Configure static mode (default)
`public/config.js` sets `staticMode = true` when served from `*.github.io`. No extra configuration is required for GitHub Pages.

## Optional: server-side proxy (advanced)
If you later add a runtime proxy, you can disable static mode and point the UI at your `/api/*` backend by setting `window.SR_CONFIG.apiBase` in `public/config.js`. This repo includes a Cloudflare Worker implementation in `worker/` for optional use.

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
