# Repository Guidelines

## Project Structure & Module Organization
- `public/` contains the client UI (`index.html`, `styles.css`, `app.js`, `services/api.js`, `config.js`) plus static assets and Leaflet styles. The Energy Map uses `public/geo/us-states.geojson`.
- `data/feeds.json` is the canonical feed registry and default settings (refresh interval, user agent, key groups).
- `gcp/` contains Cloud Run proxies (feed, openai, opensky, acled, mcp). `worker/` mirrors a Cloudflare Worker fallback.
- `server.mjs` serves the UI locally and proxies feed requests for local development.
- `analysis/` stores snapshot exports and geo cache output (`analysis/denario/`, `analysis/geo/`).
- `logos/` holds branding assets (favicon, logo, OG image).

## Build, Test, and Development Commands
- `node server.mjs` — run the local server at `http://localhost:5173`.
- `curl http://localhost:5173/api/feeds` — verify the server is live and feeds load.
- `curl "http://localhost:5173/api/feed?id=<feed-id>&force=1"` — force-refresh a single feed.

## Coding Style & Naming Conventions
- Use 2‑space indentation for JavaScript, HTML, and JSON.
- Prefer explicit IDs for panel content: `data-panel="energy-map"`, `id="energyMap"`, `id="energyList"`.
- Feed IDs are lowercase kebab case (e.g., `state-travel-advisories`).
- Keep theme changes centralized in CSS variables and `data-theme` rules.
- Layout defaults, list defaults, and modal configs live in `public/app.js`. Update those constants first, then wire UI.

## Testing Guidelines
- No automated test suite is configured.
- Validate changes by running the server and checking: map interactivity, feed health, and per‑panel “last updated” stamps.
- For new feeds, confirm output in `/api/feed` and the in‑app Feed Health status.

## Commit & Pull Request Guidelines
- No Git history is present; if you initialize Git, use short present‑tense messages (e.g., “Refine energy map legend”).
- PRs should include: summary, screenshots for UI work, and any new key requirements or feed IDs touched.

## Security & Configuration Notes
- Server‑managed keys (DATA_GOV, EIA, NASA_FIRMS, OPEN_AQ, etc.) live in GCP Secret Manager and are injected by GitHub Actions when deploying Cloud Run.
- Client‑side Settings only hold user BYO keys (OpenAI) and local preferences; do not add server keys to the UI.
- Do not hard‑code secrets in `data/feeds.json`; use `requiresKey`, `keyGroup`, and server proxy routing.
- The MCP proxy (`gcp/mcp-proxy`) is public read‑only; keep it stateless and avoid persisting upstream data.

## Architecture & Data Flow
- Browser → `public/services/api.js` → `window.SR_CONFIG.apiBase` (Cloud Run feed proxy) for key‑protected feeds.
- Agents → MCP endpoint (`/mcp`) for raw + normalized feed access; use `catalog.sources` to enumerate supported feeds.
- Static cache lives in `data/` and is used as a fallback when proxies are unavailable.
- Map overlays and legend state are driven by settings defaults in `public/app.js`.
- AI briefings and chat context are assembled in `buildChatContext()` inside `public/app.js` (and mirrored in the versioned bundle). If you add a new feed category or panel, include it in the context so AI analysis and search stay aligned.

## Safe Change Checklist
- Add feeds in `data/feeds.json`, then update `public/data/feeds.json` and the Cloud Run copies in `gcp/feed-proxy/feeds.json` and `gcp/mcp-proxy/feeds.json` so UI, search/briefings, and MCP stay aligned.
- Update panel list defaults and any map layer wiring in `public/app.js` (and the versioned bundle when needed).
- Ensure AI context/search coverage includes the new feed category in `buildChatContext()` so briefings and search stay in sync.
- Add or update attribution in the About modal’s “Where the data comes from” list, with required source wording and links.
- Keep panel IDs and list keys stable; they drive layout persistence and settings.
- When adding map layers, also update legend groups and default toggles to avoid hidden layers.
- If you change search behavior or add categories, update `state.lastSearch*` tracking and the AI context to reflect the new filters.
