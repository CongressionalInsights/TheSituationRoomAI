import assert from 'node:assert/strict';
import test from 'node:test';
import { observeIssue, searchUrl } from '../texas-register-evidence.mjs';
const now = new Date('2026-11-26T17:48:14Z');
const sourceSha = '3e5aa9c2f61958b6ed55b2620746ea36fa00bed8';
const rows = (date, count = 20) => ({ issueDates: Array(count).fill(date), officialRowCount: count });
const observe = readSearch => observeIssue({ now, sourceSha, readSearch });

test('official date at the search upper bound needs one request even when results are truncated', async () => {
  let reads = 0;
  const outcome = await observe(async window => {
    reads++;
    assert.deepEqual(window, { start: '2026-11-18', end: '2026-11-27' });
    return rows('2026-11-27');
  });
  assert.equal(reads, 1);
  assert.equal(outcome.sourceUrl, searchUrl);
  assert.equal(outcome.sourceSha, sourceSha);
  assert.equal(outcome.issueDate, '2026-11-27');
  assert.equal(outcome.latestProof, 'upper_bound_row');
  assert.equal(outcome.sampleRows, 20);
});

test('an older grid needs explicit empty proof across the entire newer window', async () => {
  const calls = [];
  const outcome = await observe(async window => {
    calls.push(window);
    return calls.length === 1 ? rows('2026-11-20') :
      { issueDates: [], officialRowCount: 0, explicitEmpty: true };
  });
  assert.deepEqual(calls, [{ start: '2026-11-18', end: '2026-11-27' }, { start: '2026-11-21', end: '2026-11-27' }]);
  assert.equal(outcome.latestProof, 'explicit_empty_newer_window');
});

test('unchecked newer dates, stale rows and invalid source rows are unavailable', async () => {
  for (const fixture of [
    [rows('2026-11-20'), { issueDates: [], officialRowCount: 0 }],
    [rows('2026-11-20'), rows('2026-11-26')],
    [rows('2026-11-17')],
    [rows('2026-12-04')],
    [{ ...rows('2026-11-27'), officialRowCount: 0 }]
  ]) {
    const outcome = await observe(async () => fixture.shift());
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.reason, 'current_issue_unverified');
    assert.equal(outcome.issueDate, undefined);
  }
});

test('transport failure cannot expose upstream content or reuse old evidence', async () => {
  const outcome = await observe(async () => { throw new Error('private upstream payload'); });
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.reason, 'search_read_failed');
  assert.doesNotMatch(JSON.stringify(outcome), /private upstream/);
});
