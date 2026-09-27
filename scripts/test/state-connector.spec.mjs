import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { coveredStates } from '../../gcp/state-connector/constants.js';
import { adaptersForState } from '../../gcp/state-connector/adapters/index.js';
import { parseSignalsRequest, signalFetchStatus, sortAndLimitSignals } from '../../gcp/state-connector/request.js';

test('state connector declares adapters for every covered state including North Carolina', () => {
  assert.deepEqual(coveredStates, ['CA', 'FL', 'MN', 'NC', 'NY', 'TX', 'VA']);
  assert.deepEqual(adaptersForState('NC').map((adapter) => adapter.state), ['NC']);
  assert.deepEqual(adaptersForState().map((adapter) => adapter.state).sort(), coveredStates);
  const feeds = JSON.parse(readFileSync(new URL('../../data/feeds.json', import.meta.url), 'utf8')).feeds;
  for (const id of ['state-rulemaking', 'state-executive-orders']) {
    assert.deepEqual(feeds.find((feed) => feed.id === id).coveredStates, coveredStates);
  }
});

test('signals request defaults and clamps limit', () => {
  const request = parseSignalsRequest(new URL('http://localhost/signals?limit=500&state=va'));
  assert.equal(request.signalType, 'rulemaking');
  assert.equal(request.state, 'VA');
  assert.equal(request.limit, 100);
  assert.equal(request.sort, 'updated_desc');
});

test('signals are sorted by updatedAt descending and limited', () => {
  const rows = sortAndLimitSignals([
    { title: 'older', updatedAt: '2026-01-01T00:00:00Z' },
    { title: 'newer', updatedAt: '2026-02-01T00:00:00Z' },
    { title: '', updatedAt: '2026-03-01T00:00:00Z' }
  ], 1);
  assert.deepEqual(rows, [{ title: 'newer', updatedAt: '2026-02-01T00:00:00Z' }]);
});

test('total upstream adapter failure is reported as connector failure', () => {
  assert.equal(signalFetchStatus({ adapterCount: 1, resultCount: 0, errorCount: 1 }), 502);
  assert.equal(signalFetchStatus({ adapterCount: 6, resultCount: 0, errorCount: 6 }), 502);
  assert.equal(signalFetchStatus({ adapterCount: 6, resultCount: 3, errorCount: 3 }), 200);
});
