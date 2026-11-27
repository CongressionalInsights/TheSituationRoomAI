import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { isDate, observeIssue, readPublishedIssue, searchUrl } from './texas-register-evidence.mjs';

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

async function readSearch(browser, { start, end }, trace) {
  const page = await browser.newPage({ acceptDownloads: false });
  page.setDefaultTimeout(6500);
  try {
    trace.phase('navigation');
    const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    trace.httpStatus = response?.status() ?? null;
    if (!response?.ok()) {
      trace.category = 'http_refusal';
      throw new Error('public navigation failed');
    }
    if (new URL(page.url()).origin !== origin) {
      trace.category = 'unexpected_origin';
      throw new Error('public navigation origin changed');
    }
    trace.phase('controls');
    // The Appian form may populate after the initial HTML has loaded.
    await page.getByRole('combobox').filter({ hasText: /^Rule$/ }).waitFor({ timeout: 14_000 });
    for (const [index, date] of [start, end].entries()) {
      trace.phase(index ? 'calendar_to' : 'calendar_from');
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
    trace.phase('submit');
    const grid = page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Issue', exact: true }) });
    if (await grid.isVisible()) throw new Error('search results were present before submission');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    trace.phase('results');
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

function searchTrace(search, initialPhase) {
  let phaseStarted = performance.now();
  let phase = initialPhase;
  const timingsMs = {};
  return {
    phase(next) {
      timingsMs[phase] = Math.round(performance.now() - phaseStarted);
      phase = next;
      phaseStarted = performance.now();
    },
    finish(error) {
      timingsMs[phase] = Math.round(performance.now() - phaseStarted);
      console.log(JSON.stringify({
        event: 'texas_register_search_trace', search, phase, timingsMs, httpStatus: this.httpStatus ?? null,
        outcome: error ? 'failed' : 'completed',
        category: error ? this.category ?? (error.name === 'TimeoutError' ? 'timeout' : 'unexpected_browser_or_page_state') : null
      }));
    }
  };
}

let browser;
let searches = 0;
const envelope = await observeIssue({
  now: new Date(), sourceSha: process.env.GITHUB_SHA,
  readPrevious: readPublishedIssue,
  readSearch: async window => {
    const trace = searchTrace(++searches, browser ? 'page_setup' : 'launch');
    let failure;
    try {
      // Hosted Chrome has hit the old 8s limit before navigation. Keep this budget specific to launch.
      if (!browser) {
        browser = await chromium.launch({ executablePath: process.env.TSR_CHROME_BIN || '/usr/bin/google-chrome', headless: true, timeout: 20_000 });
        trace.phase('page_setup');
      }
      return await readSearch(browser, window, trace);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      trace.finish(failure);
    }
  }
});
await browser?.close();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(envelope));
