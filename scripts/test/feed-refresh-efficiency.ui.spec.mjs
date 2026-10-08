import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.env.TSR_REFRESH_EVIDENCE;
const evidenceFile = (file) => path.join(evidence, `${process.env.TSR_REFRESH_RUN ? `${process.env.TSR_REFRESH_RUN}-` : ''}${file}`);
test.skip(!evidence, 'Requires TSR_REFRESH_EVIDENCE with cached offline Leaflet package/dist.');
const base = 'c461548cbc7d7323e869923406d4bb90faa5d6b6';
let baselineBundle;
let server;
let origin;
test.beforeAll(async () => {
  baselineBundle = execFileSync('git', ['show', `${base}:public/app.bundle.js`], { cwd: root, maxBuffer: 2_000_000 });
  server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
    if (pathname.startsWith('/api/')) { response.writeHead(403); response.end('API forbidden by offline fixture'); return; }
    const file = path.resolve(root, 'public', `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(path.join(root, 'public') + path.sep)) { response.writeHead(403); response.end(); return; }
    try {
      const body = await fs.readFile(file);
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png' };
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`offline rendered baseline/candidate cadence ${viewport.width}`, async ({ browser }) => {
    const summaries = [];
    for (const version of ['baseline', 'candidate']) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const page = await context.newPage();
      const requests = [];
      const external = [];
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      let stage = 'initial';
      const registry = JSON.parse(await fs.readFile(path.join(root, 'data/feeds.json'), 'utf8'));
      const feeds = registry.feeds.filter((feed) => ['bbc-world', 'state-legislation', 'state-rulemaking', 'state-executive-orders'].includes(feed.id)).map((feed) => ({ ...feed, ttlMinutes: 10 }));
      expect(feeds).toHaveLength(4);
      await context.addInitScript(() => {
        window.SR_CONFIG = { staticMode: false };
        localStorage.setItem('situationRoomSettings', JSON.stringify({ refreshMinutes: 1, superMonitor: false, autoAi: false }));
        window.__fixtureNow = Date.parse('2026-10-07T12:00:00Z');
        Date.now = () => window.__fixtureNow;
        const interval = window.setInterval.bind(window);
        window.setInterval = (callback, delay, ...args) => {
          if (delay === 60_000) { window.__fixtureAutomatic = callback; return 987654; }
          return interval(callback, delay, ...args);
        };
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const json = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname === '/health') return json({ ok: true });
        if (url.pathname === '/data/denario.json') return json({ generatedAt: '2026-10-07T12:00:00Z', summary: 'Offline fixture', insights: [] });
        if (url.pathname === '/api/feeds') return json({ feeds });
        if (url.pathname === '/api/feed') {
          const payload = request.method() === 'POST' ? request.postDataJSON() : Object.fromEntries(url.searchParams);
          requests.push({ stage, ...payload });
          const fetchedAt = await page.evaluate(() => Date.now());
          const stateCode = payload.params?.state || (payload.params?.jurisdiction?.includes('state:ca/') ? 'CA' : 'NY');
          const body = payload.id === 'bbc-world'
            ? '<rss xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#"><channel><item><title>Fixture policy update</title><link>https://fixture.invalid/news</link><description>Offline fixture report</description><pubDate>Wed, 07 Oct 2026 11:55:00 GMT</pubDate><geo:lat>37.7</geo:lat><geo:long>-122.4</geo:long></item></channel></rss>'
            : JSON.stringify({ results: [{ id: `${payload.id}-${stateCode}`, title: `${stateCode} fixture government signal`, url: 'https://fixture.invalid/policy', summary: 'Offline fixture signal', updated_at: '2026-10-07T11:55:00Z', jurisdictionCode: stateCode, jurisdictionLevel: 'state', status: 'Open' }] });
          return json({ id: payload.id, httpStatus: 200, fetchedAt, body });
        }
        if (url.pathname.startsWith('/api/')) return json({ ok: true, items: [], features: [], error: 'fixture_unavailable', notFound: true });
        if (version === 'baseline' && /app\.bundle.*\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: baselineBundle });
        if (url.origin !== origin) {
          external.push({ url: request.url(), action: 'locally-fulfilled' });
          if (url.pathname.endsWith('/leaflet.js') || url.pathname.endsWith('/leaflet.css')) {
            const name = path.basename(url.pathname);
            return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css', body: await fs.readFile(path.join(evidence, 'package/dist', name)) });
          }
          if (request.resourceType() === 'script') return route.fulfill({ contentType: 'text/javascript', body: '' });
          if (url.hostname.endsWith('tile.openstreetmap.org')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce9e6"/><path d="M0 128H256M128 0V256" stroke="#b6cbc5"/><text x="20" y="30" fill="#526b63" font-size="12">OFFLINE MAP FIXTURE</text></svg>' });
          if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
          if (request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
          return json({ type: 'FeatureCollection', features: [] });
        }
        // Only static files reach the local server; no server-side provider route exists.
        return route.continue();
      });
      try {
        await page.goto(`${origin}/?debug=1`);
        await expect(page.locator('#refreshNow')).toBeEnabled();
        await page.waitForFunction(() => Boolean(window.__fixtureAutomatic && window.__SR_READY__));
        expect(await page.title()).toContain('Situation');
        expect(await page.locator('.panel[data-panel]').count()).toBeGreaterThan(5);
        const initial = await page.evaluate(() => ({ status: window.__SR_DEBUG__.state.feedStatus, items: window.__SR_DEBUG__.state.items.map(({ feedId, publishedAt }) => ({ feedId, publishedAt })) }));
        expect(requests).toHaveLength(4);
        stage = 'automatic-1m';
        await page.evaluate(async () => { window.__fixtureNow += 60_000; await window.__fixtureAutomatic(); });
        const automatic = await page.evaluate(() => ({ status: window.__SR_DEBUG__.state.feedStatus, items: window.__SR_DEBUG__.state.items.map(({ feedId, publishedAt }) => ({ feedId, publishedAt })) }));
        if (version === 'candidate') expect(automatic).toEqual(initial);
        stage = 'force-2m';
        await page.evaluate(() => { window.__fixtureNow += 60_000; });
        await page.locator('#refreshNow').click();
        await expect(page.locator('#refreshNow')).toBeEnabled();
        stage = 'state-CA-3m';
        await page.evaluate(() => { window.__fixtureNow += 60_000; });
        await page.locator('#statePanelSignalFilter').selectOption('CA');
        await expect(page.locator('#refreshNow')).toBeEnabled();
        await expect(page.locator('#statePanelFilterChip')).toContainText('California');
        stage = 'automatic-4m';
        await page.evaluate(async () => { window.__fixtureNow += 60_000; await window.__fixtureAutomatic(); });
        stage = 'expiry-13m';
        await page.evaluate(async () => { window.__fixtureNow += 9 * 60_000; await window.__fixtureAutomatic(); });
        const counts = Object.fromEntries(['initial', 'automatic-1m', 'force-2m', 'state-CA-3m', 'automatic-4m', 'expiry-13m'].map((name) => [name, requests.filter((entry) => entry.stage === name).length]));
        expect(counts).toEqual(version === 'candidate'
          ? { initial: 4, 'automatic-1m': 0, 'force-2m': 4, 'state-CA-3m': 3, 'automatic-4m': 0, 'expiry-13m': 4 }
          : { initial: 4, 'automatic-1m': 4, 'force-2m': 4, 'state-CA-3m': 3, 'automatic-4m': 4, 'expiry-13m': 4 });
        expect(requests.filter((entry) => entry.stage === 'force-2m').every((entry) => entry.force === true)).toBe(true);
        expect(requests.filter((entry) => entry.stage === 'state-CA-3m').every((entry) => entry.params?.state === 'CA'
          || entry.params?.jurisdiction === 'ocd-jurisdiction/country:us/state:ca/government')).toBe(true);
        const zoom = await page.evaluate(() => window.__SR_DEBUG__.state.map.getZoom());
        await page.locator('.leaflet-control-zoom-in').first().click();
        await expect.poll(() => page.evaluate(() => window.__SR_DEBUG__.state.map.getZoom())).toBe(zoom + 1);
        await page.locator('.panel-focus-btn').first().click();
        await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
        await page.locator('#focusClose').click();
        await expect(page.locator('#focusOverlay')).not.toHaveClass(/open/);
        await expect(page.locator('#healthValue')).toHaveText('Healthy');
        expect(errors).toEqual([]);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: evidenceFile(`${version}-${viewport.width}.png`), fullPage: false, animations: 'disabled' });
        await page.locator('#mapBase').scrollIntoViewIfNeeded();
        await page.screenshot({ path: evidenceFile(`${version}-${viewport.width}-map.png`), fullPage: false, animations: 'disabled' });
        await page.locator('.panel[data-panel="state-gov"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: evidenceFile(`${version}-${viewport.width}-state.png`), fullPage: false, animations: 'disabled' });
        summaries.push({ version, viewport, url: page.url(), counts, total: requests.length, requests, external, errors, initial, automatic, mapZoom: zoom + 1, feedHealth: 'Healthy' });
      } finally {
        await fs.writeFile(evidenceFile(`${version}-${viewport.width}-requests.json`), JSON.stringify({ summaries, requests, external, errors }, null, 2));
        await context.close();
      }
    }
    await fs.writeFile(evidenceFile(`comparison-${viewport.width}.json`), JSON.stringify(summaries, null, 2));
  });
}
