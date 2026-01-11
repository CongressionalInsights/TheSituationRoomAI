# Repository Guidelines

## Project Structure & Module Organization
- `public/` contains the client UI (`index.html`, `styles.css`, `app.js`) plus static assets and Leaflet styles. The Energy Map uses `public/geo/us-states.geojson`.
- `server.mjs` is the Node.js server that serves the UI and proxies feed requests.
- `data/feeds.json` is the canonical feed registry and default settings (refresh interval, user agent, key groups).
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

## Testing Guidelines
- No automated test suite is configured.
- Validate changes by running the server and checking: map interactivity, feed health, and per‑panel “last updated” stamps.
- For new feeds, confirm output in `/api/feed` and the in‑app Feed Health status.

## Commit & Pull Request Guidelines
- No Git history is present; if you initialize Git, use short present‑tense messages (e.g., “Refine energy map legend”).
- PRs should include: summary, screenshots for UI work, and any new key requirements or feed IDs touched.

## Security & Configuration Notes
- API keys are entered via Settings and stored locally in the browser.
- Do not hard‑code secrets in `data/feeds.json`; use `requiresKey` and key groups instead.
- For server-side keys, set environment variables (e.g., `OPENAI_API_KEY`).
