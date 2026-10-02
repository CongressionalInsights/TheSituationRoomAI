# ACLED Discovery Probes

Aggregate discovery selects a window only after its date-only probe returns a
matching row. Each window starts at `cursor=0`; an empty page with a valid
`next_cursor` continues that same query. Only explicit `next_cursor: null`
confirms an empty window. Missing, malformed, or repeated cursors fail closed.

Discovery shares a 24-request budget across windows and cursor continuations.
Unresolved exhaustion returns HTTP 502 with `pagination.stage: "probe"` and
`reason: "probe_request_limit"`. Its cursor is provenance only, not a lossless
resume instruction; no aggregate result is cached or yearly fallback selected.
If all 24 nearby windows are confirmed terminal-empty, the existing yearly
fallback still applies. The separate six-request harvest budget is unchanged.

Run the inert regression suite with Node 24:

```sh
node --test scripts/test/acled-pagination.spec.mjs
```

The suite extracts source functions into a VM with mocked JSON responses; it
does not initialize provider clients or make provider requests.
