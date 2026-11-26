import { absoluteUrl, cleanText, isoDate, makeSignal, uniqueSignals } from './helpers.js';

const state = 'TX';
const stateName = 'Texas';
export const currentIssueUrl = 'https://www.sos.texas.gov/texreg/sos/index.html';
const executiveOrdersUrl = 'https://lrl.texas.gov/legeLeaders/governors/searchproc.cfm?govdoctypeID=5&governorID=45';
const minimumRegisterIssueYear = 2024;

export function parseExecutiveOrders(html) {
  const results = [];
  for (const row of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const block = row[0];
    if (!/Executive order/i.test(block)) continue;
    const link = block.match(/<a[^>]+href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>/i);
    if (!link) continue;
    const text = cleanText(block);
    const date = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}\b/i)?.[0]
      || text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0]
      || '';
    const title = cleanText(link.groups.title);
    results.push(makeSignal({
      id: `${state}:executive_order:${title}`,
      title,
      summary: 'Texas governor executive order.',
      url: absoluteUrl(link.groups.href, executiveOrdersUrl),
      updatedAt: date,
      state,
      agency: 'Office of the Governor',
      status: 'issued',
      source: 'Texas Legislative Reference Library Governor Documents',
      signalType: 'executive_order'
    }));
  }
  return uniqueSignals(results);
}

function parseCurrentIssue(html) {
  const header = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '';
  const issueDate = cleanText(header.match(/<span\b[^>]*\bname=["']headerDate["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const publishedDate = isoDate(issueDate);
  const normalizedDate = publishedDate && new Date(publishedDate).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric'
  });
  if (!issueDate || issueDate !== normalizedDate || title !== `Texas Register ${issueDate}`
      || Number(publishedDate.slice(0, 4)) < minimumRegisterIssueYear) return [];

  const folder = `/texreg/archive/${issueDate.replace(/[ ,]/g, '')}/`;
  const officialOrigin = new URL(currentIssueUrl).origin;
  const links = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi);
  const hasIssueContents = Array.from(links).some(([, href]) => {
    try {
      const url = new URL(href, currentIssueUrl);
      return url.origin === officialOrigin && url.pathname.startsWith(folder)
        && url.pathname !== `${folder}index.html` && url.pathname.endsWith('.html');
    } catch {
      return false;
    }
  });
  if (!hasIssueContents) return [];

  return [makeSignal({
    id: `${state}:rulemaking:${issueDate}`,
    title: `Texas Register issue for ${issueDate}`,
    summary: `Texas Register issue for ${issueDate}.`,
    url: new URL(`${folder}index.html`, currentIssueUrl).href,
    updatedAt: publishedDate,
    state,
    agency: 'Texas Secretary of State',
    status: 'published',
    source: 'Texas Register',
    signalType: 'rulemaking'
  })];
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const html = await ctx.fetchText(currentIssueUrl);
    const issues = parseCurrentIssue(html);
    if (!issues.length) throw new Error('Texas Register has no dated issue table of contents.');
    return issues;
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrders(html);
  }
};
