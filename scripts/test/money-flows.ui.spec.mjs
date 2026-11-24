import { test, expect } from '@playwright/test';

test('money sample UI preserves zero, negative, unknown and registration semantics', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(String(error)));
  const payload = {
    schemaVersion: 2, coverage: { status: 'discovery_sample', complete: false },
    sources: { sam: { count: 1, returnedCount: 1, coverage: { status: 'complete_for_queries' } }, fec: { count: 0, returnedCount: 0, coverage: { status: 'unavailable' } } },
    items: [0, -200, null, null].map((amount, index) => ({ sourceId: `fixture-${index}`, title: 'Acme', source: 'Fixture', amount, publishedAt: null })), summary: { totalItems: 4, basis: 'returned_rows_only',
      buckets: { contributions: { count: 1, totalAmount: 0 }, spending: { count: 1, totalAmount: -200 }, lobbying: { count: 1, totalAmount: null, unknownAmountCount: 1 }, registry: { count: 1, totalAmount: null } },
      top: { contributions: { donor: 'Jane', donorAmount: 0 }, spending: { recipient: 'Acme', recipientAmount: -200 }, registry: { entity: 'Acme', entityAmount: null } }
    }
  };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/money-flows') return route.fulfill({ json: payload });
    if (url.pathname === '/api/feeds') return route.fulfill({ json: { app: {}, feeds: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], items: [] } });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__SR_READY__ === true);
  await page.locator('#moneyFlowsQuery').fill('Acme');
  await page.locator('#moneyFlowsRun').click();
  await expect(page.locator('#moneyFlowsMeta')).toContainText('Discovery sample');
  await expect(page.locator('#moneyFlowsMeta')).toContainText('unavailable');
  await expect(page.locator('.money-summary-card.money-tone-in .summary-value')).toHaveText('$0');
  await expect(page.locator('.money-summary-card.money-tone-out .summary-value')).toHaveText('-$200');
  await expect(page.locator('.money-summary-card.money-tone-lobby .summary-value')).toHaveText('—');
  await expect(page.locator('.money-summary-card.money-tone-lobby .summary-sub')).toContainText('1 unknown amounts');
  await expect(page.locator('.money-summary-card.money-tone-registry .summary-value')).toHaveText('1 registrations');
  expect(errors).toEqual([]);
});

