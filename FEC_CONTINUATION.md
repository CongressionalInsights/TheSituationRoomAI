# FEC continuation: local candidate

Base: `965582e66e1a39dd00198670ed43f625079946f8`. This branch is independent of frozen LD-203 PR #250 (`65322931834bc63fe95a0795bc638ef29e5bdf3a`); that repair is not included or changed here. Integrating both requires their ordinary review/merge process and parity checks.

## API and acquisition contract

`money.flows` accepts `mode: "fec_pages"` and an optional `cursor`. Feed/local `/api/money-flows` forwards the same fields (HTTP uses `q` for `query`). Start with explicit entity, dates and matching options; retain the returned rows and use the exact `fecTraversal.next` arguments for each subsequent call. `limit` is ignored in this mode. `fecTraversal.complete:true` with `next:null` means all frozen cycle/alias/filter searches reached empty terminal pages, not a historical snapshot or reconciled ledger.

The separate version-1 cursor binds normalized query/alias expansion, dates, matching and fixed Schedule A ordering. It carries current cycle/filter plan position, native `last_indexes`, unfinished-page state, preceding page identity hash, cross-call pacing, Retry-After, and loop-guard state. URLs, API keys and credentials are reconstructed server-side, never encoded. Malformed or mismatched cursors fail before any provider request. The 4096-character envelope and scalar shape checks bound one cursor's size; cursor size does not grow with traversal length. There is no total traversal page/search cap.

Every call retains the existing 12-attempt, three-pages-per-search, 45-second source-deadline, 15-second request-timeout, 150ms pacing and one bounded transient retry of the frozen request. When an unfinished search reaches its page allowance, the next call resumes it instead of skipping to the next filter. An empty terminal page advances the plan. Budget/deadline stops preserve parsed rows and the next unfinished request; transport/HTTP failure preserves the failed request. Retry-After survives serialization and early resume issues no provider request. Aggregate samples always offer a traversal entrypoint at the beginning (including cooldown), since sampled-out records cannot be acknowledged by sample acquisition progress. Existing sample/LDA behavior is otherwise preserved.

## Guard and financial tradeoffs

Fetched rows are retained before no-progress or invalid-pagination guards. Exact within-call identity/cursor guards remain; preceding page identity hashes and a constant-space Brent cycle detector survive serialization. A nonadjacent cross-call cycle may take more than one bounded batch to detect, unlike retaining every visited cursor forever. Detection blocks the continuation with `requiresRestart:true`; it does not skip a search or report completion. Reusing a halted cursor issues no requests. A caller must reconcile and explicitly restart an appropriate overlapping window; no new total cap or automatic guard bypass is introduced. A mutable provider can still change records between requests, and an older replayed cursor is intentionally replayable rather than an operational acknowledgment.

The batch returns every matched normalized observation, without ranked slicing. Exact duplicate raw observations are collapsed using a canonical `observationHash`. Different observed versions sharing a native `sourceId` remain visible with file/transaction/original-sub-ID lineage where supplied. First matching observed identity values alone enter a batch subtotal; later versions have `duplicateIdentity:true` and `includeInSubtotal:false`. Memo exclusions remain in force. Amount null/zero/negative values remain distinct. Subtotals cannot be summed across calls without identity/version reconciliation. Unknown native identity is not fabricated. These additions apply to FEC traversal rows, not existing research storage schemas.

## Collector and deployment boundary

The collector is existing Fusion automation `6ae93d291fd08191b3188d1c50706c83`. Its recoverable run history is best-effort, not a durable checkpoint or crash-safe operational acknowledgment. Resume only from recovered matching request/progress. If unavailable, restart a known bounded overlapping window and deduplicate source identity/version/hash; retain explicit unknown historical gaps. Research append/readback proves accepted research only. No new store, checkpoint evidence row, research schema or automation is created or changed here.

The exposed installed Situation Room connector schema in this worker still accepts only query/start/end/limit. The owner reports both installed connector schemas omit mode/cursor; only one is exposed for direct inspection here. Server MCP schema/metadata changes do not establish Fusion connector access. No installed integration was updated. Hosted caller transport timeout is unverified; browser/audit/source timeouts are not substitutes and have not been tuned.

The normal audit still makes one aggregate call and now inspects its FEC restart entrypoint. The money candidate verifier retains its existing one aggregate plus at most three LDA-page live allowance, with no added FEC calls. Source implementation and verification are fixture-only; no live provider access, deployment, publication or recovery claim is part of this candidate. LD-203 replay remains blocked: retained parent hashes/diagnostics do not contain raw children, and the prior environment restriction is not retried.

## Official source grounding

Read-only inspection of official OpenFEC source confirms Schedule A `sub_id` identity, date ordering, contributor/employer/committee filters, even-year transaction-period inputs and native seek semantics:

- [Schedule A view](https://github.com/fecgov/openFEC/blob/develop/webservices/resources/sched_a.py), observed blob `3d3522f509f98a2f63e1e24f299ad636a432c46a`.
- [ItemizedResource](https://github.com/fecgov/openFEC/blob/develop/webservices/common/views.py), observed blob `28ceab1b428083e8f33b314d9a152450cb27611f`: both last-index and sort value (or null-sort state) are required.
- [SeekCoalescePaginator](https://github.com/fecgov/openFEC/blob/develop/webservices/utils.py), observed blob `6fa9773a80d584026bf2702c1533f298bbc355e9`: native last-index serialization and explicit null-sort state.
- [Argument definitions](https://github.com/fecgov/openFEC/blob/develop/webservices/args.py), observed blob `c847ee27549005c09d8ad78da34e2625fc63f5e0`.

Provider source inspection is not a live acquisition or proof of deployed provider behavior. Production Node24.22.1 fixture receipts and independent exact-commit review are supplied separately with this local candidate.
