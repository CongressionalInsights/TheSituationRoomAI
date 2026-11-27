import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesIssueUrl, parsePagesIssue } from '../../gcp/state-connector/adapters/tx-search-issue.js';
import { observeIssue, readPublishedIssue, searchUrl, searchWindow } from '../texas-register-evidence.mjs';
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

function verifiedArtifact(stamp) {
  const window = searchWindow(stamp);
  return {
    schema: 'tsr-texas-register-search/v1', status: 'available', sourceUrl: searchUrl,
    sourceSha, observedAt: stamp.toISOString(), window, issueDate: window.end,
    latestProof: 'upper_bound_row', sampleRows: 20
  };
}

test('a transient timeout retains the verified issue without renewing its provenance or expiry', async () => {
  const previous = verifiedArtifact(new Date(now.valueOf() - 3599000));
  const current = 'a'.repeat(40);
  let reads = 0;
  const retained = await observeIssue({
    now, sourceSha: current, clock: () => now.valueOf(),
    readSearch: async () => { throw new Error('synthetic browser timeout'); },
    readPrevious: async () => { reads++; return JSON.stringify(previous); }
  });
  assert.equal(reads, 1);
  assert.deepEqual(retained, {
    ...previous, observationStatus: 'retained',
    acquisition: { status: 'failed', reason: 'search_read_failed', attemptedAt: now.toISOString(), sourceSha: current }
  });
  const atExpiry = Date.parse(previous.observedAt) + 3 * 60 * 60 * 1000;
  assert.equal(parsePagesIssue(JSON.stringify(retained), atExpiry), previous.issueDate);
  assert.equal(parsePagesIssue(JSON.stringify(retained), atExpiry + 1), null);
});

