# PR #278: remote bottleneck investigation

Baseline head: `d0fa64729a22d739d308084a93e505f703aca889`. The two completed
Linux PR runs were [44014226462](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44014226462)
and [44014653279](https://github.com/CongressionalInsights/TheSituationRoomAI/actions/runs/44014653279).
They passed all 793 cases, but took 55/61 seconds of occupied runner time and
57/63 seconds to deliver required-check feedback. Historical 20-run medians
were 51.5/54 seconds. Their full-suite command used 57.81/81.77 CPU seconds.

The follow-up authorizes investigating, optimizing and updating this PR, with
remote CI verification. The PR remains open; merging it or deploying is outside
scope. Required checks, production code, release conditions and suite coverage
are preserved.

## Findings and bounded comparison

1. **Repeated payload work and retry waits dominate the monitor spec.** The
   large-response total-byte-limit suite took 15.98/17.31 seconds remotely;
   its nested case times overlap, so they must not be added to the parent.
   The default-event-limit suite took another 7.29/7.40 seconds. Each permanent
   oversized response was constructed, transferred and rejected three times,
   with 500/1,200 ms backoffs. Four smaller error fixtures also each waited
   about 1.7 seconds. The old narrow preflight did not execute this full spec.
2. **Release fixtures repeatedly launch Node twice.** The shell helpers invoke
   a fixture `node` shim, which used to spawn another interpreter for the real
   helper. Across the Feed and native MCP scenarios, that duplicated startup
   adds real CPU and process overhead without changing the CLI contract.
3. **Setup is smaller and variable.** Root dependency installation took 2/5
   seconds, and checkout/setup-node varied across machines. Optimizing caching
   before the tests would miss the larger cost. There is no evidence justifying
   a larger runner or more Actions jobs.

Before changing test harnesses, freeze the two baseline runs, case inventory,
runner and comparison definitions above. Retain every previous result. Compare
the same focused fixture commands before/after, then run the complete suite
and verify fresh Linux PR runs. Success means lower observed feedback and
occupied time with all baseline cases and required gates intact; it does not
mean a guaranteed fleet-wide saving or a fixed latency budget.

## Changes

- Reuse the optimization already merged in
  [PR #277](https://github.com/CongressionalInsights/TheSituationRoomAI/pull/277),
  rather than maintaining a competing retry proof. Its virtual-clock test
  verifies all three attempts, both exact backoffs, final errors and no fourth
  attempt for network, envelope, size and RPC errors. Real HTTP payload tests
  still exercise the original sizes, source/tool exceptions, stale IDs and
  notification envelopes once. Production retry code and deadlines are unchanged.
- Preserve that upstream runner and dependency setup: the MCP and State
  Connector package installs supply the offline tests. The unnecessary root
  frontend-tooling install is omitted. PR #278's compatibility entrypoint now
  delegates to the same discovery/execution functions. Node's default file
  worker count and process isolation remain in use. All existing inventory,
  failure-propagation, concurrency and release checks are retained.
- Execute real Feed/MCP helper modules in the already-fresh fixture shim process
  after setting their normal CLI argv. An import failure remains nonzero, real
  helper main guards and exit behavior still run, and each shell invocation
  keeps its own process/environment. Node-option invocations retain the existing
  subprocess path. All inert cloud executables, scenario mutations, command logs
  and assertions remain. This removes the extra interpreter, not a helper call.
- Retain GNU time around the full suite for Linux CPU/RSS evidence. The MCP
  deployment job is byte-for-byte unchanged from the original PR candidate;
  its SHA-256 after the `deploy:` delimiter remains
  `d460f7b2456ad2fc74356830d67f984cd97260acabbe1fdb0df99f17727fd65e`.

## Local evidence

Node v24.22.1 on the same macOS arm64 host. Commands are sequenced; these are
individual observations, not a latency distribution. CPU is waited child
user+system time. Exact commands, logs and summaries are retained locally under
`analysis/ci-cost-20261116/remote-optimization/`.

| Same focused command | Before | After |
| --- | ---: | ---: |
| Feed + native MCP fixture wall time | 36.49 s | 29.78 s |
| Feed + native MCP fixture CPU | 34.77 s | 31.53 s |
| Cases passed | 41 | 41 |

All 41 fixture case names match exactly. This observed wall reduction is 18.4%
and CPU reduction is 9.3%; the remote result must still qualify the change.
The monitor spec with the reused upstream optimization passed 168 cases in
4.34 seconds locally. This is not a direct cross-platform timing comparison.
A temporary copy of the production client with backoffs mutated to 0/0 failed
the exact virtual-clock retry test, proving that removing wall-clock waits did
not remove timing protection. The production client was not edited.

The complete corrected local suite passed **801 cases**, zero failures/skips,
in 33.08 seconds wall / 43.53 child CPU seconds. All 793 previous PR case names
remain; eight upstream checks were added. The first full integration run caught
a duplicated fixture import introduced by automatic source integration; it was
corrected before publication, and that failed run remains in the evidence.
Workflow validation has no new findings (`actionlint -ignore SC2016` passes;
the pre-existing SC2016 is in the unchanged deploy body). Syntax, whitespace and
both sets of runner/required-check guards pass.

Remote qualification uses the normal PR event followed by one fresh-runner
replication of the same source, preserving attempt-specific logs. Both runs
must execute the full inventory, with no skipped tests or waived checks. Their
observed time/CPU and rounding are compared with both original baselines; no
speed claim is inferred from local timing alone.

The full-suite and remote acceptance evidence is recorded in the PR description
after execution, so the final checked revision does not require another source
change merely to report its own result. Keep failures, cancellations and setup
costs in the comparison. Preserve both the original 20-run historical baseline
and the two slower PR #278 runs; do not substitute a favorable cohort.

Standard public-runner cash cost remains $0. Whole-job runner seconds and the
per-job rounded-minute proxy measure compute; Linux CPU/RSS compare only with
the two instrumented PR #278 runs. The older historical workflow did not record
those process metrics. No cache policy, permissions, secrets, provider, refresh
cadence, required-check identity, merge policy or production deployment changes.
