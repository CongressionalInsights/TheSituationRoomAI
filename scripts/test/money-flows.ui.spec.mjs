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

test('Employer Load more follows the server cursor, skips visible duplicates, and resets on a new search', async ({ page }) => {
  let releaseOld;
  const old = new Promise(resolve => { releaseOld = resolve; });
  const moreCalls = [];
  const row = (id, title) => ({ source: 'OpenFEC', sourceId: id, title, publishedAt: null });
  const next = (query, cursor) => ({ query, start: '2026-05-22', end: '2026-11-18', mode: 'fec_employer_pages', cursor });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/money-flows') {
      const q = url.searchParams.get('q');
      const cursor = url.searchParams.get('cursor');
      if (!cursor) return route.fulfill({ json: {
        items: [row('1', 'Initial ' + q)], summary: { totalItems: 1, buckets: {} }, sources: {},
        fecEmployerTraversal: { startsFromBeginning: true, next: next(q, q+'-one') }
      }});
      moreCalls.push([q, cursor, url.searchParams.get('mode'), url.searchParams.get('start')]);
      if (cursor === 'Acme-two') await old;
      return route.fulfill({ json: {
        items: cursor.endsWith('-one') ? [row('1', 'Duplicate initial'), row('2', 'Additional ' + q)] : [row('3', 'Old pending result')],
        fecTraversal: { next: cursor.endsWith('-one') ? next(q, q+'-two') : null, complete: !cursor.endsWith('-one') }
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
  const load = page.getByRole('button', { name: 'Load more employer records' });
  await input.fill('Acme'); await run.click();
  await expect(page.getByText('Initial Acme', { exact: true })).toBeVisible();
  expect(moreCalls).toEqual([]);
  await load.click();
  await expect(page.getByText('Additional Acme', { exact: true })).toBeVisible();
  await expect(page.getByText('Duplicate initial', { exact: true })).toHaveCount(0);
  await expect(page.locator('#moneyFlowsSummary .summary-value').first()).toHaveText('1');
  await load.click();
  await expect.poll(() => moreCalls.length).toBe(2);
  await input.fill('Other'); await run.click();
  await expect(page.getByText('Initial Other', { exact: true })).toBeVisible();
  await expect(page.getByText('Additional Acme', { exact: true })).toHaveCount(0);
  const oldCompleted = page.waitForResponse(r => new URL(r.url()).searchParams.get('cursor') === 'Acme-two');
  releaseOld();
  await oldCompleted;
  await load.click();
  await expect(page.getByText('Additional Other', { exact: true })).toBeVisible();
  await expect(page.getByText('Old pending result', { exact: true })).toHaveCount(0);
  expect(moreCalls).toEqual(['Acme-one', 'Acme-two', 'Other-one'].map((c, i) => [i === 2 ? 'Other' : 'Acme', c, 'fec_employer_pages', '2026-05-22']));
});
