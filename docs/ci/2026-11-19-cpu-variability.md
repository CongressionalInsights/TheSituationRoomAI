# Hosted CPU variability and fixture startup

Base: `56b2cd80a84b890add40b170f778dbcb4794316f` (PR #278 merged).
Scope: offline CI and its fixture harness; no merge, release, credentials,
permissions, provider calls or required-check changes.

## Why the two identical trees used different CPU

The [refreshed PR run](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44662695983)
and [merged-main run](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44663394847)
executed the same tree, 832 tests and three file workers on Node 24.22.2.
They ran on different hosts and image builds:

| Observation | PR | Main |
| --- | ---: | ---: |
| Cloud / region | AWS / us-west-2 | Azure / eastus |
| Ubuntu 26.04 image build | 20261111.82.6 | 20261111.196.1 |
| Timed suite wall | 21.20 s | 29.99 s |
| Timed suite user + system CPU | 35.89 + 12.31 s | 47.71 + 20.73 s |
| Minor page faults | 6,223,697 | 6,225,332 |
| Involuntary context switches | 14,499 | 20,327 |
| Occupied runner / feedback | 40 / 43 s | 39 / 41 s |

Across 92 case names taking more than 30 ms in the PR run, the median main/PR
duration ratio is 1.412. The broad slowdown, nearly identical page faults and
identical source are evidence against a new code regression or duplicated suite.
Host performance is the leading explanation; CPU model, frequency and contention
were not captured, so the cloud/image observation does not establish causation.
Faster checkout/setup on main masked the slower suite in whole-job feedback.

[GitHub documents automatic AWS/Azure scheduling](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners#cloud-hosts-used-by-github-hosted-runners)
for eligible standard Linux jobs. An OS label does not select a cloud or CPU
model. Keep the existing standard runner. Record CPU model, parallelism, runtime,
memory and image build in the existing preflight, without dumping environment
variables or adding a gate. No paid or self-hosted runner is justified here.

## Biggest remaining avoidable work

The 21 actual Feed release scenarios are the largest sequential fixture group:
19.71 / 27.83 seconds of case time in the two runs. Cases in different files can
overlap; do not add these totals to wall time or to enclosing tests.

A temporary Node exit probe on the unchanged local release command recorded
731 Node exits, including **395 fake `gcloud` startups consuming 12.42 CPU
seconds**. This counts processes inheriting the probe, not an exhaustive OS
process trace; some MCP fixture environments intentionally discard Node options.
The full release command consumed 31.01 CPU seconds / 33.66 s wall with the probe.
These fake CLI startups exercise no production JavaScript; their repeated
interpreter startup is avoidable even while the real shell helper still runs.

Reuse the exact `fakeCloud` function in one private worker/socket per scenario.
A small shell shim sends NUL-framed argv and the four environment fields read by
that function over a Unix socket with the existing system curl. It preserves
unset versus empty values, stdout/stderr bytes and numeric exit status. Curl
configuration and proxy lookup are disabled; transport failure is nonzero, with
no fallback to a real executable or cloud endpoint. The worker is terminated and
its owned temporary files removed at test cleanup. No daemon survives the test.

The implementation of `fakeCloud`, all 21 scenarios, state/provenance mutations,
cloud command logs and assertions are unchanged. Real release scripts and all
real verifier CLI processes still execute normally. Three independent adapter
tests cover argument framing, live exports, stream/status preservation, explicit
exit, exceptions, per-call exit reset, and stopped-server failure. The production
deploy job body is byte-identical to the base, as are runtime application files.

## Local qualification

Node 24.22.1 / macOS arm64, sequential before/after observations on one host:

| Command | Baseline | Candidate |
| --- | ---: | ---: |
| Release pair with exit probe: wall | 33.66 s | 23.61 s |
| Release pair with exit probe: CPU | 31.01 s | 22.55 s |
| Same release cases passed | 41 | 41 |
| Full `npm test`, no probe: wall | 31.69 s | 26.42 s |
| Full `npm test`, no probe: CPU | 43.67 s | 36.79 s |
| Full cases passed, zero failures/skips | 832 | 835 |

The full-suite observation is 16.6% lower wall time and 15.7% lower CPU with all
previous case names retained plus three adapter checks. This is a small local
comparison, not a guaranteed remote saving. The probe adds overhead, so keep
instrumented and uninstrumented measurements separate. Source, case-name,
fixture-function and deploy-body fingerprints, complete logs and raw process
observations remain in the ignored `analysis/ci-cpu-20261119/` audit directory.

Review found that a valid long `TMPDIR` can exceed the Unix socket address
limit. The final adapter keeps its owned private socket directory under `/tmp`;
other fixture data still honors `TMPDIR`. A fourth adapter check executes with
a real temporary path longer than 121 bytes. A temporary copy restoring the old
socket location fails that check with `Unix socket path too long`; tracked
source is untouched by this mutation proof. The final full suite passed **836
cases**, zero failures/skips, in **25.47 s wall / 36.56 s CPU**. Keep the earlier
835-case observation above as history. The initial advisory transcript produced
this accepted finding, but its receipt is `execution_failed` after a blocked
reviewer cleanup command; it is not clean acceptance. One changed-target
verification closes the review budget, with its result retained in the PR and
local review-chain receipt.

Remote acceptance uses the normal PR event and one predeclared fresh-runner
replication of the exact same head. Both must pass the full inventory, preserve
required `preflight` from Actions app 15368, and skip deployment. Retain both
attempts, hardware/image metadata, test-command CPU, RSS, occupied time, queue,
feedback and per-job rounded-minute proxy. Compare with both immediate base
runs and the original 20-job baseline (51.5 s occupied / 54 s feedback medians),
without comparing different hosts as a controlled experiment. Attempt-specific
results belong in the PR description so reporting them does not invalidate the
checked source. Public standard-runner cash cost remains $0.

## Lower-priority opportunities

- Large real HTTP/SSE fixtures still matter: the total-byte-limit parent took
  5.41 / 5.83 s. The monitor client repeatedly scans its growing event buffer for
  a delimiter; incremental scanning merits a separate runtime performance study
  with CRLF, split delimiter, UTF-8, cancellation and byte-cap regression proof.
  Do not shrink payloads, skip real transport cases or alter that parser in this
  fixture-only change.
- Package installation was only a few seconds. More caches or sharding would
  add maintenance/setup cost before addressing the larger fixture work.
- Raising file concurrency can reduce wall time while increasing CPU and RSS.
  Keep three workers on the existing hosted runner and the four-worker ceiling;
  this change removes interpreter work without trading coverage for parallelism.
