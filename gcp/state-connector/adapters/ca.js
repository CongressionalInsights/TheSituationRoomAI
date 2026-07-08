import { absoluteUrl, cleanText, extractAnchorDatePairs, makeSignal, rssItems, uniqueSignals } from './helpers.js';

const state = 'CA';
const stateName = 'California';
const noticeRegisterUrl = 'https://oal.ca.gov/california_regulatory_notice_online/';
const executiveOrdersUrl = 'https://www.gov.ca.gov/category/executive-orders/';

function parseNoticeRegisterMonths(html) {
  const results = [];
  const yearHeadingPattern = /(?<year>20\d{2})\s+California Regulatory Notice Register/gi;
  const headings = [...html.matchAll(yearHeadingPattern)];
  for (let index = 0; index < headings.length; index += 1) {
    const year = headings[index].groups.year;
    const sectionStart = headings[index].index;
    const sectionEnd = headings[index + 1]?.index || html.length;
    const section = html.slice(sectionStart, sectionEnd);
    for (const match of section.matchAll(/<a[^>]+href="(?<href>[^"]+)"[^>]*>\s*(?<month>January|February|March|April|May|June|July|August|September|October|November|December)\s*<\/a>/gi)) {
      const month = cleanText(match.groups.month);
      results.push(makeSignal({
        id: `${state}:rulemaking:${year}-${month}`,
        title: `California Regulatory Notice Register: ${month} ${year}`,
        summary: 'California Regulatory Notice Register monthly table of contents.',
        url: absoluteUrl(match.groups.href, noticeRegisterUrl),
        updatedAt: `${month} 1, ${year}`,
        state,
        agency: 'Office of Administrative Law',
        status: 'published',
        source: 'California Office of Administrative Law Notice Register',
        signalType: 'rulemaking'
      }));
    }
  }
  return uniqueSignals(results);
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const html = await ctx.fetchText(noticeRegisterUrl);
    return parseNoticeRegisterMonths(html);
  },
  async fetchExecutiveOrders(ctx) {
    const text = await ctx.fetchText(`${executiveOrdersUrl}feed/`);
    const fromFeed = rssItems(text)
      .filter((item) => /\bexecutive order\b|\bissues? order\b/i.test(`${item.title} ${item.summary}`))
      .map((item) => makeSignal({
        id: `${state}:executive_order:${item.title}`,
        title: item.title,
        summary: item.summary || 'California governor executive order update.',
        url: absoluteUrl(item.url, executiveOrdersUrl),
        updatedAt: item.updatedAt,
        state,
        agency: 'Office of the Governor',
        status: 'issued',
        source: 'Governor of California Executive Orders',
        signalType: 'executive_order'
      })).filter(Boolean);
    if (fromFeed.length) return uniqueSignals(fromFeed);
    const html = await ctx.fetchText(executiveOrdersUrl);
    return extractAnchorDatePairs(html, {
      rowPattern: /<a[^>]+href="(?<href>[^"]+)"[^>]*>\s*(?<title>[^<]*executive order[^<]*)<\/a>[\s\S]{0,600}?(?<date>[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/gi,
      baseUrl: executiveOrdersUrl,
      state,
      source: 'Governor of California Executive Orders',
      signalType: 'executive_order',
      agency: 'Office of the Governor',
      status: 'issued'
    });
  }
};
