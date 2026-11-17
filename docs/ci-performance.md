# CI performance audit — November 16, 2026

Source baseline: `c4a5d59e6b657b63cdf485e2964a020b74a6450b` (current `origin/main`
when measured). Work is isolated from the original, dirty checkout. This is a
source change; no production release, refresh, secret, permission, billing or
branch-protection change is authorized by this audit.

## Sources and transfer limits

Read [Vincent Koc's article](https://vincent.build/openclaw-ci-cost-reduction/)
and its pinned OpenClaw implementation at
[`a7d05c7`](https://github.com/openclaw/openclaw/blob/a7d05c7af04aa17ac57c994da238d0c60f058ca6/.github/workflows/ci.yml),
including the [planner](https://github.com/openclaw/openclaw/blob/a7d05c7af04aa17ac57c994da238d0c60f058ca6/scripts/lib/ci-changed-node-test-plan.mts)
and [owner/import selection](https://github.com/openclaw/openclaw/blob/a7d05c7af04aa17ac57c994da238d0c60f058ca6/scripts/test-projects.test-support.mts).
Useful principles: remove repeated execution, pack work before adding runners,
preserve safety gates, and measure elapsed time and total compute separately.
The article's aggregate savings include workload changes. Its learned model
records scores without authority to omit tests. Neither its percentages nor its
Vitest/Bun/Blacksmith tooling establish a result for this Node/Playwright repo.

## Remote baseline

Read-only GitHub API snapshot, November 16 at 10:29–10:42 p.m. Eastern. The window
`2026-11-10T00:00:00Z..2026-11-17T03:29:00Z` contains 441 workflow runs,
all at attempt 1. This is a bounded census, not a full billing export.

| Workflow | Runs | Observation |
| --- | ---: | --- |
| GitHub Pages publisher | 178 | 177 success, 1 cancelled; hourly data refresh |
| Native Pages build/deployment | 177 | 175 success, 2 failure; follows publication |
| MCP | 39 | 39 success; PR/push preflight and manual releases |
| Feed | 10 | 3 success, 2 failure, 5 skipped |
| Daily monitor | 7 | 7 success |
| OpenAI | 1 | success |
| Manual diagnostic | 2 | 2 failure; unrelated held diagnostic scope |
| Dependabot | 27 | provider-managed update jobs |

All nine checked-in workflows were inspected. OpenSky, ACLED and State Connector
had no runs in this window. MCP is the only unconditional PR workflow. State
Connector has a path-filtered PR preflight. Other workflows are release,
refresh, or diagnostic lanes; they are not interchangeable with offline CI.

`main` protection requires **`preflight`**, bound to GitHub Actions app 15368,
with strict up-to-date checks and admin enforcement. The branch rules endpoint
returned no additional rules. Preserve the job ID/name and unconditional PR
trigger; workflow-level path filters could leave this check pending. Do not
cancel a manual release or change its exact-SHA binding or deployment mutex.

The last 20 completed MCP PR runs (November 10–16 Eastern, all successful)
give this baseline. Percentiles use nearest-rank p90 and median p50; queue is
run-created to job-start, feedback is run-created to job-complete.

| Metric | p50 | p90 | Range / sum |
| --- | ---: | ---: | --- |
| Preflight occupied runner time | 51.5 s | 59 s | 26–61 s; 943 s total |
| Queue | 2 s | 3 s | 2–3 s |
| Required-check feedback | 54 s | 61 s | 29–64 s |
| Per-job rounded-up minute proxy | | | 21 minutes total |

Representative source: [run 43992743646](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/43992743646).
Its occupied job time was 57 s: dependency installation 2 s, native MCP fixtures
5 s, MCP contracts 2 s, CISA fixtures 12 s, Feed/BLS fixtures 28 s. Most test steps
ran sequentially. The sample spans changing revisions; it is operational
context, not a controlled replay.

Ten recent successful Pages publisher runs had job p50 111 s / p90 141 s;
static-cache generation alone had p50 90.5 s. Representative
[run 44008098797](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44008098797).
Changing refresh frequency would change data freshness and provider work, so it
is deferred. Dynamic Pages and Dependabot workflows are not repo-owned YAML.

The repository is public and these jobs use standard `ubuntu-latest` runners.
[GitHub's billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
says standard hosted runners for public repositories are free. Current runner
cash cost is therefore **$0**. Occupied seconds and a rounded-minute proxy are
useful compute measures, not an invoice, vCPU measurement, or a dollar saving.
Storage, provider calls, sponsored capacity and paid model costs are outside
that statement. No billing endpoint or sensitive logs were needed.

## Local baseline

Node v24.22.1, macOS arm64, Apple M4, 10 available CPUs. Child wall and user+system
CPU seconds were collected with Python `monotonic()` / `RUSAGE_CHILDREN`, with
commands sequenced, logs retained, and exit codes checked. Package installation
was measured separately: root `npm ci` 6.04 s wall / 1.64 s CPU; MCP `npm ci`
0.58 s / 1.27 s. Local npm cache state differs from GitHub's.

| Command group at baseline | Executed cases | Wall | Child CPU | Result |
| --- | ---: | ---: | ---: | --- |
| Nine sequential existing preflight test commands | 293 | 52.95 s | 43.19 s | pass |
| Existing `npm test` | 697 | 61.02 s | 45.68 s | pass |
| Every offline spec, including connector adapters | 1,004 | 64.91 s | 94.43 s | pass |

The broad inventory contains 772 distinct TAP case names: spec-to-spec imports
repeat 232 executions. This is a name census, not a code-coverage percentage.
For example `monitor.spec.mjs` imports `feed-release.spec.mjs`, which imports
`feed-native-build.spec.mjs`; discovering those three separately repeats the
release fixtures. Some standalone guards were absent from `npm test` and the
old required preflight. No independent assertion should be deleted to improve
these numbers.

The CISA response-size test alone took 7.35 s locally, with most time spent
shutting down fixture HTTP connections. Cleanup must happen after its awaited
size-limit and SSE assertions, not shorten production deadlines or skip the
large response.

## Proposed reviewable steps

1. Reuse Node's native HTTP shutdown API in test-only teardown. Preserve all
   assertions, payload sizes and timeouts. Re-run the affected specs and compare
   the same CISA cases.
2. Discover all offline specs explicitly and run them once, with process
   isolation and bounded file concurrency on one existing runner. Move shared
   fixture data out of a spec and remove only aggregation imports. Keep browser
   specs in Playwright. Unknown impact always means this full offline suite;
   there is no speculative affected-test selector.
3. Make required `preflight` use that full suite; retain dependency installation,
   syntax, source-file and manual-release guards. Cancel superseded PR
   preflights only, using a job-level concurrency group unique to each PR;
   non-PR runs must use distinct groups. Leave deploy serialization unchanged.

No new dependency, runner provider, larger machine, matrix, prediction service,
test-line budget or artifact cache is justified. Dependency installation is
already about two seconds remotely; cache restore/save could cost more. Do not
remove full main-push validation without comparable evidence.

## Acceptance and reproducibility

Retain all baseline case names and required fixture behavior; add missing
standalone guards to the canonical inventory. Use full offline validation when
impact is uncertain, plus existing Playwright checks for browser coverage.
Keep process isolation; this suite replaces global fetch and uses temp fixture
directories and inert cloud executables. Do not run live monitors, cache
builders, or release helpers against providers as an offline benchmark.

Evidence (API snapshots, attempt-1 jobs, original commands, TAP logs and timings)
is retained locally under `analysis/ci-cost-20261116/`. Repeat remote measurement
with `gh api repos/CongressionalInsights/TheSituationRoomAI/actions/workflows/226238669/runs?event=pull_request&per_page=20`,
then fetch `/actions/runs/<id>/attempts/<attempt>/jobs?per_page=100` for each run.
Exclude skipped jobs from occupied time; include failures/cancellations if
present. Do not use `updated_at` as completion or mix queue with runtime.
On macOS use `/usr/bin/time -lp npm test`; on Linux use `/usr/bin/time -v npm test`.
Compare the same revision and test inventory; record install, tests and queue
separately. Fewer file entries alone do not establish lower cost.

After merging, compare a fresh 20-run cohort of required-check feedback and
runner time with the baseline, including failures and cancellations, before
claiming remote latency or compute improvement. Account for per-job rounding;
sub-minute improvements can save runner time without saving billed minutes.
Source review and local timings do not establish a remote deployment result.
