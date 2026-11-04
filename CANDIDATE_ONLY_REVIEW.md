# Candidate-only source preparation for PR #248

This follow-up to functional repair head `20fd9d4ed152f673b87bcb7fcf41b3b179d355e8` prepares the existing release paths for a finite isolated candidate review. It does not authorize or perform a protected merge, workflow dispatch, GCP operation, provider acquisition, promotion, IAM/credential change, or PR approval. Root remains the owner communicator. All prior repair receipts in `MONEY_FLOW_REPAIRS.md` remain applicable to that earlier head.

## Execution remains blocked on main

Both existing workflows retain `workflow_dispatch` on `refs/heads/main`, exact full 40-character `expected_sha`, and checkout SHA equality before authentication. MCP repeats the binding in its deploy job before authentication. There is no feature-branch/PR exception. The current draft branch cannot execute this path; a separately authorized protected merge and an exact reviewed merged SHA are prerequisites. No dispatch was attempted.

The new required `candidate_only` boolean defaults to true. Explicit false selects the existing full-release behavior. Candidate-only rejects secret synchronization and MCP CISA-only/metadata-only shortcuts before authentication, so the normal provider and typed-series candidate gates still apply. The historical metadata-only SHA exception is unchanged. Feed continues to reject secret synchronization in either mode, and its helper independently requires the main ref, full reviewed SHA, explicit mode and `sync_secret_versions:false` before any cloud command.

## Candidate-only boundaries

- MCP source deployment omits the full-release IAM grant flag and all public configuration/minimum/timeout update flags. It inherits configuration, verifies the existing zero revision minimum prerequisite, retains existing secret-binding checks, and compares captured/current service policy, template configuration and traffic before candidate checks. Google documents `--allow-unauthenticated` as an IAM-affecting option; neither it nor its disabling counterpart is passed in candidate-only mode. No IAM mutation command is added.
- Feed retains its source manifest, exact revision/image/build provenance, configuration/secret, identity and content checks. Its candidate-only exit is after those checks and before promotion. No canonical identity/content check or post-release Feed sentinel runs in this mode.
- MCP promotion, canonical release verification and rollback mutations are excluded in candidate-only mode. Its normal isolated provider/core/typed-series checks remain mandatory and distinct from the bounded feature observation below.
- Both cleanup paths check captured desired/observed 100% traffic, unchanged configuration, existing tags and ownership of the temporary tag. Only this run's `gha-<run>-<attempt>` tag can be removed. No old serving tag or revision is removed; drift fails closed without traffic repair. Success and verification failure both use this guarded cleanup. Full-release rollback, canonical parity and old-tag retirement behavior are retained when full release is explicitly selected.
- Existing diagnostic artifact paths remain in use. Candidate-only adds sanitized money observations and final state receipts there. No new controller, workflow, schedule, credential or checkpoint store exists.

## Proposed finite feature observation

`scripts/verify_money_candidate.mjs` is read-only and accepts only an isolated `gha-...---situation-room-{mcp,feed}-...run.app` origin. It uses the existing `/mcp` `money.flows` or `/api/money-flows` route, with the fixed entity `CVS Health`, window `2026-01-01` through `2026-11-03`, and `limit:120`.

Per candidate it makes one aggregate request, followed by at most three LDA page requests. There are no aggregate retries, fallback endpoints or live checks during source preparation. The continuation query/window/entity/mode is checked before use. Requests are spaced at least 4.1 seconds apart; Retry-After is retained, provider errors stop traversal, and delays over 55 seconds are deferred rather than retried. Reports retain source counts, coverage, sanitized error codes and hashed identities; raw provider responses, URLs, cursors and arbitrary error messages are not exported. Reports explicitly remain incomplete, even if the small LDA traversal happens to finish.

This is a proposed verification allowance, **not a product acquisition cap**. Standard candidate gates are additional. The verifier does not establish source-wide completeness, original historical knowledge, or provider recovery. It has not been run against a live endpoint.

## Inert evidence

