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

test('state filters are context-local and tab panels respect active state', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__SR_READY__ === true);

  const searchStateFilter = page.locator('#stateSignalFilter');
  const panelStateFilter = page.locator('#statePanelSignalFilter');

  const searchToggle = page.locator('[data-command-toggle="search"]');
  if ((await searchToggle.getAttribute('aria-expanded')) !== 'true') {
    await searchToggle.click();
  }

  await expect(searchStateFilter).toBeVisible();
  await expect(panelStateFilter).toBeVisible();

  await searchStateFilter.selectOption('NY');
  await panelStateFilter.selectOption('CA');

  await expect(searchStateFilter).toHaveValue('NY');
  await expect(panelStateFilter).toHaveValue('CA');
  await expect(page.locator('#statePanelFilterChip')).toContainText('California');

  const rulemakingTab = page.locator('#stateGovTabs .tab[data-tab="rulemaking"]');
  const executiveTab = page.locator('#stateGovTabs .tab[data-tab="executive"]');
  await page.waitForFunction(() => {
    const rule = document.querySelector('#stateGovTabs .tab[data-tab="rulemaking"]');
    const exec = document.querySelector('#stateGovTabs .tab[data-tab="executive"]');
    return Boolean(rule && exec && rule.hidden && exec.hidden);
  }, null, { timeout: 60_000 });
  await expect(rulemakingTab).toBeHidden();
  await expect(executiveTab).toBeHidden();

  await page.route('**/api/feed', async (route, request) => {
    const requestUrl = new URL(request.url());
    let id = requestUrl.searchParams.get('id');
    if (!id && request.method() === 'POST') {
      let payload = {};
      try {
        payload = request.postDataJSON() || {};
      } catch {
        payload = {};
      }
      id = payload.id;
    }
    if (id !== 'state-rulemaking' && id !== 'state-executive-orders') {
      await route.continue();
      return;
    }
    const signalType = id === 'state-rulemaking' ? 'rulemaking' : 'executive_order';
    const response = {
      id,
      fetchedAt: Date.now(),
      contentType: 'application/json',
      httpStatus: 200,
      body: JSON.stringify({
        results: [
          {
            id: `${id}-tx-1`,
            title: `${signalType} test signal`,
            summary: 'Connector test item',
            url: 'https://example.com',
            updated_at: new Date().toISOString(),
            jurisdictionCode: 'TX',
            jurisdictionName: 'Texas',
            jurisdictionLevel: 'state',
            signalType,
            agency: 'Test Agency',
            status: 'Open',
            effective_date: '',
            source: 'Test Connector'
          }
        ],
        meta: { provider: 'test-connector' }
      })
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response)
    });
  });

  await page.locator('#refreshNow').click();
  await page.waitForFunction(() => {
    const rule = document.querySelector('#stateGovTabs .tab[data-tab="rulemaking"]');
    const exec = document.querySelector('#stateGovTabs .tab[data-tab="executive"]');
    return Boolean(rule && exec && !rule.hidden && !exec.hidden);
  }, null, { timeout: 60_000 });
  await expect(rulemakingTab).toBeVisible();
  await expect(executiveTab).toBeVisible();

  const tabDisplays = await page.evaluate(() => {
    const clickTab = (tabsId, tab) => {
      const button = document.querySelector(`#${tabsId} .tab[data-tab="${tab}"]`);
      if (button) button.click();
    };
    clickTab('stateGovTabs', 'executive');
    clickTab('financeTabs', 'markets');
    const ids = [
      'stateGovAllList',
      'stateGovLegislationList',
      'stateGovRulemakingList',
      'stateGovExecutiveOrdersList',
      'financeMarketsList',
      'financePolicyList'
    ];
    return Object.fromEntries(
      ids.map((id) => [id, window.getComputedStyle(document.getElementById(id)).display])
    );
  });

  expect(tabDisplays.stateGovAllList).toBe('none');
  expect(tabDisplays.stateGovLegislationList).toBe('none');
  expect(tabDisplays.stateGovRulemakingList).toBe('none');
  expect(tabDisplays.stateGovExecutiveOrdersList).not.toBe('none');
  expect(tabDisplays.financeMarketsList).not.toBe('none');
  expect(tabDisplays.financePolicyList).toBe('none');

  await page.locator('.panel[data-panel="state-gov"] .panel-focus-btn').click();
  await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
  await expect(page.locator('#statePanelSignalFilter')).toBeVisible();
  await expect(page.locator('#statePanelSignalFilter')).toHaveValue('CA');
  await page.locator('#focusClose').click();
  await expect(page.locator('#focusOverlay')).not.toHaveClass(/open/);

  await page.reload();
  await page.waitForFunction(() => window.__SR_READY__ === true);
  await expect(page.locator('#stateSignalFilter')).toHaveValue('ALL');
  await expect(page.locator('#statePanelSignalFilter')).toHaveValue('ALL');
});
