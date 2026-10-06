import { absoluteUrl, cleanText, makeSignal, uniqueSignals } from './helpers.js';

const state = 'NC';
const stateName = 'North Carolina';
const registerUrl = 'https://www.oah.nc.gov/documents/north-carolina-register';
const executiveOrdersUrl = 'https://governor.nc.gov/news/executive-orders';

export function parseRegisterIssues(html) {
  const rows = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const issue = cleanText(row.match(/<td[^>]*views-field-name[^>]*>([\s\S]*?)<\/td>/i)?.[1] || '');
    const parts = issue.match(/^Volume\s+(\d+)\s+Issue\s+(\d+)$/i);
    const date = row.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] || '';
    const href = row.match(/<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i)?.[1] || '';
    if (!parts || !date || !href) continue;
    const url = absoluteUrl(href, registerUrl);
    if (new URL(url).hostname !== 'files.nc.gov') continue;
    rows.push(makeSignal({
      id: `${state}:rulemaking:${parts[1]}:${parts[2]}`,
      title: `North Carolina Register: ${issue}`,
      summary: 'North Carolina Register issue containing agency rulemaking notices.',
      url,
      updatedAt: date,
      state,
      agency: 'North Carolina Office of Administrative Hearings',
      status: 'published',
      source: 'North Carolina Register',
      signalType: 'rulemaking'
    }));
  }
  return uniqueSignals(rows);
}

export function parseExecutiveOrders(html) {
  const rows = [];
  for (const match of html.matchAll(/<tr\b[^>]*class=["'][^"']*nc-doc-row[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const link = row.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = cleanText(link?.[2] || '');
    const date = row.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] || '';
    if (!link || !date || !/\bExecutive Order\b/i.test(title) || /Council of State Concurrence|COS Concurrence/i.test(title)) continue;
    const url = absoluteUrl(link[1], executiveOrdersUrl);
    if (new URL(url).hostname !== 'governor.nc.gov') continue;
    rows.push(makeSignal({
      id: `${state}:executive_order:${new URL(url).pathname}`,
      title,
      summary: 'North Carolina governor executive order.',
      url,
      updatedAt: date,
      state,
      agency: 'Office of the Governor',
      status: 'issued',
      source: 'North Carolina Governor Executive Orders',
      signalType: 'executive_order'
    }));
  }
  return uniqueSignals(rows);
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const rows = parseRegisterIssues(await ctx.fetchText(registerUrl));
    if (!rows.length) throw new Error('No North Carolina Register issues found on official listing.');
    return rows;
  },
  async fetchExecutiveOrders(ctx) {
    const rows = parseExecutiveOrders(await ctx.fetchText(executiveOrdersUrl));
    if (!rows.length) throw new Error('No North Carolina executive orders found on official listing.');
    return rows;
  }
};
