# Money-flow repair candidate — 2026-11-04

Prepared from deployed source baseline `c51867cb19fd632f637c31ba9d7f887013f4a377` on branch `codex/money-flow-repairs-20261104`. The existing TSR Core Owner remains the owner. This is a finite cloud implementation candidate for Root/Portfolio review, not a production release. No controller, schedule, external store, credential, access policy, or deployment workflow was created or changed.

The owner plan and production identities came from the delegation handoff. The original live request/response audit packet and the current Fusion runtime binding were not available in this workspace. Source-backed fixtures below are not represented as those missing raw observations.

## Implementation

The formerly separate MCP, Feed Proxy, and local-server adapters now use the same money-flow implementation. `gcp/mcp-proxy/money-flows.js` and `money-sources.js` are canonical; `scripts/sync-feeds.mjs` mirrors them and the existing alias data into the independent Feed Proxy deployment directory. `verify_feeds_sync.mjs` fails on drift. Local server imports the canonical implementation directly.

| Source | Change and preserved meaning |
| --- | --- |
| SAM | First page is 0, upstream size is always 10 independently of aggregate limits 10/60/120. Uses public legal-name filtering, registration and core-data sections, bounded paging, exact-query and credential-identity cache keys. Reads `registrationStatus` and `coreData.physicalAddress.stateOrProvinceCode`. Amount is always null and bucket is registry. Current registrations are not awards or historical spending. Access/quota failures stop sibling searches; Retry-After is retained. |
| LDA | Uses `https://lda.gov/api/v1/`. Separate client, registrant, and specific-issues queries implement OR semantics; each is constrained by filing year. LD-203 uses separate registrant, contributor, and payee searches. Validates returned next links against the frozen query and checks identity advance. Deduplicates filing envelopes, then emits each relevant contribution child with its own identity, amount and date. Income and expenses remain distinct fields; selected amount uses reported income when present, otherwise expenses. Amendments remain separate filings, not reconciled net spend. |
| FEC | Separately searches named contributors and reported employers; explicit `C########` committee IDs search contributor and recipient committee roles. Preserves actual donor, employer, recipient committee and IDs without claiming employer donations or inferring PAC affiliation. Uses explicit even-year transaction cycles, descending receipt-date ordering, native `last_indexes` (including null-sort state), and one transient retry of the unchanged request. 400/401/403/429 are not retried. Memo-marked receipts retain their amount but are excluded from subtotal arithmetic. |
| USAspending | Follows `page_metadata.next` with a fixed date window/order. Requests `Mod`, generated award ID, action type and recipient UEI. Distinct modifications have distinct IDs and remain transactions, not award totals. Prefers native transaction identity when present; otherwise exposes `identityBasis: award_modification_action_composite`. Links use generated award IDs. Transaction obligation, loan value and subsidy cost remain separate. Null, zero, negative obligations/deobligations survive. |

Per provider: at most 12 HTTP attempts, 3 pages per search, a 45-second acquisition deadline, and a 15-second request timeout. LDA shares one budget across its two endpoints and spaces requests 4.1 seconds apart within a call. Other provider searches run independently; one failed source does not discard successful sources. These are per-call bounds, not a new cross-instance quota controller. Source quotas and concurrent callers can still reduce coverage.

## Caller contract and presentation

`schemaVersion: 2` deliberately changes financial interpretation:

- `amount`, summary amounts and top-entity amounts are nullable. An actual zero remains zero. Buckets expose known/unknown amount counts; missing amounts never become zero. SAM has no monetary subtotal.
- `coverage.status` is always `discovery_sample` at aggregate level, with `complete:false`, matched/returned counts and output/query-variant truncation. Summaries have `basis: returned_rows_only`. Exhausted individual queries do not establish global entity coverage.
- Each source reports coverage status, reasons, searches/pages/requests and cached searches. `count` is acquired rows before deduplication/matching; `returnedCount` is the displayed normalized rows. LD-203 acquired rows are filing envelopes; returned rows are children.
- LDA selection is by whole filing year; contribution dates are filtered where known. Unknown dates are preserved. SAM is a current registration snapshot. Neither is silently claimed to meet the exact receipt/transaction date window.
- MCP input names and retrieval annotations are unchanged. Its description/text now state sampling and financial limitations. The metadata test fingerprint changes for that intentional description change only; the pinned metadata-only deployment exception is unchanged.
- Feed/local paths now share MCP alias matching and a maximum of 120 results (Feed Proxy previously allowed 200). They accept the same optional matching controls. Callers must consume truncation/coverage metadata, not assume the requested count was retrieved.
- The UI shows sampling and unavailable sources even for zero returned rows, labels transaction obligations, displays `$0` and negative amounts correctly, separates unknown values, and displays SAM registration counts instead of dollars. Its request timeout is 60 seconds, above the bounded acquisition deadline. Frontend artifacts were rebuilt.

