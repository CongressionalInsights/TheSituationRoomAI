import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';

const root = process.cwd();
const baseOrigin = 'http://127.0.0.1:5173';
const feedsConfig = JSON.parse(readFileSync(join(root, 'data', 'feeds.json'), 'utf8'));
const testFeeds = (feedsConfig.feeds || []).map((feed) => ({
  ...feed,
  isCustom: true,
  format: 'json'
}));
const testConfig = { ...feedsConfig, feeds: testFeeds };

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function readLocalFile(relativePath) {
  const filePath = join(root, relativePath);
  if (!existsSync(filePath)) return null;
  const body = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'text/plain; charset=utf-8';
  return { body, contentType };
}

function buildFeedPayload(feedId) {
  const feed = testFeeds.find((entry) => entry.id === feedId);
  if (!feed) {
    return {
      status: 404,
      payload: { error: 'unknown_feed', id: feedId }
    };
  }
  return {
    status: 200,
    payload: {
      id: feed.id,
      fetchedAt: Date.now(),
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        items: [
          {
            title: `${feed.name} sample`,
            url: '',
            summary: 'QA fixture',
            publishedAt: new Date().toISOString(),
            source: feed.name
          }
        ]
      }),
      httpStatus: 200
    }
  };
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch (err) {
    browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    });
  }
}
const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text();
    if (text.includes('Failed to load resource')) return;
    console.error(`[page console] ${text}`);
  }
});
page.on('pageerror', (err) => {
  console.error('[page error]', err);
});

await page.route('**/*', (route) => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.origin !== baseOrigin) {
    route.abort();
    return;
  }

  const pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/api/feeds') {
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(testConfig)
    });
    return;
  }

  if (pathname === '/api/feed') {
    const feedId = requestUrl.searchParams.get('id');
    const { status, payload } = buildFeedPayload(feedId);
    route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(payload)
    });
    return;
  }

  if (pathname === '/api/geocode') {
    const query = requestUrl.searchParams.get('q');
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ query, notFound: true })
    });
    return;
  }

  const assetPath = pathname === '/' ? 'public/index.html' : join('public', pathname.slice(1));
  const asset = readLocalFile(assetPath);
  if (asset) {
    route.fulfill({
      status: 200,
      contentType: asset.contentType,
      body: asset.body
    });
    return;
  }

  route.fulfill({
    status: 404,
    contentType: 'text/plain; charset=utf-8',
    body: 'Not Found'
  });
});

await page.goto(`${baseOrigin}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#healthValue', { timeout: 10000, state: 'attached' });

try {
  await page.click('#refreshNow', { timeout: 5000 });
} catch (err) {
  console.warn('Refresh button not clickable; continuing.');
}

let healthReady = true;
try {
  await page.waitForFunction(() => {
    const health = document.getElementById('healthValue');
    if (!health || !health.textContent) return false;
    const text = health.textContent.trim();
    return text.length && !text.includes('Initializing') && !text.includes('Fetching');
  }, { timeout: 20000 });
} catch (err) {
  healthReady = false;
}

let energyReady = true;
try {
  await page.waitForFunction(() => {
    const energyList = document.getElementById('energyList');
    if (!energyList) return false;
    const items = Array.from(energyList.querySelectorAll('.list-item'));
    return items.length >= 1;
  }, { timeout: 20000 });
} catch (err) {
  energyReady = false;
}

const results = await page.evaluate(() => {
  const listIds = {
    news: 'newsList',
    financeMarkets: 'financeMarketsList',
    financePolicy: 'financePolicyList',
    crypto: 'cryptoList',
    prediction: 'predictionList',
    hazards: 'disasterList',
    local: 'localList',
    policy: 'policyList',
    cyber: 'cyberList',
    agriculture: 'agricultureList',
    research: 'researchList',
    space: 'spaceList',
    energy: 'energyList',
    health: 'healthList',
    transport: 'transportList'
  };

  const panels = Object.fromEntries(Object.entries(listIds).map(([panel, id]) => {
    const list = document.getElementById(id);
    const items = list ? Array.from(list.querySelectorAll('.list-item')) : [];
    return [panel, { count: items.length, hasSignal: items.length > 0 }];
  }));

  const feedHealth = document.getElementById('healthValue');
  return {
    feedHealth: feedHealth ? feedHealth.textContent.trim() : '',
    panels
  };
});

console.log(JSON.stringify(results, null, 2));

const failures = Object.entries(results.panels)
  .filter(([, data]) => !data.hasSignal)
  .map(([panel]) => panel);
const energyCount = results.panels.energy?.count || 0;
const feedHealthy = results.feedHealth
  && !results.feedHealth.toLowerCase().includes('offline')
  && !results.feedHealth.toLowerCase().includes('error');

await browser.close();

if (failures.length || !feedHealthy || energyCount < 1 || !healthReady || !energyReady) {
  if (!feedHealthy) {
    console.error('Feed health check failed.');
  }
  if (!healthReady) {
    console.error('Feed health did not resolve within timeout.');
  }
  if (energyCount < 1) {
    console.error('Energy panel does not have signals.');
  }
  if (!energyReady) {
    console.error('Energy panel did not resolve within timeout.');
  }
  if (failures.length) {
    console.error(`Panels missing signals: ${failures.join(', ')}`);
  }
  process.exit(1);
}
