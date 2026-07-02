# Repository Guidelines

## Memory
- Before substantial work, consult the local memory file at `$CODEX_HOME/memories/projects/TheSituationRoom.md` or `$HOME/.codex/memories/projects/TheSituationRoom.md` when present.
- Use it for durable repo context only: stable workflow decisions, repo-specific conventions, and important follow-ups.
- Do not store secrets there, and update it when long-lived context changes.

## Project Structure & Module Organization
- `public/` contains the client UI (`index.html`, `styles.css`, `app.js`, `services/api.js`, `config.js`) plus static assets and Leaflet styles. The Energy Map uses `public/geo/us-states.geojson`.
- `data/feeds.json` is the canonical feed registry and default settings (refresh interval, user agent, key groups).
- `gcp/` contains Cloud Run proxies (feed, openai, opensky, acled, mcp). `worker/` mirrors a Cloudflare Worker fallback.
- `server.mjs` serves the UI locally and proxies feed requests for local development.
- `analysis/` stores snapshot exports and geo cache output (`analysis/denario/`, `analysis/geo/`).
- `logos/` holds branding assets (favicon, logo, OG image).

## Build, Test, and Development Commands
- Use Node 24 (`.nvmrc`; workflows use `actions/setup-node` with `node-version-file: .nvmrc`).
- `node server.mjs` — run the local server at `http://localhost:5173`.
- `curl http://localhost:5173/api/feeds` — verify the server is live and feeds load.
- `curl "http://localhost:5173/api/feed?id=<feed-id>&force=1"` — force-refresh a single feed.
- `node scripts/sync-feeds.mjs` — sync `data/feeds.json` into public and Cloud Run proxy copies.
- `node scripts/verify_feeds_sync.mjs` — verify feed registry parity across those copies.
- `node scripts/build_static_cache.mjs` — rebuild the static cache in `data/`.
- `node scripts/build_denario.mjs` — build `public/data/denario.json` from MCP `search.smart` (set `MCP_PROXY` to override the endpoint; `DENARIO_MIN_HOURS` defaults to 6).
- `node scripts/build_frontend.mjs` — rebuild the versioned frontend bundle (matches `npm run build:frontend`).
- `node scripts/verify_public.mjs` — verify the built public bundle and basic secret-leak patterns.
- `npm run monitor:core|monitor:all|monitor:docs|monitor:report` — run the monitor entrypoints under `analysis/monitor/`.
- `npm audit --prefix gcp/mcp-proxy --audit-level=high` and `npm audit --prefix gcp/acled-proxy --audit-level=high` — audit lockfile-backed Cloud Run proxy packages.
- `npm test` — run feed sync validation plus the Node test suite.
- `npm run test:ui` — run Playwright UI tests.

## Coding Style & Naming Conventions
- Use 2‑space indentation for JavaScript, HTML, and JSON.
- Prefer explicit IDs for panel content: `data-panel="energy-map"`, `id="energyMap"`, `id="energyList"`.
- Feed IDs are lowercase kebab case (e.g., `state-travel-advisories`).
- Keep theme changes centralized in CSS variables and `data-theme` rules.
- Layout defaults, list defaults, and modal configs live in `public/app.js`. Update those constants first, then wire UI.

## Testing Guidelines
- Automated tests are limited; prioritize manual verification for UI changes.
- Use `npm test` for feed sync + Node tests when touching feed registry logic or sync flows.
- Use `npm run test:ui` for UI regressions that need browser coverage.
- When changing static cache fallback/error handling, run `node --test scripts/test/feeds.spec.mjs`; BLS CPI quota/error JSON should fall back instead of publishing as a healthy snapshot.
- Use `npm run monitor:all` for full data-stream audits; inspect `analysis/monitor/latest.json` and `analysis/monitor/latest.md` before patching monitor warnings.
- Validate changes by running the server and checking: map interactivity, feed health, and per‑panel “last updated” stamps.
- For new feeds, confirm output in `/api/feed` and the in‑app Feed Health status.

## Commit & Pull Request Guidelines
- Use short present‑tense commit messages (e.g., “Refine energy map legend”).
- PRs should include: summary, screenshots for UI work, and any new key requirements or feed IDs touched.