## Existing audit coverage

The existing full audit now makes exactly one narrow `money.flows` call (`CVS Health`, current calendar year, limit 10), with aggregate-call retries disabled. It records source coverage and checks identity, numeric, registration and transaction semantics. Acquisition/contract failures are warnings; honest budget-limited coverage is informational. It does not claim a complete ledger or backfill. Core/hourly and docs-only audit behavior and schedules are unchanged. The four underlying adapters are not falsely inserted as ordinary `/api/feed` registry entries.

The normal full audit was exercised with inert transport fixtures; no broad live audit/provider sweep was run. No prior `analysis/monitor/latest.json` or `.md` existed in this checkout. JSON and Markdown now carry the money-flow result alongside the normal feed audit.

## Verification and remaining release work

- Dedicated fixture suite: 13 passing tests, covering limits, paging, later-page matches, OR filters, child attribution, duplicate pages, changed-query links, cache identity, access/quota errors, exact FEC cursors/cycles/retries, employer attribution, modification collisions, partial-result retention, numeric semantics, and the full-audit integration.
- Focused browser fixture: passes using installed `/usr/bin/chromium`, with all provider traffic mocked/blocked. Confirms zero, negative, unknown, and registration rendering. The default Playwright browser was absent and its download returned HTTP 403 `Domain forbidden`; the installed system browser supplied the supported local alternative. The broader unrelated UI suite was not rerun against live providers.
- `npm test`: 461 passed, 0 failed. Frontend build, feed/module parity, public-file validation and `git diff --check` passed; results are recorded in the delivered verification logs. One intermediate suite run caught the intentionally changed MCP description fingerprint; the expected reviewed declaration hash was updated, preserving annotation assertions.

Production remains at the supplied baseline. Neither `DATA_GOV` nor `SAMGOV_API_KEY` is set in this execution environment. Authenticated live SAM/FEC validation and candidate-to-canonical parity are therefore pending in an authorized release environment; this is an access prerequisite, not a denied deployment or an uncertain mutation. No credential or access change was attempted. No provider recovery is inferred from fixture success.

Before promotion, obtain applicable release confirmation for this exact reviewed source, preserve captured serving revision/secret bindings/rollback, and use the repository's existing Feed and MCP candidate/typed-series gates. Verify a narrow, frozen query/window on the candidate and canonical surfaces: SAM legal-name registration pages (limits 10/60/120), current filtered LDA next-page/child identities, a previously failing FEC query with its explicit cycle and native cursor, and USAspending generated award/modification/obligation identity. Retain sanitized request/response evidence. Do not recreate the missing audit with a broad query burst. A source outage must remain an outage, not a fabricated zero.

The USAspending composite identity is a conservative fallback: indistinguishable rows without a native transaction ID can still collide. FEC amendments, memo records and cross-source overlapping reports are not reconciled into a net ledger; the response labels sample subtotals accordingly. Named PAC affiliation resolution is not automated; explicit committee IDs retain their verified role.

Keep the existing Fusion limit-20/direct-source workarounds until deployed behavior has independently passed those checks. Do not blanket-backfill older gaps. Recover only question-relevant unfinished windows through Fusion's existing frozen-window/cursor or overlap/dedup process, recording later acquisition as later knowledge. The Federal Register historical portion already reported as retrieved does not need a repeat for this repair.

## Official contracts reviewed

- [SAM Entity Management API](https://open.gsa.gov/api/entity-api/): page zero, ten-record limit, public registration/core schema, legal-name filtering and response links.
- [LDA API documentation](https://lda.gov/api/redoc/v1/) and [current filings endpoint](https://lda.gov/api/v1/filings/): query filters, 25-row pages, next links and filing/child schema. Some direct documentation fetches from this environment returned 403; indexed official documentation and the owner handoff supplied the documented fields. No alternate access policy was installed.
- [FEC documentation](https://api.open.fec.gov/developers/), [official Schedule A implementation](https://github.com/fecgov/openFEC/blob/develop/webservices/resources/sched_a.py), and [official parameter definitions](https://github.com/fecgov/openFEC/blob/develop/webservices/args.py): cycles, contributor/employer/committee roles, keyset sorting and cursors.
- [USAspending transaction search contract](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/api_contracts/contracts/v2/search/spending_by_transaction.md) and [official field mapping](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/awards/v2/lookups/elasticsearch_lookups.py): pagination, generated award IDs, modification fields, and `Transaction Amount` mapped to `federal_action_obligation`, distinct from loan value/subsidy cost.
