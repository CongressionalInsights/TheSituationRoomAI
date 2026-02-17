# MCP Proxy Deploy RCA Findings (Root Cause Proven)

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
7. Hardened workflow run `22103142410` reproduced the deploy failure and uploaded diagnostics artifact.
8. In run `22103142410`, diagnostics showed `gcloud builds list` returned no build IDs when run without explicit `--region`, while deploy target region is `us-central1`.
9. Region-scoped diagnostics run `22103309052` captured Cloud Build `93fd8f1c-4fc8-4d5f-bcd0-4a8a9898fc07` and decoded buildpack error payload.
10. Decoded Cloud Build output proves root cause:
    - Buildpack: `google.nodejs.runtime`
    - Error: `invalid Node.js version specified ... failed to resolve version matching: 20.x ... Version constraint "20.x" not satisfied by any available versions in Artifact Registry`
    - Available versions in builder: `22.x` and `24.x` lines only (no `20.x`)
11. After changing MCP runtime to Node `22.x`, full deploy runs `22103468629` and `22103564465` both completed successfully with health checks passing.

## Root-cause status

- Root cause is **proven**:
  - MCP deploy uses Cloud Run buildpacks.
  - `gcp/mcp-proxy/package.json` pinned Node engine to `20.x`.
  - Current serverless runtime builder (`universal_builder_20260202_RC02`) no longer provides Node `20.x`.
  - Build fails deterministically before image creation.

## Root cause class

- **Dependency/runtime compatibility mismatch**: project runtime constraint (`20.x`) is incompatible with currently available buildpack Node runtimes in the deploy builder.
- **Diagnostics observability gap** (secondary): Cloud Build lookups were initially unscoped to region and Cloud Build log streaming lacked permissions for the CI service account.

## Deterministic prevention added in this branch

- PR-triggered MCP preflight checks for changes touching `gcp/mcp-proxy/**`.
- Required file presence checks (`server.js`, `state-signals.js`, `feeds.json`, `package.json`, `package-lock.json`).
- Deterministic dependency preflight: `npm ci --prefix gcp/mcp-proxy`.
- JS syntax checks: `node --check` on MCP entry files.
- Deploy output capture via `tee`.
- Automatic Cloud Build diagnostics capture (`builds list`, build ID, log URL, `builds describe`, `builds log`).
- Cloud Build diagnostics now explicitly scoped to deploy region (`--region "$REGION"`).
- Workflow now decodes and prints Cloud Build build-step structured error payload from `buildStepOutputs` for self-explanatory failures.
- Diagnostics artifact upload on every deploy run.
- Runtime fix applied: MCP engine updated from `20.x` to `22.x` and preflight Node version aligned to `22`.

## Closure gates

- Confirm fixed branch deploy run succeeds (build, revision, health checks). **Done** (`22103468629`).
- Achieve two consecutive successful `Deploy MCP Proxy (GCP)` runs on `main`. **Pending merge to main**.
- Confirm MCP health checks pass post-deploy (`/health`, `/.well-known/mcp.json`). **Done on branch deploy runs** (`22103468629`, `22103564465`).
