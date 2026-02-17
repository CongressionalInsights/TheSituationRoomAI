# Cloud Build Log Status

- Required artifact target: `cloudbuild-<BUILD_ID>.log`
- Current status for `22101824930`: unavailable because the original workflow did not emit build IDs/log URLs.
- First hardened run (`22103142410`) reproduced failure but still showed no build IDs because diagnostics queried Cloud Build without explicit region.
- Next action (implemented): diagnostics now call `gcloud builds list/describe/log --region "$REGION"`; rerun to collect definitive `cloudbuild-<BUILD_ID>.log`.
