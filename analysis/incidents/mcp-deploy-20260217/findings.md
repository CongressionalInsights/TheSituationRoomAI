# MCP Proxy Deploy RCA Findings (In Progress)

## Verified facts

1. The failing workflow is `Deploy MCP Proxy (GCP)` run `22101824930` on commit `4f6102a`.
2. Both attempt 1 and rerun attempt 2 failed at the same step: `Deploy MCP proxy service`.
3. Failure signature in both attempts:
   - `Building Container ... failed`
   - `ERROR: (gcloud.run.deploy) Build failed; check build logs for details`
4. Last known successful MCP deploy run is `21734515807` on commit `c72de91`.
5. Inputs changed between known-good and failing commits in MCP source scope:
   - `gcp/mcp-proxy/server.js` (modified)
   - `gcp/mcp-proxy/feeds.json` (modified)
   - `gcp/mcp-proxy/state-signals.js` (new)
6. `gcp/mcp-proxy/package.json` did not change in that range and no committed lockfile existed before this RCA branch.

## Root-cause status

- Root cause is **not yet proven** because Cloud Build logs for the failed build were not surfaced by the prior workflow and are not available from current local gcloud context.

## Ranked hypotheses

1. **Dependency resolution drift (highest likelihood)**
   - Buildpack resolves dependencies from open ranges without a lockfile, making Cloud Build outcomes time-variant.
   - Remediation prepared: commit `gcp/mcp-proxy/package-lock.json` and enforce `npm ci` preflight.
2. **Build context packaging issue (medium likelihood)**
   - New file `state-signals.js` added; if source packaging excludes required files, container build can fail.
   - Remediation prepared: required-file preflight + source listing in workflow.
3. **Platform transient/regression (lower likelihood)**
   - Two consecutive failures reduce transient probability but do not eliminate platform-side causes.
   - Remediation prepared: Cloud Build diagnostics capture to classify quickly on next run.

## Deterministic prevention added in this branch

- PR-triggered MCP preflight checks for changes touching `gcp/mcp-proxy/**`.
- Required file presence checks (`server.js`, `state-signals.js`, `feeds.json`, `package.json`, `package-lock.json`).
- Deterministic dependency preflight: `npm ci --prefix gcp/mcp-proxy`.
- JS syntax checks: `node --check` on MCP entry files.
- Deploy output capture via `tee`.
- Automatic Cloud Build diagnostics capture (`builds list`, build ID, log URL, `builds describe`, `builds log`).
- Diagnostics artifact upload on every deploy run.

## Closure gates

- Prove root cause with captured Cloud Build log in the next failing/successful run using new diagnostics.
- Achieve two consecutive successful `Deploy MCP Proxy (GCP)` runs on `main`.
- Confirm MCP health checks pass post-deploy.
