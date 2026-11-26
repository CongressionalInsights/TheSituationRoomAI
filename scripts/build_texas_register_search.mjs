import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { isDate, observeIssue, searchUrl } from './texas-register-evidence.mjs';

const origin = new URL(searchUrl).origin;
const output = process.argv[2] || 'public/data/feeds/texas-register-current-issue.json';

function dateControl(date) {
  const day = Number(date.slice(8));
  const suffix = day >= 11 && day <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th');
  const stamp = new Date(date + 'T00:00:00Z');
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(stamp);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(stamp);
  return `Select ${weekday}, ${month} ${day}${suffix} ${date.slice(0, 4)}`;
}

function parseDate(value) {
  const parts = value.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/);
  if (!parts) return null;
  const [, month, day, year] = parts;
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isDate(date) ? date : null;
}

async function readSearch(browser, { start, end }) {
  const page = await browser.newPage({ acceptDownloads: false });
  page.setDefaultTimeout(6500);
  try {
    const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!response?.ok() || new URL(page.url()).origin !== origin) throw new Error('public navigation failed');
    await page.getByRole('combobox').filter({ hasText: /^Rule$/ }).waitFor();
    for (const [index, date] of [start, end].entries()) {
      const field = page.getByLabel(index ? 'Issue Date To' : 'Issue Date From', { exact: true });
      await field.locator('xpath=ancestor::*[.//button][1]').getByRole('button', { name: 'Open Calendar', exact: true }).click();
      const day = page.getByRole('button', { name: dateControl(date), exact: true });
      if (!await day.count()) {
        const heading = await page.locator('button[aria-label^="Select "]').first().getAttribute('aria-label');
        const firstVisible = Date.parse(heading?.replace(/^Select \w+, /, '').replace(/(\d)(?:st|nd|rd|th) /, '$1 ') ?? '');
        if (!Number.isFinite(firstVisible)) throw new Error('calendar month unknown');
        const name = Date.parse(date + 'T00:00:00Z') < firstVisible ? 'PREVIOUS MONTH' : 'NEXT MONTH';
        await page.getByRole('button', { name, exact: true }).click();
      }
      await day.click();
      if (parseDate(await field.inputValue()) !== date) throw new Error('date selection mismatch');
    }
    const grid = page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Issue', exact: true }) });
    if (await grid.isVisible()) throw new Error('search results were present before submission');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await grid.waitFor({ state: 'visible', timeout: 14000 });
    const observation = await grid.evaluate((table, officialOrigin) => {
      const column = [...table.querySelectorAll('thead th')].findIndex(el => el.innerText.trim() === 'Issue');
      if (column < 0 || location.origin !== officialOrigin) throw new Error('grid identity changed');
      const rows = [...table.querySelectorAll('tbody tr')].filter(row => row.getClientRects().length && row.cells.length > column);
      return {
        displayed: rows.map(row => row.cells[column].innerText.trim()),
        officialRowCount: rows.filter(row => [...row.querySelectorAll('a[href]')].some(link =>
          new URL(link.href).origin === officialOrigin && new URL(link.href).pathname === '/rules-and-meetings')).length
      };
    }, origin);
    const explicitEmpty = observation.displayed.length === 0 &&
      await page.getByText('No items available', { exact: true }).isVisible();
    return { issueDates: observation.displayed.map(parseDate), officialRowCount: observation.officialRowCount, explicitEmpty };
  } finally {
    await page.close();
  }
}

let browser;
const envelope = await observeIssue({
  now: new Date(), sourceSha: process.env.GITHUB_SHA,
  readSearch: async window => {
    browser ??= await chromium.launch({ executablePath: process.env.TSR_CHROME_BIN || '/usr/bin/google-chrome', headless: true, timeout: 8000 });
    return readSearch(browser, window);
  }
});
await browser?.close();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(envelope));
