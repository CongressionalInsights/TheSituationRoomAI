# The Situation Room

A clean, high‑signal situational awareness dashboard with a unified news layer, geo‑tagged incidents, finance & crypto pulses, and an analysis panel.

## Run locally
```bash
cd "/Users/ashirgruder/projects/TheSituationRoom"
node server.mjs
```
Then open `http://localhost:5173`.

## Configure feeds
- Feed registry: `data/feeds.json`
- Add/edit feeds in the registry. Mark `requiresKey: true` for sources you’ll wire later.
- Some providers require a User‑Agent; update `app.userAgent` in `data/feeds.json`.

## API keys (in‑app)
- Open Settings → API Keys.
- Paste keys and (if needed) the query param or header name.
- Keys are stored locally in browser storage and applied per feed.
- Use the **Test** button to validate keys without leaving the dashboard.

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
