import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';

const root = process.cwd();
const baseOrigin = 'http://127.0.0.1:5173';
const feedsConfig = JSON.parse(readFileSync(join(root, 'data', 'feeds.json'), 'utf8'));

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
  const feed = feedsConfig.feeds.find((entry) => entry.id === feedId);
  if (!feed) {
    return {
      status: 404,
      payload: { error: 'unknown_feed', id: feedId }
    };
  }
  const localPath = feed.localPath;
  if (!localPath) {
    return {
      status: 500,
      payload: { error: 'missing_fixture', id: feedId }
    };
  }
  const file = readLocalFile(localPath);
  if (!file) {
    return {
      status: 500,
      payload: { error: 'missing_fixture_file', id: feedId, path: localPath }
    };
  }
  return {
    status: 200,
    payload: {
      id: feed.id,
      fetchedAt: Date.now(),
      contentType: file.contentType,
      body: file.body.toString('utf8'),
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
      body: JSON.stringify(feedsConfig)
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

await page.waitForFunction(() => {
  const health = document.getElementById('feedHealth');
  return health && health.textContent && health.textContent.includes('All feeds are healthy');
}, { timeout: 10000 });

await page.waitForFunction(() => {
  const energyList = document.getElementById('energyList');
  if (!energyList) return false;
  const items = Array.from(energyList.querySelectorAll('.list-item'));
  return items.some((item) => !item.textContent.includes('No signals yet.')) && items.length >= 2;
}, { timeout: 10000 });

const results = await page.evaluate(() => {
  const listIds = {
    news: 'newsList',
    finance: 'financeList',
    crypto: 'cryptoList',
    hazards: 'disasterList',
    local: 'localList',
    policy: 'policyList',
    cyber: 'cyberList',
    agriculture: 'agricultureList',
    research: 'researchList',
    space: 'spaceList',
    energy: 'energyList',
    health: 'healthList',
    travel: 'travelList',
    transport: 'transportList'
  };

  const panels = Object.fromEntries(Object.entries(listIds).map(([panel, id]) => {
    const list = document.getElementById(id);
    const items = list ? Array.from(list.querySelectorAll('.list-item')) : [];
    const hasSignal = items.some((item) => !item.textContent.includes('No signals yet.'));
    return [panel, { count: items.length, hasSignal }];
  }));

  const feedHealth = document.getElementById('feedHealth');
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
const feedHealthy = results.feedHealth.includes('All feeds are healthy');

await browser.close();

if (failures.length || !feedHealthy || energyCount < 2) {
  if (!feedHealthy) {
    console.error('Feed health check failed.');
  }
  if (energyCount < 2) {
    console.error('Energy panel does not have multiple signals.');
  }
  if (failures.length) {
    console.error(`Panels missing signals: ${failures.join(', ')}`);
  }
  process.exit(1);
}
