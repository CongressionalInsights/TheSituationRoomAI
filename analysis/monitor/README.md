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

## Outputs

- `analysis/monitor/latest.json`: most recent combined report
- `analysis/monitor/latest.md`: short human-readable summary
- `analysis/monitor/history/*.json`: timestamped history for diffing
- `analysis/monitor/doc-watch.json`: standalone docs/status scan output

Generated outputs are intentionally ignored by Git so local and scheduled runs can update them freely.
