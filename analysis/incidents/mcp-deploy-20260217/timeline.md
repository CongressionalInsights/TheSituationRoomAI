# MCP Proxy Deploy Incident Timeline (UTC)

- Incident: `mcp-deploy-20260217`
- Workflow: `Deploy MCP Proxy (GCP)`
- Failing run: `22101824930`
- Failing commit on `main`: `4f6102a12efcc9af338282123f41f83c93ef4629`
- Last known successful MCP deploy run: `21734515807` on `c72de91c1a46d16e66c7da60a7d7e9ac577885d7`

## Chronology

| Timestamp | Event |
| --- | --- |
| 2026-02-17T14:13:28Z | Run `22101824930` created on push to `main`. |
| 2026-02-17T14:14:05Z | Attempt 1 deploy step started (`Deploy MCP proxy service`). |
| 2026-02-17T14:14:35Z | Attempt 1 failed in Cloud Build stage (`Building Container...failed`). |
| 2026-02-17T14:16:55Z | Attempt 2 (rerun) started. |
| 2026-02-17T14:17:40Z | Attempt 2 deploy step started. |
| 2026-02-17T14:18:15Z | Attempt 2 failed with same signature (`ERROR: (gcloud.run.deploy) Build failed; check build logs for details`). |
| 2026-02-17T14:18:19Z | Run `22101824930` completed with failure. |

## Differential inputs reviewed

- `git diff --name-status c72de91..4f6102a -- gcp/mcp-proxy`:
  - `M gcp/mcp-proxy/feeds.json`
  - `M gcp/mcp-proxy/server.js`
  - `A gcp/mcp-proxy/state-signals.js`
- `gcp/mcp-proxy/package.json` was unchanged between these commits.
- No lockfile existed in-repo for `gcp/mcp-proxy` at failure time.

## Evidence files

- `github-run-22101824930.log`
- `github-run-22101824930-attempt1.log`
- `github-run-22101824930.meta.json`
- `github-run-22101824930-attempt1.meta.json`
- `github-run-21734515807.log`
- `github-run-21734515807.meta.json`
- `failure-signatures.txt`
- `gcloud-access-check.txt`

## Notes

- Local `gcloud` context (`ashir.gruder@gmail.com` / project `sitehunterai-dev`) did not return Cloud Build rows for `situationroom-ai-20260112`.
- Existing workflow did not emit Cloud Build ID or log URL, blocking direct root-cause confirmation from Cloud Build logs.
- Workflow hardening in this branch adds deterministic deploy diagnostics so future failures expose Cloud Build IDs and logs directly in Actions artifacts.
