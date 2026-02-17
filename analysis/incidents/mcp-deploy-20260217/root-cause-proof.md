# Root Cause Proof

## Cloud Build evidence

- Workflow run: `22103309052`
- Cloud Build ID: `93fd8f1c-4fc8-4d5f-bcd0-4a8a9898fc07`
- Source artifact: `diagnostics-run-22103309052/cloudbuild-93fd8f1c-4fc8-4d5f-bcd0-4a8a9898fc07-describe.json`
- Decoded payload: `diagnostics-run-22103309052/buildpack-error-decoded.json`

## Decoded error (verbatim)

```
invalid Node.js version specified: failed to resolve version matching: 20.x ...
Version constraint "20.x" not satisfied by any available versions in Artifact Registry.
```

## Interpretation

- MCP build is using Cloud Run buildpacks (`google.nodejs.runtime`).
- The deployed builder image (`universal_builder_20260202_RC02`) currently provides Node 22/24 lines, not Node 20.
- `gcp/mcp-proxy/package.json` declared `"engines": { "node": "20.x" }`, which deterministically fails build resolution.
- Therefore the deploy failure is caused by runtime constraint incompatibility, not transient infra failure.
