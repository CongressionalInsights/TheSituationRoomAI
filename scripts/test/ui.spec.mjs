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
