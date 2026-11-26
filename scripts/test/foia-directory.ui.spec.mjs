import { test, expect } from '@playwright/test';

const now = new Date('2026-11-26T15:00:00Z');
const date = '2026-11-25T15:00:00Z';
const component = (title, attributes = {}) => ({
  type: 'agency_component',
  attributes: { title, ...attributes },
  links: { self: { href: `https://api.foia.gov/api/agency_components/${title.toLowerCase()}?resourceVersion=fixture` } }
});
const dataset = (title, metadata_modified) => ({ title, name: title.toLowerCase(), metadata_modified });

const formats = [
  { name: 'FOIA JSON:API directory', body: { data: [component('Undated'), component('Invalid', { updated_at: 'bad' }),
    component('Dated', { updated_at: 'bad', created_at: date }), component('Outsidewindow', { updated_at: '2020-03-02T00:00:00Z' })] },
    undatedLink: 'https://api.foia.gov/api/agency_components/undated' },
  { name: 'CKAN directory fallback', body: { result: { results: [
    dataset('Undated'), dataset('Invalid', 'bad'), dataset('Dated', date), dataset('Outsidewindow', '2020-03-02T00:00:00Z')
  ] } }, undatedLink: 'https://catalog.data.gov/dataset/undated' }
];

async function openPolicyPanel(page, body) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(now);
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/feeds') return route.fulfill({ json: { app: {}, feeds: [
      { id: 'foia-api', name: 'FOIA.gov API', category: 'gov', format: 'json', url: 'https://api.foia.gov/api/agency_components', tags: ['us', 'gov'] }
    ] } });
    if (url.pathname === '/api/feed') {
      expect(req.postDataJSON().id).toBe('foia-api');
      return route.fulfill({ json: { httpStatus: 200, fetchedAt: Number(now), body: JSON.stringify(body) } });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], items: [] } });
    return route.continue();
  });
  await page.goto('/');
  const policy = page.locator('[data-panel="policy"]');
  await expect(policy.getByText('Undated', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  return policy;
}

for (const format of formats) {
  test(`${format.name} preserves real dates and labels unknown dates in Policy & Government`, async ({ page }) => {
    const policy = await openPolicyPanel(page, format.body);
    const row = title => policy.locator('.list-item').filter({ has: page.getByText(title, { exact: true }) });
    await expect(row('Undated').locator('.list-meta')).toContainText('Record date unavailable');
    await expect(row('Invalid').locator('.list-meta')).toContainText('Record date unavailable');
    await expect(row('Dated').locator('.list-meta')).toContainText('1d ago');
    await expect(row('Outsidewindow')).toHaveCount(0);
    await expect(policy.getByRole('link', { name: 'Undated', exact: true })).toHaveAttribute('href', format.undatedLink);
  });
}

test('A FOIA-only undated policy panel does not treat fetch time as a source update', async ({ page }) => {
  const policy = await openPolicyPanel(page, { data: [component('Undated')] });
  await expect(policy.locator('[data-panel-update="policy"]')).toHaveText('Updated --');
});