- Standard suite: 509 passed, 0 failed, including candidate-only guard, actual shell-command/cleanup, bounded feature-request and existing metadata/monitor tests.
- Focused release suite: 62 passed, 0 failed, covering candidate-only success/content-failure/feature-failure, preserved full-release success/rollback, metadata-only pins, CISA, Feed provenance and BLS acquisition fixtures.
- Tests execute the actual workflow shell blocks and Feed helper with inert cloud/HTTP substitutes. They reject wrong refs, short/mismatched SHAs, secret sync, specialized bypasses, foreign tags, changed traffic and configuration; candidate-only traces contain no promotion, rollback, secret-sync or IAM mutations.
- Existing metadata shell fixtures now drain stubbed pipeline input to eliminate a fixture-only SIGPIPE race while retaining `pipefail` and all release assertions.
- Workflow YAML parsing, shell/JavaScript syntax, feed/module parity, public assets and `git diff --check` passed. Local fixture transport required the execution environment's network permission; no live provider or GCP request was made.

Official CLI reference: [gcloud run deploy](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy). `--no-traffic` isolates the new revision; candidate tagging supports direct smoke checks. These mechanics do not bypass the repository's release authorization or main-only guard.

## Owner P2: financial evidence in the bounded observation

The envelope-only verifier at preparation head `72c5a637fdb522c75a4a70760aade4564e961c11` accepted SAM registration dollars and rows without usable identity/numeric evidence. The two regression tests failed against that implementation; their failed receipt is preserved in `/workspace/tsr-repair-evidence/candidate-money-before.log` alongside all prior preparation receipts.

The correction validates each normalized row before another request is allowed. It rejects missing or duplicate source/sourceId identities (including equivalent numeric/string or whitespace identities), malformed amounts, incompatible source/type/bucket combinations, missing numeric or attribution fields, and inconsistent source returned counts. Unavailable and unrequested sources cannot claim returned rows. Financial evidence is source-specific:

- LDA filings retain income, expenses, their selected amount basis, hashed client/registrant attribution, and filing/amendment evidence. LD-203 children retain hashed parent/child lineage and donor/payee roles. Their `reported_contribution` basis is explicitly derived from the normalized type because schema 2 does not expose an amountBasis field for these children.
- FEC receipts retain contributor/employer/recipient roles, hashed party and committee identities, transaction cycle, memo exclusion and subtotal participation. An employer match remains an affiliation; it does not become the donor.
- USAspending retains transaction-obligation basis, loan/subsidy numeric evidence separately, identity method, and hashed award/modification/action/recipient lineage. An award total cannot masquerade as a transaction obligation.
- SAM requires null amount, registry type/bucket, current-registration date basis, and hashed registration/legal-entity identity. It cannot contribute spending dollars.

Each numeric field explicitly distinguishes known values (including zero and negatives), unknown null, and invalid input. Optional normalized attribution/lineage fields preserve explicit unknowns; omitted required fields fail. Receipts contain only fixed labels, numeric values, booleans, sanitized coverage codes and hashes, with no raw party names, provider URLs/cursors, payload details, credentials or arbitrary error text. There is no invented financial zero for unavailable sources and no combined dollar total. Identities are stable across calls for deduplication; the aggregate and LDA traversal can overlap, so receipts must not simply be summed across calls. Validation covers returned-row interpretation, not independently reconciled source records or a net ledger.

The focused inert fixtures cover both original probes, each source's missing evidence, malformed amounts, normalized duplicate identities, valid null/zero/negative values, memo exclusions, unavailable sources, redaction, a later-page contract failure, and actual production-normalizer output from injected provider fixtures. The fixed request, one-plus-three allowance, pacing/Retry-After, no-retry/fallback behavior, candidate guards, and both release paths are unchanged. This correction makes no live acquisition and establishes no provider recovery or historical completeness.

Correction checks: `npm test` passed 515 tests; the focused candidate/Feed/metadata/CISA/BLS release suite passed 68 tests, including 12 candidate-only tests. JavaScript syntax, public-file validation and `git diff --check` passed. Final logs are `/workspace/tsr-repair-evidence/candidate-money-npm-final.log` and `candidate-money-release-final.log`; the earlier failing baseline and intermediate attempts remain alongside them. Only this verifier, its existing test file and this review note changed.
