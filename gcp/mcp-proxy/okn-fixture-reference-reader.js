// Private dependency for explicit local MCP contract tests. Never load fixture files or networks here.
import { buildKennebecReference } from './okn-kennebec-reference-fixture.js';
import { buildHimejiReferenceFixture } from './okn-wikidata-himeji-fixture.js';
import { readPinnedHimejiPublisherReceipt } from './okn-himeji-publisher-receipt.js';

const KENNEBEC = 'okn-kennebec-reference';
const HIMEJI = 'okn-wikidata-heritage';
const PLACE_KEY = 'kennebec:waterville:below-lockwood-dam';
const EVIDENCE = 'pinned_publisher_fixture';
const isExactRecord = (value, key) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, key);

function absent(sourceId, coverageStatus, error) {
  return { sourceId, dataKind: 'reference', available: false, freshness: 'unavailable',
    coverageStatus, verifiedZeroResults: false, items: [], error };
}

export function createFixtureReferenceReader(inputs) {
  const himeji = inputs?.himeji ?? null;
  const hasPublisherReceipt = inputs && Object.hasOwn(inputs, 'himejiPublisherReceipt');
  const kennebec = inputs?.kennebec ? buildKennebecReference(inputs.kennebec) : null;
  return function read({ sourceId, query, start, end, params, format }) {
    if ((sourceId !== HIMEJI || !himeji) && (sourceId !== KENNEBEC || !kennebec)) return null;
    if (format !== 'json' || query !== undefined || start !== undefined || end !== undefined) {
      return absent(sourceId, 'UNSUPPORTED', 'unsupported_reference_selector');
    }
    if (sourceId === HIMEJI) {
      const request = { sourceId, format, params };
      return hasPublisherReceipt
        ? readPinnedHimejiPublisherReceipt(request, himeji, inputs.himejiPublisherReceipt)
        : buildHimejiReferenceFixture(request, himeji);
    }
    if (!isExactRecord(params, 'placeKey') || params.placeKey !== PLACE_KEY) {
      return absent(sourceId, 'UNSUPPORTED', 'unsupported_reference_selector');
    }
    if (kennebec.status !== 'REFERENCE_ONLY') return absent(sourceId, 'UNKNOWN', 'invalid_publisher_fixture');
    return {
      sourceId, dataKind: 'reference', verifiedZeroResults: false,
      available: true, coverageStatus: 'SCOPED_REFERENCE', freshness: null, cacheAgeMs: null,
      evidenceMode: EVIDENCE, graphCoverageVerified: false,
      items: [{
        id: 'tsr-fixture:kennebec:waterville:below-lockwood-dam:2023:pfos',
        title: 'Kennebec River below Lockwood Dam, Waterville',
        dataKind: 'reference', kind: 'historical_fish_tissue_reference',
        geography: { placeKey: PLACE_KEY, precision: 'named_sampling_location_only' },
        // Keep the pinned projection verbatim for the two existing consumer contract checks.
        reference: structuredClone(kennebec),
      }],
      provenance: {
        sourceDataset: kennebec.historicalObservations[0].sourceUrl,
        graphDemoUrl: kennebec.publishedGraphDemo.sourceUrl,
        graphDemoRole: 'context_only',
        upstreamAsOf: null, retrievedAt: null,
        rightsScope: 'pinned_offline_reference_only',
      },
    };
  };
}
