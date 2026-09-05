# TheSituationRoom repository guidance

## Scope and source truth

- Work inside this repository unless the task explicitly widens scope. Preserve unrelated local changes.
- Treat checked-in code, `data/feeds.json`, current workflows, generated monitor artifacts, and live endpoint readback as source truth. Memory may provide context but does not own repo policy or current feed health.
- Keep changes small, preserve required tests and attribution, and verify claims with commands or artifacts before reporting them as complete.
- Production deploys, secret or permission changes, external sends, destructive cache/data actions, and paid work require explicit authorization unless the current task already grants that exact scope.

## Repository map

- `public/`: client UI, configuration, assets, Leaflet styles, and `geo/us-states.geojson`.
- `data/feeds.json`: canonical feed registry and default fetch/refresh settings.
- `gcp/`: Cloud Run feed, OpenAI, OpenSky, ACLED, and MCP proxies plus the state connector.
- `server.mjs`: local UI server and feed proxy.
- `scripts/`: feed sync, cache/build, validation, and monitor tooling.
- `analysis/`: monitor reports, snapshots, Denario output, and geo/congress evidence.
- `logos/`: branding assets.

## Core workflow

- Use Node 24 from `.nvmrc`.
- Run locally with `node server.mjs`; verify `http://localhost:5173/api/feeds` and use `/api/feed?id=<feed-id>&force=1` for a targeted refresh.
- After editing `data/feeds.json`, run `node scripts/sync-feeds.mjs` and `node scripts/verify_feeds_sync.mjs` so public, feed-proxy, and MCP copies remain aligned.
- Build generated surfaces with `node scripts/build_static_cache.mjs`, `node scripts/build_denario.mjs`, and `node scripts/build_frontend.mjs` as applicable. Do not hand-edit the versioned frontend bundle when the build script owns it.
- Validate with `node scripts/verify_public.mjs`, `npm test`, and `npm run test:ui` according to scope.
- Monitor entrypoints are `npm run monitor:core`, `monitor:all`, `monitor:docs`, and `monitor:report`; inspect both `analysis/monitor/latest.json` and `.md` before patching an alert.

## Data and architecture invariants

- Feed IDs are lowercase kebab case. Keyed feeds use `requiresKey`, `keyGroup`, and server proxy routing; never put server-managed keys in `data/feeds.json` or client settings.
- For state-level feeds, keep `jurisdictionLevel`, `supportsParams`, `defaultParams`, `capabilities`, and `paramStrategy` declarative and consistent across UI, proxies, and MCP.
- Browser traffic reaches the configured Cloud Run feed proxy through `public/services/api.js`; static cache under `data/` is the fallback when proxies fail.
- MCP remains public, read-only, stateless, and parity-aligned across `catalog.sources`, `raw.fetch`, `raw.history`, `money.flows`, `signals.list`, `signals.get`, and `search.smart`.
- When a feed category, panel, or filter changes, update `public/app.js` defaults/wiring, map legend/toggles, attribution, search state, and `buildChatContext()` so UI, search, and AI briefings remain consistent.
- Keep stable panel IDs and list keys; they drive layout persistence and settings.

## Security and deployment

- Server-managed API keys live in GCP Secret Manager and are injected by deploy workflows. Client settings may hold only user-provided OpenAI keys and local preferences.
- Keep MCP dependency overrides and the MCP, ACLED, and state-connector manifests/lockfiles aligned; `scripts/test/proxy-dependencies.spec.mjs` owns these contracts. When a package or lockfile changes, run `npm audit --prefix gcp/<service> --audit-level=high` for the affected service.
- Pages deploys from non-main branches can be overwritten by the next scheduled `main` run. Verify the target branch/SHA before treating a preview as durable.
- Deploy workflows sync feeds before proxies deploy. Feed and MCP deploys preserve sentinel findings as artifacts with `--allow-alerts`; do not erase monitor evidence merely to keep a deploy green.
- Proxy Secret Manager steps must compare before adding a version so unchanged values reuse the latest version. When changing these steps, run `node --test --test-name-pattern="proxy deploy workflows preserve an unchanged Secret Manager version" scripts/test/monitor.spec.mjs`.
- For SWPC parsing or MCP deploy safety changes, preserve the serving revision's secret bindings, validate an isolated zero-traffic candidate with `node scripts/verify_mcp_candidate.mjs <candidate-mcp-url>`, and promote only the verified revision within the task's deployment authorization. Run `node --test scripts/test/mcp-proxy.spec.mjs scripts/test/monitor.spec.mjs` for these contracts.
- For EIA proxy, static-cache, or public-payload changes, preserve credential-field sanitization across Feed Proxy, MCP, monitor serialization, and public verification; static publication must fail closed through the server-side Feed Proxy. Run `node --test scripts/test/feeds.spec.mjs scripts/test/mcp-proxy.spec.mjs scripts/test/monitor.spec.mjs` and `node scripts/verify_public.mjs`.
- The daily data-stream workflow checks deployed feed, MCP, and Pages surfaces and uploads `analysis/monitor/`; distinguish operational severity from reduced observation coverage.

## Validation by change type

- Feed registry or sync: `npm test`, sync verification, `/api/feed` readback, and in-app Feed Health.
- State-connector request/adapter changes: `node --test scripts/test/state-connector.spec.mjs gcp/state-connector/test/*.spec.mjs`. For rulemaking or executive-order adapters, update `gcp/state-connector/test/adapters.spec.mjs` fixtures, sweep similar adapters for navigation/archive/duplicate-format noise, and verify provider output plus `/api/feed` and MCP `signals.list` wrappers.
- OpenStates `state-legislation` fallback/cache changes: `node --test scripts/test/mcp-proxy.spec.mjs scripts/test/feeds.spec.mjs`; verify query-shaped `raw.fetch` keeps `fallbackUsed:false` instead of serving the static live-cache snapshot.
- Static cache fallback/error handling: `node --test scripts/test/feeds.spec.mjs`; upstream quota/error payloads must not be published as healthy snapshots.
- UI/layout/theme: `npm run test:ui`, local server inspection, map interactivity, feed health, and per-panel timestamps. Keep theme changes centralized in CSS variables and `data-theme` rules.
- Monitor/data-stream changes: `npm run monitor:all` and review the canonical JSON/Markdown reports before and after.
- Volatile provider documentation in `data/feed-monitoring.json`: prefer reviewed `requiredSurfaceMarkers` over whole-page hashes. Run `node --test scripts/test/monitor.spec.mjs`; missing markers must remain `docs-contract-change` alerts while cosmetic churn stays quiet.
- Congress detail changes: run `node scripts/validate_congress_detail.mjs` against the relevant base and inspect the generated Congress evidence artifact.
- Congress.gov committee-report sorting: compare the top five citations for ascending and descending `sort=updateDate` queries before relying on ordering; matching results indicate degraded upstream sorting to monitor.
- Documentation-only operating-model edits: run a focused stale-text search and `git diff --check`.
