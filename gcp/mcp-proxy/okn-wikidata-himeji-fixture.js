// Offline fixture-only projection. Not imported by either server or by any runtime catalog.
const SOURCE = 'okn-wikidata-heritage';
const EVIDENCE = 'pinned_publisher_fixture';
const ENTITY = 'Q188754';
const SUBJECT = `http://www.wikidata.org/entity/${ENTITY}`;
const STATEMENT = 'q188754$82738E96-1260-4BCF-A32C-F96D2C2DE2B3';
const SCHEME_ID = '661';
const RECORD_URL = 'https://whc.unesco.org/en/list/661/';
const DECISION_URL = 'https://whc.unesco.org/en/decisions/3337/';
const GRAPH = 'https://registry.okn.us/registry/kgs/wikidata/';
const RIGHTS = 'https://www.wikidata.org/wiki/Wikidata:Licensing';
const PIN = Object.freeze({
  subject: SUBJECT,
  url: 'https://www.wikidata.org/wiki/Special:EntityData/Q188754.json',
  revision: '2568222523',
  graphModifiedAt: '2026-11-12T08:52:18Z',
  httpStatus: 200,
  bytes: 83954,
  contentSha256: 'ce28ee6b2c0a57bbf3680aa3b22d8063d69474b4af765e068c5b1e585abf6f91',
  transportOrigin: 'dot_cloud_direct_publisher'
});
const DESIGNATION = Object.freeze({
  id: SCHEME_ID, recordUrl: RECORD_URL, decisionUrl: DECISION_URL,
  title: 'Himeji-jo', countryCode: 'JP', category: 'cultural', inscriptionYear: 1993
});
const CLAIM = Object.freeze({
  statementId: STATEMENT, property: 'P757', value: SCHEME_ID, referenceProperty: 'P143'
});
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameFields = (actual, expected) => isRecord(actual)
  && Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && actual[k] === v);
const exactKeys = (obj, expected) => isRecord(obj)
  && Object.keys(obj).length === expected.length && expected.every(k => Object.hasOwn(obj, k));

function absent(coverageStatus, error) {
  return { sourceId: SOURCE, dataKind: 'reference', verifiedZeroResults: false,
    available: false, freshness: 'unavailable', coverageStatus, items: [], error };
}

export function buildHimejiReferenceFixture(request, fixture) {
  if (!exactKeys(request, ['sourceId', 'format', 'params']) || request.sourceId !== SOURCE
    || request.format !== 'json' || !exactKeys(request.params, ['entityId'])
    || request.params.entityId !== ENTITY) return absent('UNSUPPORTED', 'unsupported_reference_selector');

  const receipt = fixture?.publisherReceipt;
  if (fixture?.fixtureVersion !== 'tsr-okn-wikidata-himeji/1' || fixture.evidenceMode !== EVIDENCE
    || !sameFields(receipt, PIN) || !Array.isArray(receipt.claims) || receipt.claims.length !== 1
    || !sameFields(receipt.claims[0], CLAIM) || !sameFields(fixture.designation, DESIGNATION)) {
    return absent('UNKNOWN', 'invalid_publisher_fixture');
  }

  // The mapper and the official designation describe one record. The mapper is evidence
  // of an identifier link (P143 Wikimedia import), not a second designation or corroboration.
  return {
    sourceId: SOURCE, dataKind: 'reference', verifiedZeroResults: false,
    available: true, coverageStatus: 'SCOPED_REFERENCE', freshness: null, cacheAgeMs: null,
    evidenceMode: EVIDENCE, graphCoverageVerified: false,
    items: [{
      id: RECORD_URL, title: DESIGNATION.title, dataKind: 'reference',
      kind: 'world_heritage_designation', designationId: SCHEME_ID,
      geography: { countryCode: DESIGNATION.countryCode, precision: 'country_only' },
      category: DESIGNATION.category,
      event: { kind: 'inscription', year: DESIGNATION.inscriptionYear, precision: 'year' },
      observedAt: null, publishedAt: null,
      crosswalk: { entityId: ENTITY, subject: SUBJECT, property: CLAIM.property, statementId: STATEMENT }
    }],
    provenance: {
      graph: GRAPH, graphVersion: null, subject: SUBJECT, publisherDataUrl: PIN.url,
      entityRevision: PIN.revision, entityModifiedAt: PIN.graphModifiedAt, retrievedAt: null, upstreamAsOf: null,
      contentSha256: PIN.contentSha256, publisherTransportOrigin: PIN.transportOrigin,
      sourceRightsUrl: RIGHTS, rightsScope: 'wikidata_cc0_structured_id_mapping_only',
      designationLineage: { authority: 'UNESCO World Heritage Committee', recordUrl: RECORD_URL, decisionUrl: DECISION_URL },
      crosswalkRole: 'identifier_link_only', crosswalkReferenceProperty: CLAIM.referenceProperty
    }
  };
}
