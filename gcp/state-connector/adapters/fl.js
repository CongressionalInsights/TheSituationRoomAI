import { absoluteUrl, cleanText, extractAnchorDatePairs, makeSignal, uniqueSignals } from './helpers.js';

const state = 'FL';
const stateName = 'Florida';
const rulesUrl = 'https://flrules.org/';
const recentIssueUrl = 'https://flrules.org/gateway/recentIssue.asp';
const executiveOrdersUrl = 'https://www.flgov.com/eog/news/executive-orders/';

function parseRulemaking(html, recentIssueMeta = {}) {
  const issue = cleanText(html.match(/Most Recent FAR Issue[\s\S]{0,1200}/i)?.[0] || '');
  const issueId = html.match(/<input[^>]+name="Issue"[^>]+value="(?<issue>\d+)"/i)?.groups?.issue || '';
  const title = issue.match(/Vol\.\s*\d+[^A-Z]*(?:No\.\s*\d+)?/i)?.[0]
    || (issueId ? `Issue ${issueId}` : 'Most Recent Florida Administrative Register Issue');
  return [makeSignal({
    id: `${state}:rulemaking:${issueId || 'latest-far'}`,
    title: `Florida Administrative Register: ${title}`,
    summary: 'Most recent Florida Administrative Register issue and notices.',
    url: recentIssueMeta.url || recentIssueUrl,
    updatedAt: recentIssueMeta.lastModified || '',
    state,
    agency: 'Florida Department of State',
    status: 'published',
    source: 'Florida Administrative Register',
    signalType: 'rulemaking'
  })].filter(Boolean);
}

function parseExecutiveOrders(html) {
  const rows = [];
  for (const match of html.matchAll(/<td[^>]*class="[^"]*views-field-field-file-upload[^"]*"[^>]*>\s*<a[^>]+href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>[\s\S]*?<time[^>]+datetime="(?<date>[^"]+)"/gi)) {
    const title = cleanText(match.groups.title);
    rows.push(makeSignal({
      id: `${state}:executive_order:${title}`,
      title,
      summary: 'Florida governor executive order.',
      url: absoluteUrl(match.groups.href, executiveOrdersUrl),
      updatedAt: match.groups.date,
      state,
      agency: 'Executive Office of the Governor',
      status: 'issued',
      source: 'Florida Executive Office of the Governor Executive Orders',
      signalType: 'executive_order'
    }));
  }
  if (rows.length) return uniqueSignals(rows);
  return extractAnchorDatePairs(html, {
    rowPattern: /<a[^>]+href="(?<href>[^"]+\.pdf)"[^>]*>(?<title>#[^<]+)<\/a>[\s\S]{0,300}?datetime="(?<date>[^"]+)"/gi,
    baseUrl: executiveOrdersUrl,
    state,
    source: 'Florida Executive Office of the Governor Executive Orders',
    signalType: 'executive_order',
    agency: 'Executive Office of the Governor',
    status: 'issued'
  });
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const html = await ctx.fetchText(rulesUrl);
    const recentIssueMeta = await ctx.fetchHead(recentIssueUrl);
    return parseRulemaking(html, recentIssueMeta);
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrders(html);
  }
};
