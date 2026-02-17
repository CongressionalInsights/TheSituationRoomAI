# Cloud Build Log Status

- Required artifact target: `cloudbuild-<BUILD_ID>.log`
- Current status for `22101824930`: unavailable because the original workflow did not emit build IDs/log URLs.
- First hardened run (`22103142410`) reproduced failure but still showed no build IDs because diagnostics queried Cloud Build without explicit region.
- Region-scoped rerun (`22103309052`) captured:
  - `cloudbuild-93fd8f1c-4fc8-4d5f-bcd0-4a8a9898fc07-describe.json`
  - `cloudbuild-93fd8f1c-4fc8-4d5f-bcd0-4a8a9898fc07.log`
  - decoded buildpack payload (`buildpack-error-decoded.json`) proving Node `20.x` runtime incompatibility.