## Security & Configuration Notes
- Server‑managed keys (DATA_GOV, EIA, NASA_FIRMS, OPEN_AQ, OPENSTATES, etc.) live in GCP Secret Manager and are injected by GitHub Actions when deploying Cloud Run.
- Client‑side Settings only hold user BYO keys (OpenAI) and local preferences; do not add server keys to the UI.
- Do not hard‑code secrets in `data/feeds.json`; use `requiresKey`, `keyGroup`, and server proxy routing.
- The MCP proxy (`gcp/mcp-proxy`) is public read‑only; keep it stateless and avoid persisting upstream data.
- Keep `gcp/mcp-proxy/package.json` overrides and both proxy lockfiles aligned with dependency changes; `npm test` includes `scripts/test/proxy-dependencies.spec.mjs`.

## Architecture & Data Flow
- Browser → `public/services/api.js` → `window.SR_CONFIG.apiBase` (Cloud Run feed proxy) for key‑protected feeds.
- Agents → MCP endpoint (`/mcp`) for raw + normalized feed access; use `catalog.sources` to enumerate supported feeds.
- MCP exposes `catalog.sources`, `raw.fetch`, `raw.history`, `money.flows`, `signals.list`, `signals.get`, and `search.smart`; keep feed metadata and state-filter behavior aligned across those tools.
- Static cache lives in `data/` and is used as a fallback when proxies are unavailable.
- Map overlays and legend state are driven by settings defaults in `public/app.js`.
- AI briefings and chat context are assembled in `buildChatContext()` inside `public/app.js` (and mirrored in the versioned bundle). If you add a new feed category or panel, include it in the context so AI analysis and search stay aligned.

## Deployment & Monitoring Notes
- `.github/workflows/deploy-pages.yml` runs on pushes, manual dispatch, and an hourly `main` schedule; manual branch Pages deploys can be overwritten by the next scheduled `main` run.
- The Pages deploy builds static cache, Denario insights, then the frontend bundle; keep `public/data/denario.json` generation compatible with the public MCP endpoint or set `MCP_PROXY` in the environment.
- Deploy workflows run `node scripts/sync-feeds.mjs` before deploying proxies so feed registry copies must stay in sync before commit.
- Feed and MCP proxy deploy workflows run the core sentinel with `--allow-alerts`; this preserves monitor findings as artifacts/signals without failing otherwise healthy deploys.
- `.github/workflows/monitor-data-streams.yml` runs the daily full audit against the deployed Feed Proxy, MCP endpoint, and GitHub Pages static snapshot and uploads `analysis/monitor/` artifacts.

## Safe Change Checklist
- Add feeds in `data/feeds.json`, then update `public/data/feeds.json` and the Cloud Run copies in `gcp/feed-proxy/feeds.json` and `gcp/mcp-proxy/feeds.json` so UI, search/briefings, and MCP stay aligned.
- For state-level feeds, set `jurisdictionLevel`, `supportsParams`, `defaultParams`, `capabilities`, and `paramStrategy` so param behavior is declarative and consistent across UI/proxies/MCP.
- Update panel list defaults and any map layer wiring in `public/app.js` (and the versioned bundle when needed).
- Ensure AI context/search coverage includes the new feed category in `buildChatContext()` so briefings and search stay in sync.
- Add or update attribution in the About modal’s “Where the data comes from” list, with required source wording and links.
- Keep MCP parity when adding feed metadata: `catalog.sources`, `signals.list`, `signals.get`, and `search.smart` should accept or expose the same state-filter capabilities.
- Keep panel IDs and list keys stable; they drive layout persistence and settings.
- When adding map layers, also update legend groups and default toggles to avoid hidden layers.
- If you change search behavior or add categories, update `state.lastSearch*` tracking and the AI context to reflect the new filters.
- When touching Congress.gov summaries or detail targets, run `node scripts/validate_congress_detail.mjs` (use `--base <deploy-url>` when validating Cloud Run) and review `analysis/congress/congress-detail-404.json`.
- For Congress.gov committee reports, do not assume `sort=updateDate` is honored upstream. Compare top 5 citations for asc vs desc periodically; if they match, treat sorting as degraded and monitor until upstream fix lands.