test('Employer search starts independently and keeps cursor results separate from the ranked sample', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-23T17:00:00Z'));
  let releaseRanked;
  const ranked = new Promise(resolve => { releaseRanked = resolve; });
  let releaseOld;
  const old = new Promise(resolve => { releaseOld = resolve; });
  const calls = [];
  const row = (sourceId, title) => ({ source: 'OpenFEC', sourceId, title, publishedAt: null,
    matchRole: 'reported_employer', attribution: 'Reported employer is affiliation only.' });
  const next = (query, cursor) => ({ query, start: '2026-01-01', end: '2026-11-23', mode: 'fec_employer_pages', cursor });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/money-flows') {
      const q = url.searchParams.get('q');
      const mode = url.searchParams.get('mode');
      const cursor = url.searchParams.get('cursor');
      calls.push([q, mode, cursor, url.searchParams.get('start'), url.searchParams.get('end')]);
      if (!mode) {
        await ranked;
        return route.fulfill({ json: {
          items: [row('1', 'Ranked match')], summary: { totalItems: 1, buckets: {} },
          sources: { fec: { count: 1, coverage: { status: 'partial' } } },
          fecEmployerTraversal: { startsFromBeginning: true, next: next(q, 'ignore-ranked-cursor') }
        }});
      }
      if (cursor === 'Acme-two') await old;
      const items = cursor === 'Acme-two' ? [row('3', 'Old pending result')]
        : cursor === 'Acme-one' ? [row('1', 'Repeated first record'), row('2', 'Distinct later result')]
        : q === 'Acme' ? [row('1', 'Independent first record')] : [];
      return route.fulfill({ json: {
        items,
        sources: { fec: { coverage: { pages: 1 } } },
        fecTraversal: { next: !cursor && q === 'Acme' ? next(q, 'Acme-one')
          : cursor === 'Acme-one' ? next(q, 'Acme-two') : null, complete: q !== 'Acme' || cursor === 'Acme-two' }
      }});
    }
    if (url.pathname === '/api/feeds') return route.fulfill({ json: { app: {}, feeds: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], items: [] } });
    return route.continue();
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__SR_READY__ === true);
  const input = page.locator('#moneyFlowsQuery');
  const run = page.locator('#moneyFlowsRun');
  const start = page.getByRole('button', { name: 'Search OpenFEC employer records' });
  const more = page.getByRole('button', { name: 'Load more employer records' });
  await page.locator('#moneyFlowsRange').selectOption('ytd');
  await input.fill('Acme');
  await run.click();
  await expect.poll(() => calls.length).toBe(1);
  await expect(more).toHaveCount(0);
  await start.click();
  await expect(page.getByText('Independent first record', { exact: true })).toBeVisible();
  await expect(page.locator('#moneyEmployerResults')).toContainText('affiliation only');
  await expect(page.locator('#moneyFlowsMeta')).toContainText('Fetching money flows');
  await expect(start).toHaveCount(0);
  await more.click();
  await expect(page.getByText('Distinct later result', { exact: true })).toBeVisible();
  await expect(page.getByText('Repeated first record', { exact: true })).toHaveCount(0);

  releaseRanked();
  await expect(page.getByText('Ranked match', { exact: true })).toBeVisible();
  await expect(page.getByText('Independent first record', { exact: true })).toHaveCount(0);
  await expect(page.locator('#moneyFlowsMeta')).toContainText('partial sample');
  await expect(page.locator('#moneyFlowsSummary .summary-value').first()).toHaveText('1');
  await more.click();
  await expect.poll(() => calls.length).toBe(4);
  await input.fill('Other');
  await expect(page.getByText('Distinct later result', { exact: true })).toHaveCount(0);
  const oldCompleted = page.waitForResponse(r => new URL(r.url()).searchParams.get('cursor') === 'Acme-two');
  releaseOld();
  await oldCompleted;
  await start.click();
  await expect(page.getByRole('status').filter({ hasText: 'No additional matching employer records' })).toBeVisible();
  await expect(page.getByText('Old pending result', { exact: true })).toHaveCount(0);
  expect(calls).toEqual([
    ['Acme', null, null], ['Acme', 'fec_employer_pages', null], ['Acme', 'fec_employer_pages', 'Acme-one'],
    ['Acme', 'fec_employer_pages', 'Acme-two'], ['Other', 'fec_employer_pages', null]
  ].map(call => [...call, '2026-01-01', '2026-11-23']));
});

test('Employer first-page error and rate limit keep a retry on the same page', async ({ page }) => {
  let requests = 0;
  const now = new Date('2026-11-23T17:00:00Z').getTime();
  await page.clock.setFixedTime(now);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/money-flows') {
      expect(url.searchParams.get('mode')).toBe('fec_employer_pages');
      requests++;
      if (requests === 1) return route.fulfill({ status: 502, json: { error: 'fetch_failed' } });
      if (requests === 2) return route.fulfill({ json: {
        items: [], sources: { fec: { retryAt: new Date(now + 60000).toISOString(), coverage: { pages: 0 } } },
        fecTraversal: { blocked: true, next: { query: 'Acme', start: '2026-01-01', end: '2026-11-23',
          mode: 'fec_employer_pages', cursor: 'retry-one' } }
      }});
      expect(url.searchParams.get('cursor')).toBe('retry-one');
      return route.fulfill({ json: { items: [], sources: { fec: { coverage: { pages: 1 } } },
        fecTraversal: { complete: true, next: null } } });
    }
    if (url.pathname === '/api/feeds') return route.fulfill({ json: { app: {}, feeds: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], items: [] } });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__SR_READY__ === true);
  await page.locator('#moneyFlowsRange').selectOption('ytd');
  await page.locator('#moneyFlowsQuery').fill('Acme');
  const start = page.getByRole('button', { name: 'Search OpenFEC employer records' });
  const status = page.locator('#moneyEmployerStatus');
  await start.click();
  await expect(status).toContainText('could not be loaded');
  await start.click();
  await expect(status).toContainText('rate limit');
  await start.click();
  expect(requests).toBe(2);
  await expect(page.getByRole('button', { name: 'Load more employer records' })).toHaveCount(0);
  await page.clock.setFixedTime(now + 61000);
  await start.click();
  await expect(status).toContainText('requested employer pages have finished');
  expect(requests).toBe(3);
});
