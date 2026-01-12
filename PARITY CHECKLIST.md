# Parity Checklist

Status notes:
- Local verified via Playwright on `http://127.0.0.1:5173` (2026-01-12). Core flows render and `/api/*` endpoints respond; missing EIA env yields the expected energy-map warning.
- Live currently fails `/api/*` with JSON parse errors because `apiBase` is unset and the proxy is not deployed yet. Update `public/config.js` + deploy the Worker, then re-verify.

## Top bar + global controls
- [ ] Export Snapshot — downloads JSON and posts snapshot to server — Local: OK — Live: Pending verification (proxy required)
- [ ] Refresh Now — forces feed refresh + panel update badges — Local: OK — Live: Pending verification (proxy required)
- [ ] About (top bar) — opens About overlay and closes on click/escape — Local: OK — Live: OK (client-only)
- [ ] Scope toggle (Global/US/Local) — filters feeds + map signals — Local: OK — Live: Pending verification (proxy required)
- [ ] Window toggle (24h/7d/30d) — filters items by age — Local: OK — Live: Pending verification (proxy required)
- [ ] Settings open/close — panel slides in/out — Local: OK — Live: OK (client-only)

## Command Center (search + AI)
- [ ] Feed scope dropdown — shows categories + feeds; selection updates search scope — Local: OK — Live: Pending verification (proxy required)
- [ ] Search input + Enter key — shows results panel — Local: OK — Live: Pending verification (proxy required)
- [ ] Search button — same as Enter — Local: OK — Live: Pending verification (proxy required)
- [ ] Saved search chips — inject query and run search — Local: OK — Live: Pending verification (proxy required)
- [ ] Briefing button — runs analysis (OpenAI if key; heuristic fallback) — Local: OK — Live: Pending verification (proxy required)
- [ ] Chat send — sends prompt to assistant — Local: OK — Live: Pending verification (proxy required)

## Map + geo layer
- [ ] Map loads + renders points — Local: OK — Live: Pending verification (proxy required)
- [ ] Locate Me — updates location + local scope — Local: OK — Live: Pending verification (proxy required)
- [ ] Map legend toggle — opens/closes + filters layers — Local: OK — Live: OK (client-only)
- [ ] Map tooltip + click detail — shows detail drawer — Local: OK — Live: Pending verification (proxy required)
- [ ] Travel ticker toggle — show/hide ticker — Local: OK — Live: Pending verification (proxy required)

## Panels
- [ ] News Layer — clusters + sort toggle — Local: OK — Live: Pending verification (proxy required)
- [ ] Finance & Policy tabs — switch Markets/Regulatory — Local: OK — Live: Pending verification (proxy required)
- [ ] Crypto panel — loads market heat — Local: OK — Live: Pending verification (proxy required)
- [ ] Hazards & Weather — loads alerts — Local: OK — Live: Pending verification (proxy required)
- [ ] Local Lens — shows radius-filtered items — Local: OK — Live: Pending verification (proxy required)
- [ ] Policy & Government — loads disclosures — Local: OK — Live: Pending verification (proxy required)
- [ ] Cyber Pulse — loads KEV — Local: OK — Live: Pending verification (proxy required)
- [ ] Agriculture — loads USDA feeds — Local: OK — Live: Pending verification (proxy required)
- [ ] Research Watch — loads arXiv feeds — Local: OK — Live: Pending verification (proxy required)
- [ ] Space Weather — loads SWPC feeds — Local: OK — Live: Pending verification (proxy required)
- [ ] Energy Map — loads EIA geo data + legend — Local: OK — Live: Pending verification (proxy energy map)
- [ ] Energy panel — loads EIA Today in Energy — Local: OK — Live: Pending verification (proxy required)
- [ ] Health panel — loads public health feeds — Local: OK — Live: Pending verification (proxy required)
- [ ] Transport & Logistics — loads transport feeds — Local: OK — Live: Pending verification (proxy required)

## Tickers
- [ ] Market Ticker add/remove — add watchlist items + remove — Local: OK — Live: Pending verification (proxy required)
- [ ] Finance Spotlight add/remove — add watchlist items + remove — Local: OK — Live: Pending verification (proxy required)

## Settings panels
- [ ] Refresh interval slider — updates auto-refresh — Local: OK — Live: OK (client-only)
- [ ] Theme toggle — switches theme + persists — Local: OK — Live: OK (client-only)
- [ ] Language toggle — filters results — Local: OK — Live: Pending verification (proxy required)
- [ ] AI translate toggle — on/off for per-feed translation — Local: OK — Live: Pending verification (proxy required)
- [ ] Radius slider — local scope radius updates — Local: OK — Live: Pending verification (proxy required)
- [ ] Panel visibility toggles — hide/show panels — Local: OK — Live: OK (client-only)
- [ ] Reset layout — restores defaults — Local: OK — Live: OK (client-only)
- [ ] Feed health list — shows per-feed status — Local: OK — Live: Pending verification (proxy required)
- [ ] API Keys section — OpenAI key only; server-managed keys not shown — Local: Updated (code) — Live: Pending verification

## Drag + resize
- [ ] Drag panels — reorder and persist — Local: OK — Live: OK (client-only)
- [ ] Resize panels — adjust sizes and persist — Local: OK — Live: OK (client-only)