test('expiry, future observations, invalid provenance and unavailable prior bytes fail closed', async () => {
  const valid = verifiedArtifact(now);
  for (const previous of [
    verifiedArtifact(new Date(now.valueOf() - 10800001)), verifiedArtifact(new Date(now.valueOf() + 1)),
    { ...valid, sourceUrl: 'https://example.org' }, { ...valid, status: 'unavailable' }, { ...valid, latestProof: 'other' },
    { ...valid, window: { ...valid.window, start: '2026-11-17' } }, null
  ]) {
    const result = await observeIssue({
      now, sourceSha, clock: () => now.valueOf(),
      readSearch: async () => { throw new Error('synthetic browser failure'); },
      readPrevious: async () => JSON.stringify(previous)
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.issueDate, undefined);
  }
});

test('a fresh or unverified search does not read the prior snapshot', async () => {
  for (const search of [rows('2026-11-27'), rows('2026-11-17')]) {
    let readCount = 0;
    await observeIssue({
      now, sourceSha, readSearch: async () => search,
      readPrevious: async () => { readCount++; return ''; }
    });
    assert.equal(readCount, 0);
  }
});

test('the previous issue read is fixed, anonymous, bounded, and rejects redirects', async () => {
  let reads = 0;
  const body = await readPublishedIssue(async (url, options) => {
    reads++;
    assert.equal(url, pagesIssueUrl);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    assert.equal(new Headers(options.headers).has('Cookie'), false);
    return new Response('x'.repeat(4097));
  });
  assert.equal(reads, 1);
  assert.equal(body, '');
  const redirected = new Response('{}');
  Object.defineProperty(redirected, 'redirected', { value: true });
  assert.equal(await readPublishedIssue(async () => redirected), '');
  assert.equal(await readPublishedIssue(async () => new Response('not found', { status: 404 })), '');
});

function runProducerFixture(t, browserFixture, fetchFixture) {
  const directory = mkdtempSync(join(tmpdir(), 'tsr-tx-entrypoint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = `import { registerHooks } from 'node:module';
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'playwright') return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(browserFixture))}, shortCircuit: true };
    return nextResolve(specifier, context);
  }});
  ${fetchFixture}`;
  const output = join(directory, 'issue.json');
  const command = fileURLToPath(new URL('../build_texas_register_search.mjs', import.meta.url));
  const stdout = execFileSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), command, output], {
    env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) },
    encoding: 'utf8', timeout: 15000
  });
  const [trace, report] = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
  return { trace, report, stdout };
}

test('Texas production entrypoint logs a bounded browser timeout and retains only the verified observation', (t) => {
  const previous = verifiedArtifact(new Date(Date.now() - 5000));
  const browserFixture = "export const chromium = { launch: async () => { throw Object.assign(new Error('synthetic private browser error'), { name: 'TimeoutError' }); } };";
  const { trace, report, stdout } = runProducerFixture(t, browserFixture, `globalThis.fetch = async (url, options) => {
    if (url !== ${JSON.stringify(pagesIssueUrl)} || options.redirect !== 'error' || options.credentials !== 'omit')
      throw new Error('unexpected fixture request');
    return new Response(${JSON.stringify(JSON.stringify(previous))});
  };`);
  assert.equal(trace.event, 'texas_register_search_trace');
  assert.equal(trace.phase, 'launch');
  assert.equal(trace.outcome, 'failed');
  assert.equal(trace.category, 'timeout');
  assert.equal(trace.httpStatus, null);
  assert.equal(typeof trace.timingsMs.launch, 'number');
  assert.equal(report.status, 'available');
  assert.equal(report.observationStatus, 'retained');
  assert.equal(report.observedAt, previous.observedAt);
  assert.equal(report.sourceSha, previous.sourceSha);
  assert.equal(report.acquisition.status, 'failed');
  assert.doesNotMatch(stdout, /synthetic private browser error|browserType/);
});

test('Texas producer keeps Chrome startup and form readiness budgets separate', (t) => {
  const window = searchWindow(now);
  const display = date => [date.slice(5, 7), date.slice(8), date.slice(0, 4)].join('/');
  const browserFixture = `
    const chromeStartupMs = 12000;
    const ruleReadinessMs = 9366;
    const ruleControl = {
      filter: () => ruleControl,
      waitFor: async options => {
        if ((options?.timeout ?? 6500) <= ruleReadinessMs) {
          throw Object.assign(new Error('modeled form hydration exceeds wait'), { name: 'TimeoutError' });
        }
        if (options.timeout !== 14000) throw new Error('unexpected form readiness budget');
        globalThis.fixtureElapsedMs += ruleReadinessMs;
      }
    };
    const role = { filter: () => role, waitFor: async () => {}, click: async () => {}, count: async () => 1 };
    const grid = { filter: () => grid, isVisible: async () => false,
      waitFor: async () => {}, evaluate: async () => ({ displayed: [${JSON.stringify(display(window.end))}], officialRowCount: 1 }) };
    const page = {
      setDefaultTimeout: timeout => {
        if (timeout !== 6500) throw new Error('unrelated page action budget changed');
      },
      goto: async url => {
        if (url !== ${JSON.stringify(searchUrl)}) throw new Error('unexpected navigation');
        return { ok: () => true, status: () => 200 };
      },
      url: () => ${JSON.stringify(searchUrl)},
      getByRole: name => name === 'combobox' ? ruleControl : role,
      getByLabel: label => ({ locator: () => ({ getByRole: () => role }),
        inputValue: async () => label === 'Issue Date From' ? ${JSON.stringify(display(window.start))} : ${JSON.stringify(display(window.end))} }),
      locator: () => grid,
      close: async () => {}
    };
    export const chromium = { launch: async options => {
      if (options.timeout <= chromeStartupMs) throw Object.assign(new Error('modeled startup exceeds budget'), { name: 'TimeoutError' });
      if (options.timeout !== 20000 || options.headless !== true) throw new Error('unexpected launch policy');
      globalThis.fixtureElapsedMs += chromeStartupMs;
      return { newPage: async () => {
        globalThis.fixtureElapsedMs += 1500;
        return page;
      }, close: async () => {} };
    } };`;
  const { trace, report } = runProducerFixture(t, browserFixture, `
    globalThis.fixtureElapsedMs = 0;
    Object.defineProperty(performance, 'now', { value: () => globalThis.fixtureElapsedMs });
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [${now.valueOf()}])); }
      static now() { return ${now.valueOf()}; }
    };
    globalThis.fetch = async () => { throw new Error('unexpected live or retention request'); };`);
  assert.equal(trace.outcome, 'completed');
  assert.equal(trace.httpStatus, 200);
  assert.equal(trace.timingsMs.launch, 12000);
  assert.equal(trace.timingsMs.page_setup, 1500);
  assert.equal(trace.timingsMs.controls, 9366);
  assert.equal(report.status, 'available');
  assert.equal(report.issueDate, window.end);
  assert.equal(report.observationStatus, undefined);
  assert.equal(report.sourceSha, 'a'.repeat(40));
});
