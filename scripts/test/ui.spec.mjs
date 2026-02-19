import { test, expect } from '@playwright/test';

test('dashboard loads panels and focus modal', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__SR_READY__ === true);
  const panels = page.locator('.panel[data-panel]');
  expect(await panels.count()).toBeGreaterThan(5);

  const focusBtn = page.locator('.panel-focus-btn').first();
  await focusBtn.click();

  const overlay = page.locator('#focusOverlay');
  await expect(overlay).toHaveClass(/open/);

  const closeBtn = page.locator('#focusClose');
  await closeBtn.click();
  await expect(overlay).not.toHaveClass(/open/);
});

test('dashboard renders downstream panels without summary-type crash', async ({ page }) => {
  const runtimeErrors = [];
  const consoleErrors = [];

  page.on('pageerror', (err) => runtimeErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__SR_READY__ === true);
  await page.waitForFunction(() => {
    const health = document.getElementById('healthValue')?.textContent?.trim() || '';
    return Boolean(health && health !== 'Initializing');
  }, null, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const refreshNow = document.getElementById('refreshNow');
    const summaryText = document.getElementById('globalActivityMeta')?.textContent?.trim() || '';
    return Boolean(refreshNow && !refreshNow.disabled)
      && !/^Awaiting/i.test(summaryText)
      && !/^Fetching/i.test(summaryText);
  }, null, { timeout: 90_000 });

  const snapshot = await page.evaluate(() => {
    const downstreamListIds = [
      'localList',
      'policyList',
      'stateGovAllList',
      'congressList',
      'cyberList',
      'agricultureList',
      'researchList',
      'spaceList',
      'energyList',
      'healthList',
      'transportList'
    ];
    const listCounts = Object.fromEntries(
      downstreamListIds.map((id) => {
        const node = document.getElementById(id);
        return [id, node ? node.querySelectorAll('.list-item').length : -1];
      })
    );
    const statusTexts = [
      document.getElementById('globalActivityMeta')?.textContent?.trim() || '',
      document.getElementById('newsSaturationMeta')?.textContent?.trim() || '',
      document.getElementById('localEventsMeta')?.textContent?.trim() || '',
      document.getElementById('marketPulseMeta')?.textContent?.trim() || ''
    ];
    return {
      listCounts,
      statusTexts,
      healthValue: document.getElementById('healthValue')?.textContent?.trim() || ''
    };
  });

  const allErrors = [...runtimeErrors, ...consoleErrors].join('\n');
  expect(allErrors).not.toMatch(/includes is not a function/i);

  Object.entries(snapshot.listCounts).forEach(([, count]) => {
    expect(count).toBeGreaterThan(0);
  });
  snapshot.statusTexts.forEach((text) => {
    expect(text).not.toMatch(/^Awaiting/i);
  });
  expect(snapshot.healthValue).not.toBe('Initializing');
});
