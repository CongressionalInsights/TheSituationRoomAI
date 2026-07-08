import { absoluteUrl, dateFromTitle, extractAnchorDatePairs, makeSignal, rssItems, uniqueSignals } from './helpers.js';

const state = 'VA';
const stateName = 'Virginia';
const rulemakingUrl = 'https://register.dls.virginia.gov/rss.aspx';
const executiveOrdersUrl = 'https://www.governor.virginia.gov/executive-actions/';

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const text = await ctx.fetchText(rulemakingUrl);
    return rssItems(text).map((item) => makeSignal({
      id: `${state}:rulemaking:${item.title}`,
      title: `Virginia Register of Regulations: ${item.title}`,
      summary: item.summary || 'Virginia Register of Regulations issue.',
      url: absoluteUrl(item.url, rulemakingUrl),
      updatedAt: item.updatedAt || dateFromTitle(item.title),
      state,
      agency: item.agency || 'Virginia Code Commission',
      status: 'published',
      source: 'Virginia Register of Regulations',
      signalType: 'rulemaking'
    })).filter(Boolean);
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return uniqueSignals(extractAnchorDatePairs(html, {
      rowPattern: /<p class="eoselect">\s*<a[^>]+href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>[\s\S]*?<em>\s*(?<date>[^<]+)<\/em>/gi,
      baseUrl: executiveOrdersUrl,
      state,
      source: 'Governor of Virginia Executive Actions',
      signalType: 'executive_order',
      agency: 'Office of the Governor',
      status: 'issued'
    }));
  }
};
