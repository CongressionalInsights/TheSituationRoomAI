# Remote read of existing GDACS diagnostics

This manual-only workflow reads already-written application diagnostics on the two
fixed accepted Feed/MCP revisions. It does not request GDACS or deploy anything.
The existing GitHub connection can dispatch and inspect it from the cloud owner;
Google authentication stays inside Actions using the existing `GCP_SA_KEY` secret
and `gh-actions-deployer` identity. This is the current key-backed path, not OIDC.
No credential is copied to the cloud worker or laptop.

Publication and execution require their applicable exact authorization. After
normal protected integration, dispatch `read-tsr-gdacs-logs.yml` on main with the
actual reviewed `expected_sha`, Root's reserved `approval_ref`, and a completed
UTC window of at most 15 minutes. Source/ref/repository/attempt/window/role bind
before authentication. No schedule, push or PR starts this diagnostic job.

Only one logical `gcloud logging read` is admitted per first-attempt workflow run,
with ten rows, a 30-second subprocess timeout and a 64-KiB selected-output cap.
The SDK may refresh credentials, paginate or internally retry; HTTP counts and
wire bytes are not measured by that output cap. Cancellation cannot guarantee
remote server work stopped. No application retry or workflow rerun is allowed.
Root's existing registry prevents duplicate dispatch of an approval; local files
are per-run receipts, not a second registry or cross-run duplicate detector.

The fixed query selects `gdacs_primary_failure` on the accepted Feed revision
`43789760050-1` and MCP revision `43801846565-1`. Changing target revisions or event
scope needs another reviewed source change. Only timestamp/service/revision and
existing allowlisted diagnostics leave the runner. Raw log text, body, headers,
credential values and stderr are never uploaded. Empty results do not prove health;
unrecognized rows remain explicit. JSON/identity/refusal/timeout/output-cap errors
produce a failed or uncertain disposition without retry, login or IAM/API repair.

The existing principal needs `logging.logEntries.list` on the existing project.
Its current Logging permission has not been tested by preparation. A refusal stops
without broadening IAM. Authentication or setup failure preserves a no-read result
when possible; hard cancellation may leave only the native run/intent as uncertain.
Read the retained receipt before any future action. No release, provider query,
secret sync, new resource, API enablement, account switch or outreach is included.
