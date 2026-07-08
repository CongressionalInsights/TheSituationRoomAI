import { absoluteUrl, cleanText, makeSignal, rssItems, uniqueSignals } from './helpers.js';

const state = 'TX';
const stateName = 'Texas';
const registerFeedUrl = 'https://www.sos.state.tx.us/texreg/texreg.xml';
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

export function parseRulemakingFeed(text) {
  const byIssueDate = new Map();
  for (const item of rssItems(text)) {
    const issueDate = issueDateFromTexasRegisterItem(item);
    if (!issueDate) continue;
    const current = byIssueDate.get(issueDate) || {
      issueDate,
      htmlUrl: '',
      pdfUrl: '',
      summary: `Texas Register issue for ${issueDate}.`
    };
    if (/pdf format/i.test(item.title)) {
      current.pdfUrl = absoluteUrl(item.url, registerFeedUrl);
    } else {
      current.htmlUrl = absoluteUrl(item.url, registerFeedUrl);
    }
    byIssueDate.set(issueDate, current);
  }

  const results = [];
  for (const issue of byIssueDate.values()) {
    if (!issue.htmlUrl) continue;
    const summary = issue.pdfUrl
      ? `${issue.summary} PDF rendering: ${issue.pdfUrl}`
      : issue.summary;
    results.push(makeSignal({
      id: `${state}:rulemaking:${issue.issueDate}`,
      title: `Texas Register issue for ${issue.issueDate}`,
      summary,
      url: issue.htmlUrl,
      updatedAt: issue.issueDate,
      state,
      agency: 'Texas Secretary of State',
      status: 'published',
      source: 'Texas Register',
      signalType: 'rulemaking'
    }));
  }
  return uniqueSignals(results);
}

function issueDateFromTexasRegisterItem(item) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const match = text.match(/\bTexas Register issue for (?<date>[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b/i);
  const issueDate = cleanText(match?.groups?.date || '');
  if (!issueDate) return '';
  const year = Number(issueDate.match(/\b(?<year>\d{4})$/)?.groups?.year || 0);
  if (!Number.isFinite(year) || year < minimumRegisterIssueYear) return '';
  return issueDate;
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const text = await ctx.fetchText(registerFeedUrl);
    return parseRulemakingFeed(text);
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrders(html);
  }
};
