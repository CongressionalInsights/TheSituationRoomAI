import { absoluteUrl, cleanText, makeSignal, uniqueSignals } from './helpers.js';

import { parsePagesIssue, pagesIssueUrl, officialSearchUrl } from './tx-search-issue.js';

const state = 'TX';
const stateName = 'Texas';
const executiveOrdersUrl = 'https://lrl.texas.gov/legeLeaders/governors/searchproc.cfm?govdoctypeID=5&governorID=45';

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

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const artifact = await ctx.fetchText(pagesIssueUrl, { maxBytes: 4096, redirect: 'error' });
    const issueDate = parsePagesIssue(artifact);
    if (!issueDate) throw new Error('Texas Register current public search evidence is unavailable or stale.');
    const day = new Date(issueDate + 'T00:00:00Z').toLocaleDateString('en-US', {
      timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric'
    });
    return [makeSignal({
      id: `${state}:rulemaking:${day}`,
      title: `Texas Register issue for ${day}`,
      summary: `Issue dated ${day}, verified in the Texas Secretary of State’s official Texas Register public search. This is one issue record.`,
      url: officialSearchUrl,
      updatedAt: issueDate,
      state,
      agency: 'Texas Secretary of State',
      status: 'published',
      source: 'Texas Register',
      signalType: 'rulemaking'
    })];
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrders(html);
  }
};
