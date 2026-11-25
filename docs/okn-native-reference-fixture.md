# Default-off OKN reference contract proof

This patch does not activate a feed. It exercises the existing native MCP
`raw.fetch` call path with explicit fixture inputs to the server factory.
The HTTP handler never passes those inputs. No startup flag, environment
variable, request parameter, public API argument, or provider transport can
activate the fixtures. Native HTTP calls for both sources still return
`unknown_source`. There is no corresponding Feed HTTP registration,
catalog metadata, smart fanout, provider refresh, history, or cache change.

The local SDK wire capture is `scripts/test/fixtures/okn-native-reference-wire.json`.
It covers two separately attributable scoped references:

| Source ID | Exact local selector | Output |
| --- | --- | --- |
| `okn-kennebec-reference` | `placeKey: "kennebec:waterville:below-lockwood-dam"` | 2023 Maine CDC historical PFOS fish-tissue observations, two five-fish composites. SAWGraph publisher demo is context only, not sample lineage, facility causation, current safety, drinking water, or earthquake impact. The exact original projection is preserved at `items[0].reference`. |
| `okn-wikidata-heritage` | `entityId: "Q188754"` | One UNESCO 661 historical inscription in 1993. Wikidata P757 is identifier mapping only. No geometry, media, coverage, or fresh-event claim. |

Both request `format: "json"` only. Selector mismatch is `UNSUPPORTED`, damaged
fixture evidence is `UNKNOWN`, and neither means verified zero. No country,
name, proximity, media, or geometry inference. The success result says
`pinned_publisher_fixture` and does not claim live coverage or freshness.
Publication and earthquake event dates must not be inferred from editor or cache
timestamps.

SiteHunter and Earthquake Analyst should consume the same wire contract and
current trusted selection binding. If the selected place or request revision
changes, keep the original result unchanged. These are optional historical
references, never a detection input, lead, quake assessment, or alert. Neither app
should call OKN directly. Consumer-native acceptance and serving-region transport
are separate release gates, not established by this offline fixture.

Run `npm test` from the project root. The focused test
`node --test scripts/test/okn-native-reference.spec.mjs` tests the actual native
MCP tool using SDK linked transport and the production-equivalent default HTTP
routing locally, with external fetches blocked.
