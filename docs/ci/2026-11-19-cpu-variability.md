# Hosted CPU variability and a rejected fixture optimization

Base: `56b2cd80a84b890add40b170f778dbcb4794316f` (PR #278 merged).
The resulting change only records bounded CPU/runtime/image metadata in the
existing preflight. Test/runtime source, fixture harnesses, dependency installs,
worker counts, release gates and required checks remain unchanged. No merge or
deployment is part of this task.

## The host is the leading explanation for CPU variation

The [refreshed PR #278 run](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44662695983)
and [merged-main run](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44663394847)
executed identical trees, 832 cases and three file workers on Node 24.22.2:

| Observation | PR | Main |
| --- | ---: | ---: |
| Cloud / region | AWS / us-west-2 | Azure / eastus |
| Ubuntu 26.04 image build | 20261111.82.6 | 20261111.196.1 |
| Timed suite wall | 21.20 s | 29.99 s |
| Timed suite user + system CPU | 35.89 + 12.31 s | 47.71 + 20.73 s |
| Minor page faults | 6,223,697 | 6,225,332 |
| Involuntary context switches | 14,499 | 20,327 |
| Occupied runner / feedback | 40 / 43 s | 39 / 41 s |

Across 92 case names above 30 ms in the PR, the median main/PR duration ratio
is 1.412. Nearly identical page faults, identical source and a broad slowdown
argue against duplicate cases or a new code regression. Faster setup on main
masked the slower test command in whole-job feedback. CPU model, frequency and
contention were not captured; cloud/image causation is unproven.

The experiment below also captured different CPUs within Azure on the same
image: EPYC 7763 versus EPYC 9V74, with 65.65 versus 49.57 CPU seconds on the
unchanged experimental head. This reinforces host performance as the leading
explanation without isolating its components.
[GitHub documents automatic AWS/Azure scheduling](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners#cloud-hosts-used-by-github-hosted-runners).
An OS label does not select a CPU or cloud. Keep the standard runner and log
CPU model, parallelism, Node/V8, memory and image build without dumping the
environment. This is diagnosis, not a speedup or a reason to buy runners.

## Fixture startup: promising locally, insufficient remote evidence

The 21 actual Feed release scenarios took 19.71 / 27.83 s of case time in the
base jobs. Cases in different files overlap; do not add these to suite wall.
A temporary local Node exit probe recorded 731 Node exits, including **395
fake `gcloud` startups using 12.42 CPU seconds**. Some MCP fixture environments
discard Node options, so this is not an exhaustive OS trace.

An adapter reused the unchanged fake-cloud implementation in a private server
while keeping every real helper/verifier CLI, scenario, mutation and assertion.
The release pair with the probe fell from 33.66 s wall / 31.01 s CPU to 23.61 /
22.55 s. An uninstrumented full-suite pair fell from 31.69 / 43.67 s to 26.42 /
36.79 s, retaining all 832 cases plus three new adapter checks.

Advisory review found successive actual portability regressions: long `TMPDIR`
paths exceeded Unix socket limits, then a short global `/tmp` path failed when
only `TMPDIR` was writable. A relative socket in an owned subprocess cwd passed
both native sandbox reproductions, but its full suite used **30.70 s wall /
42.76 s CPU**, erasing most of the local gain.

Two declared remote prototype attempts at `02c185bee4733443856186e2b9915de18e0090dc`
passed all 836 cases with zero skips and skipped deployment:

| Metric | [Attempt 1](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44665629309/attempts/1) | [Attempt 2](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44665629309/attempts/2) |
| --- | ---: | ---: |
| Azure region / EPYC model | westus2 / 7763 | eastus2 / 9V74 |
| Runner / feedback | 42 / 44 s | 29 / 32 s |
| Test CPU / wall | 65.65 / 26.41 s | 49.57 / 21.50 s |
| Peak RSS, KiB | 821,580 | 1,061,696 |

The pair used 71 runner seconds / 115.22 test CPU seconds, versus 79 / 116.64
for the immediate base pair: only 1.2% less CPU. Host models/regions differ and
the base lacked CPU models. This is observational, not controlled attribution;
RSS does not prove memory savings. Each job rounds to one minute. Public
standard-runner cash cost remains $0. The original 20-job baseline medians remain
51.5 s occupied / 54 s feedback; that narrower suite did not record CPU.

**Decision: remove the adapter and retain the original fixture harness.**
The measured result does not justify its portability and maintenance cost.
The advisory budget is closed: initial receipt `execution_failed` after a blocked
reviewer cleanup, verification `findings`. Both accepted findings are resolved
by removing the socket dependency; no third model pass is used. The retained
diagnostic code is identical to the reviewed code. All 832 baseline case names,
source equality and fresh full-suite PR CI qualify the reduced change. Exact
final CI results are recorded in the PR description to keep the source stable.
Logs, sandbox/mutation proofs and review receipts remain in the ignored
`analysis/ci-cpu-20261119/` audit directory. Published adapter prototypes remain
in git history; the portable subprocess variant's patch is in the task transcript.

## Next opportunities, in order

1. **Profile large SSE reads.** The total-byte-limit parent still took 5.41 /
   5.83 s in the base runs. `readMatchingMcpEvent` repeatedly scans its growing
   buffer for a delimiter. An incremental scan merits a separate runtime
   benchmark with CRLF, split delimiter, UTF-8, cancellation and byte/event-cap
   proof. Preserve real payload sizes and HTTP transport cases.
2. **Revisit fixture startup only with a simpler portable mechanism and a
   same-host A/B measurement.** Do not promote this rejected adapter based on
   its fastest local result or a favorable hosted run.
3. **Leave installation and scheduling alone.** Installation took only a few
   seconds. Caches/shards add setup and maintenance; more workers may exchange
   wall time for CPU/RSS. Keep full discovery and the hosted three-worker policy
   with its four-worker ceiling.
