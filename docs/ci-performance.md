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

The CISA response-size case alone took 7.35 s locally. An initial hypothesis
blamed fixture HTTP shutdown. A measured teardown-only experiment still took
7.09 s for its eight-case file and 62.27 s for the monitor file, so that change
was discarded. Reading the client revealed repeated 500/1,200 ms retry sleeps;
the fixture's deterministic payload rejection did not need those retries.

## Decisions and implemented steps

1. Use the existing `retry: false` option in the CISA payload-size fixture. Keep
   all eight cases, assertions and payload sizes, and assert exactly four
   requests for the four transport cases. Default retry coverage remains in
   the full monitor suite, including explicit three-attempt assertions. The
   eight-case file fell from 7.49 s / 2.48 CPU s to 0.79 s / 0.90 CPU s in the
   recorded local invocation. No production client, backoff or deadline changed.
2. Discover all offline specs explicitly and run them once, with process
   isolation and bounded file concurrency on one existing runner. Move shared
   fixture data out of a spec and remove only aggregation imports. Keep browser
   specs in Playwright. Unknown impact always means this full offline suite;
   there is no speculative affected-test selector.
3. Make required `preflight` use that full suite; retain dependency installation,
   syntax, source-file and manual-release guards. Cancel superseded PR
   preflights only, using a job-level concurrency group unique to each PR;
   non-PR runs must use distinct groups. Leave deploy serialization unchanged.

The implementation uses Node 24's native `globSync`, `spawnSync` and
`availableParallelism`, with no new dependency. `npm test` verifies feed sync
and runs every offline spec under `scripts/test/` and
`gcp/state-connector/test/`, including nested future specs. The browser boundary
matches the existing Playwright config. Empty inventories and subprocess
failures cannot succeed silently. A fixture test proves a real failing child
test returns failure; a guard prevents spec-to-spec imports from reintroducing
duplicate execution.

Same source, 775-case candidate trials (before the final concurrency guard):

| File worker limit | Wall | Child CPU | Result |
| --- | ---: | ---: | --- |
| 2 | 40.50 s | 55.00 s | 775 passed |
| 4 | 37.02 s | 55.75 s | 775 passed |

