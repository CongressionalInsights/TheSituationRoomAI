# Cloud Build Log Status

- Required artifact target: `cloudbuild-<BUILD_ID>.log`
- Current status: unavailable for run `22101824930` because the previous workflow did not emit build IDs and local gcloud context could not list builds in project `situationroom-ai-20260112`.
- Next action: rerun MCP deploy with hardened workflow to capture build ID and write `cloudbuild-<BUILD_ID>.log` automatically in workflow diagnostics artifact.
