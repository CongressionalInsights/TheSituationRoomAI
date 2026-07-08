import { absoluteUrl, cleanText, makeSignal, rssItems, uniqueSignals } from './helpers.js';

const state = 'TX';
const stateName = 'Texas';
const registerFeedUrl = 'https://www.sos.state.tx.us/texreg/texreg.xml';
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
    const text = await ctx.fetchText(registerFeedUrl);
    return rssItems(text).map((item) => makeSignal({
      id: `${state}:rulemaking:${item.title}:${item.url}`,
      title: item.title === 'HTML format' ? `Texas Register: ${item.summary}` : `Texas Register: ${item.title}`,
      summary: item.summary || 'Texas Register issue.',
      url: absoluteUrl(item.url, registerFeedUrl),
      updatedAt: item.summary?.match(/[A-Z][a-z]+\s+\d{1,2},\s+\d{4}/)?.[0] || '',
      state,
      agency: 'Texas Secretary of State',
      status: 'published',
      source: 'Texas Register',
      signalType: 'rulemaking'
    })).filter(Boolean);
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrders(html);
  }
};