The default caps workers at four, respecting smaller CPU allocations. The
existing public runner has [four CPUs / 16 GB](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
These single local trials favor four workers: 8.6% less elapsed time than two
for 1.4% more process CPU. This is qualification on macOS, not a Linux speedup
claim or a runner memory measurement.

Against the complete broad baseline, the four-worker trial reduced wall time
by 43.0% and child CPU by 41.0%, retaining all 772 distinct baseline TAP names
and adding three runner checks. The removed work is 232 duplicate executions,
not deleted behavioral assertions. Against the old narrow preflight, local
test wall time fell 30.1%, while process CPU **increased 29.1%** (43.19 → 55.75
CPU s) because the candidate checks much more behavior. The full-suite fallback
is an intentional coverage/CPU tradeoff. Compared with the old 697-case
`npm test`, elapsed time fell 39.3%; these inventories differ, so that is not a
same-workload speed claim.

The required Actions job now installs root dependencies as well as its existing
MCP dependency preflight, retains source/syntax/manual-release guards, and runs
`/usr/bin/time -v npm test`. Its logs will retain elapsed, user/system CPU and
peak RSS for subsequent remote evaluation. No new upload or artifact storage
is needed. The PR concurrency expression was evaluated for same/different PRs,
pushes, schedules and manual runs. Cancellation savings remain unmeasured.

The Feed release command now explicitly includes `feed-native-build.spec.mjs`
alongside Feed release and candidate-only specs, preserving the previous
inherited native-build checks. Its release runbook matches. The MCP deploy job
is byte-for-byte unchanged (SHA-256
`d460f7b2456ad2fc74356830d67f984cd97260acabbe1fdb0df99f17727fd65e`
for the bytes following the `deploy:` delimiter). These commits form one
integration candidate; the inventory and its workflow consumers land together.

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

## Final validation

- Full final `npm test -- --test-reporter=tap`: **776 passed**, no failed,
  skipped or cancelled cases; 34.63 s wall / 50.72 CPU s. All 772 distinct
  baseline case names remain, plus four inventory/failure/concurrency guards.
  The two four-worker observations span 34.63–37.02 s wall / 50.72–55.75 CPU s.
  These are local observations, not a p50/p90 distribution or a Linux result.
- Existing browser suite: **6 passed**, no skips, 17.90 s invocation wall.
  A temporary config forbids reusing another server and sets this checkout as
  the server working directory. The two optional offline comparison cases were
  enabled with `TSR_REFRESH_EVIDENCE` and cached Leaflet 1.9.4 assets matching
  `public/index.html`. Server environment excluded provider credentials.
- Root/MCP clean installs, source-file checks, feed sync verification and all
  three MCP syntax preflights passed in the rehearsal. `verify_public.mjs`,
  runner syntax and `git diff --check` passed.
- `actionlint` has no new findings. Baseline already contains SC2016 on an
  intentional single-quoted deploy expression; lint with `-ignore SC2016`
  passes. The deploy body containing it was preserved, not rewritten.
- The first final offline rehearsal had one stale metadata workflow assertion
  expecting the removed standalone command. Its assertion now checks the full
  suite gate; the required inventory guard also names that metadata spec. Its
  23 cases and the subsequent complete suite passed. Failed probes and setup
  attempts remain in the local evidence directory.

At the initial local closeout, no workflow had been dispatched, branch pushed,
or release performed; remote gains were unverified. That publication status is
historical and is superseded by the follow-up below. The public runner's $0
cash price does not change. Retain the complete suite if future affected-test
selection lacks a proven dependency boundary.

## PR and remote validation — November 16, 2026

The follow-up user instruction explicitly authorized pushing this branch,
opening a PR and verifying remote CI, and explicitly excluded deployment. That
replaces the earlier local-only publication scope for this branch and
[PR #278](https://github.com/CongressionalInsights/TheSituationRoomAI/pull/278).
No merge or deployment is performed under that instruction.

Current main (`d09c3df`) was merged without conflicts before publication. The
implementation diff remains byte-for-byte identical to the reviewed diff;
upstream supplied 17 additional offline cases. The complete integrated local
suite passed all 793 cases, with no skips.

The first [remote run, 44014226462](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44014226462)
completed successfully on the standard Linux runner at attempt 1. It tested
head `2efb176cca7b29e8be22b4f2c1b68471a620a351` through GitHub merge revision
`927e7fa2536e6c003b5d0de5046fe2fc19d2fe29`. The merge's tree matches the pushed
head's tree, and its parents include that head. Logs prove **793 passed**, zero
failed, skipped or cancelled cases. The GitHub Actions app ID is still 15368
and the required check is still `preflight`. GitGuardian also passed; the
`deploy` job was **skipped**, with no steps executed.

| Remote metric | Historical baseline p50 / p90 (20 runs) | First PR run |
| --- | ---: | ---: |
| Required-check feedback | 54 / 61 s | 57 s |
| Occupied preflight runner time | 51.5 / 59 s | 55 s |
| Queue | 2 / 3 s | 2 s |
| Rounded-up per-job minute proxy | 1 / 1 min | 1 min |

This first observation is 5.6% slower than historical median feedback and
6.8% higher than median occupied runner time, while below both p90 values.
It does **not** establish a remote speedup or compute reduction. The baseline
contains changing revisions and a narrower fixture selection, so this is an
operational comparison, not a paired experiment or a new latency percentile.
One run also cannot establish cancellation savings or a long-run trend.

GNU time measured the full test command at 38.09 s elapsed, 41.26 s user CPU
and 16.55 s system CPU (**57.81 CPU s**), with maximum RSS 794,592 KiB
(about 776 MiB). The old workflow did not record CPU/RSS, so there is no
historical Linux CPU or memory delta to claim. Checkout, setup and installation
remain part of the 55 s job and are not included in that test-command timing.

Standard public-runner compute still costs **$0**. The first run remains one
rounded minute, matching the baseline median; neither a cash saving nor a
material billing-unit reduction is demonstrated. Full offline coverage is
retained despite this tradeoff. The PR description records final-head CI
acceptance after the measurement report is published, without changing any
required checks, permissions, release gates or deployment conditions.
