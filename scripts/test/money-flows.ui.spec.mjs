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
