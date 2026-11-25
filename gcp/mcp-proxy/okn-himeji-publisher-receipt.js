// Exact official Wikidata EntityData revision. This is not QLever or an OKN federation path.
import { createHash } from 'node:crypto';
import { buildHimejiReferenceFixture } from './okn-wikidata-himeji-fixture.js';

export const HIMEJI_PUBLISHER_URL = 'https://www.wikidata.org/wiki/Special:EntityData/Q188754.json?revision=2568222523';
export const HIMEJI_BODY_LIMIT = 262144;
export const HIMEJI_DEADLINE_MS = 12000;
const BODY_SHA = 'ce28ee6b2c0a57bbf3680aa3b22d8063d69474b4af765e068c5b1e585abf6f91';
const ENTITY = 'Q188754';
const REVISION = 2568222523;
const MODIFIED = '2026-11-12T08:52:18Z';
const STATEMENT = 'q188754$82738E96-1260-4BCF-A32C-F96D2C2DE2B3';
const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const jsonType = value => typeof value === 'string' && /^application\/json(?:\s*(?:;|$))/i.test(value);
const validTime = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  && Date.parse(value) >= Date.parse(MODIFIED);

function absent(error) {
  return { sourceId: 'okn-wikidata-heritage', dataKind: 'reference',
    verifiedZeroResults: false, available: false, freshness: 'unavailable',
    coverageStatus: 'UNKNOWN', items: [], error };
}

// Used only with the explicit publisher acquisition input to the local fixture reader.
export function readPinnedHimejiPublisherReceipt(request, fixture, receipt) {
  // Keep existing exact selector checks, UNESCO authority, rights and safe normalized fields.
  const projected = buildHimejiReferenceFixture(request, fixture);
  if (!projected.available) return projected;
  if (receipt?.error) return absent(receipt.error === 'publisher_timeout' ? 'publisher_timeout' : 'publisher_unavailable');
  if (receipt?.url !== HIMEJI_PUBLISHER_URL || receipt.status !== 200 || receipt.redirected !== false
      || !jsonType(receipt.contentType) || !validTime(receipt.retrievedAt)) return absent('invalid_publisher_receipt');
  const { body } = receipt;
  if (!(body instanceof Uint8Array) || body.byteLength === 0 || body.byteLength > HIMEJI_BODY_LIMIT) {
    return absent('invalid_publisher_body_size');
  }
  const hash = createHash('sha256').update(body).digest('hex');
  if (hash !== BODY_SHA) return absent('publisher_body_digest_changed');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return absent('invalid_publisher_json'); }
  const entities = parsed?.entities;
  const entity = entities?.[ENTITY];
  const claims = entity?.claims?.P757;
  if (!isRecord(entities) || Object.keys(entities).length !== 1 || entity?.id !== ENTITY
      || entity.type !== 'item' || entity.lastrevid !== REVISION || entity.modified !== MODIFIED
      || !Array.isArray(claims) || claims.length !== 1) return absent('invalid_publisher_entity');
  const [claim] = claims;
  const snak = claim?.mainsnak;
  const p143 = claim?.references?.[0]?.snaks?.P143;
  if (claim?.id !== STATEMENT || claim.type !== 'statement' || claim.rank !== 'normal'
      || snak?.snaktype !== 'value' || snak.property !== 'P757' || snak.datatype !== 'external-id'
      || snak.datavalue?.type !== 'string' || snak.datavalue.value !== '661'
      || claim.references?.length !== 1 || !Array.isArray(p143) || p143.length !== 1
      || p143[0]?.datavalue?.value?.id !== 'Q8447') return absent('invalid_publisher_crosswalk');
  return {
    ...projected,
    evidenceMode: 'publisher_pinned_revision_read',
    // Acquisition time is present, but no active cache or freshness SLA is asserted.
    freshness: null,
    provenance: {
      ...projected.provenance,
      publisherDataUrl: receipt.url,
      publisherTransportOrigin: 'direct_publisher_linked_data',
      retrievedAt: receipt.retrievedAt,
      contentSha256: hash,
      crosswalkImportedFrom: 'Q8447',
    },
  };
}

// Standalone bounded acquisition primitive. Ordinary HTTP startup and raw.fetch never call it.
export async function acquirePinnedHimejiPublisherReceipt({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const controller = new AbortController();
  let timer;
  const read = async () => {
    const response = await fetchImpl(HIMEJI_PUBLISHER_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/json',
        'user-agent': 'TheSituationRoomAI/0.1 (https://github.com/CongressionalInsights/TheSituationRoomAI) scoped reference verification' },
    });
    const contentType = response.headers.get('content-type');
    const size = response.headers.get('content-length');
    if (response.status !== 200 || response.redirected || (response.url && response.url !== HIMEJI_PUBLISHER_URL)
        || !jsonType(contentType) || !response.body
        || (size !== null && (!/^\d+$/.test(size) || Number(size) > HIMEJI_BODY_LIMIT))) {
      controller.abort();
      return { error: 'publisher_unavailable' };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > HIMEJI_BODY_LIMIT) {
          controller.abort();
          return { error: 'publisher_unavailable' };
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!bytes) return { error: 'publisher_unavailable' };
    return { url: HIMEJI_PUBLISHER_URL, status: 200, redirected: false, contentType,
      retrievedAt: new Date(now()).toISOString(), body: Buffer.concat(chunks, bytes) };
  };
  try {
    return await Promise.race([
      new Promise(resolve => {
        timer = setTimeout(() => { resolve({ error: 'publisher_timeout' }); controller.abort(); }, HIMEJI_DEADLINE_MS);
      }),
      read().catch(() => ({ error: 'publisher_unavailable' })),
    ]);
  } finally { clearTimeout(timer); }
}
