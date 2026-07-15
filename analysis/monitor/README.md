# Data Monitor

This workspace holds the Situation Room monitoring layer.

## Commands

- `npm run monitor:core` runs the hourly deep-core sentinel.
- `npm run monitor:all` runs the full audit across the entire feed registry.
- `npm run monitor:docs` fetches and diffs official docs/changelog/status surfaces only.
- `npm run monitor:report` rebuilds `latest.md` from `latest.json`.

## Inputs

- Feed registry: `data/feeds.json`
- Monitoring overrides: `data/feed-monitoring.json`
- Live feed proxy base: defaults to `https://situation-room-feed-382918878290.us-central1.run.app`
- Live MCP endpoint: defaults to `https://situation-room-mcp-382918878290.us-central1.run.app/mcp`
- Static snapshot base: defaults to `https://congressionalinsights.github.io/TheSituationRoomAI`

Override endpoints with:

```bash
node analysis/monitor/run_core_sentinel.mjs \
  --base http://127.0.0.1:5173 \
  --mcp https://situation-room-mcp-382918878290.us-central1.run.app/mcp \
  --static https://congressionalinsights.github.io/TheSituationRoomAI
```

Alert deltas use durable, mode-specific baselines outside the checkout:

- `core` and `full` state are stored separately under
  `$XDG_STATE_HOME/the-situation-room-ai/monitor` (or
  `~/.local/state/the-situation-room-ai/monitor` when `XDG_STATE_HOME` is unset).
- Endpoint, docs/static inclusion, and timeout settings are part of a short
  scope id in each filename, so diagnostic runs cannot overwrite production
  comparison state.
- Set `SR_MONITOR_BASELINE_DIR` or pass `--baseline-dir <path>` to override the
  location. Tests and isolated operators should always use an override.
- Baselines are locked and replaced atomically. An older overlapping run cannot
  overwrite a newer-started snapshot or publish stale latest/delta artifacts,
  while an accepted newer run recomputes deltas and document changes against
  the baseline observed inside that same publication lock. One lock and a
  durable publication head beside the baselines serialize core/full and
  diagnostic scopes even when they publish from different worktrees.
  `--no-write` compares against the current baseline without advancing it.
- Supersession has two distinct meanings. Only a newer durable baseline for the
  exact mode and scope makes an observation semantically obsolete; that case
  suppresses its deltas, notification, and critical exit. A newer shared
  publication from another mode or scope may block replacement of `latest.*`,
  but the candidate report keeps its criticals, deltas, notification, and exit
  behavior. Its baseline is not advanced, so the next comparable run can
  surface the unresolved change again.
- Lock ownership is an atomically renamed, non-empty directory whose `owner.json`
  carries a random owner token, PID, hostname, verified process-start evidence,
  and acquisition time. Conclusive same-host evidence reclaims a dead owner or
  reused PID immediately; a live owner with matching or unverifiable start
  evidence is never reclaimed based on age alone. Foreign-host and cache-restored
  owners require stale age because their PID cannot be checked locally. Release
  and reclamation atomically rename the canonical directory to the same retained,
  token-specific retirement path. Its non-empty directory is never deleted, so
  delayed actors for an old generation cannot replace or remove a successor.
  The small retirement directories intentionally trade bounded bytes per lock
  generation for deterministic local-filesystem fencing.
  Baseline directories are supported as host-local state or serialized cache
  snapshots, not as concurrently written cross-host shared filesystems.
- Scope filenames hash the logical endpoint and monitor settings, while
  persisted endpoint descriptors redact credentials in URL userinfo and
  every query value and remove URL fragments. A small allowlist of non-secret
  routing fields (such as `region`, `state`, and `version`) contributes to the
  scope hash without being persisted; query credentials do not. Secret rotation
  therefore preserves comparison continuity while semantic routing changes use
  a separate baseline. Any unrecognized query selector fails closed until the
  caller supplies an explicit non-secret `--scope-tag <identity>` (or
  `SR_MONITOR_SCOPE_TAG`) so a new upstream contract cannot silently collide.
- Legacy `latest.json` files do not record the timeout and inclusion settings
  needed to prove a scope match, so migration is disabled by default. Use
  `--allow-legacy-baseline` only after manually verifying the legacy run's full
  scope. Modern reports are never accepted as legacy migration seeds.
- The hosted daily workflow serializes monitor runs and restores `.monitor-state`
  with the GitHub Actions cache. Only a successful first attempt of the scheduled
  workflow saves the next cache generation; reruns and manual dispatches remain
  cache-read-only so older monitor code cannot replace the scheduled baseline.
  Host-local runs use the state directory above; moving between hosts still
  requires an explicit state copy or the serialized cache handoff used by the
  workflow.

## Outputs

- `analysis/monitor/latest.json`: most recent combined report
- `analysis/monitor/latest.md`: short human-readable summary
- `analysis/monitor/latest-commit.json`: the final publication marker, written
  only after the durable baseline rename; its hashes tie the latest JSON,
  Markdown, history row, and committed baseline to one generation
- `analysis/monitor/history/*.json`: timestamped report history
- `analysis/monitor/doc-watch.json`: standalone docs/status scan output
- durable `core.<scope>.json` / `full.<scope>.json`: compact alert and
  document-hash baselines
- durable `publication-head.json`: the newest accepted generation across modes,
  scopes, and output worktrees
- durable `core.<scope>.publication-pending.json` /
  `full.<scope>.publication-pending.json`: short-lived baseline-adjacent
  recovery journals, normally absent

Generated outputs are intentionally ignored by Git so local and scheduled runs can update them freely.
Latest JSON, Markdown, and history bytes are staged without changing their
canonical paths. The journal records bounded hashes and paths to file-backed
rollback snapshots instead of embedding prior artifacts, then the baseline
commits first. Recovery verifies every needed snapshot before mutation and can
finish publication, restore the prior generation, or fail closed on unknown
bytes. The journal remains in place until its staged and rollback files are
removed, so an interrupted cleanup keeps ownership of every residual byte.
If a retained published journal finds extant canonical outputs restored to their
recorded previous bytes, recovery rolls the durable baseline and publication
head back to that generation or retains the journal when rollback proof is
incomplete. If rollback stops after restoring the shared head but before the
baseline, the verified previous head is treated as rollback progress and the
next recovery resumes safely. A wholly absent old output tree remains cleanup-only.
Deleting an old output worktree does not strand or silently advance durable
comparison state.
`npm run monitor:report` acquires the same publication lock as monitor runs and
updates the Markdown hash in `latest-commit.json`; it refuses to rewrite a
report whose JSON, final marker, and durable baseline no longer match.
