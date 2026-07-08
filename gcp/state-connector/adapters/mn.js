import { absoluteUrl, cleanText, makeSignal, uniqueSignals } from './helpers.js';

const state = 'MN';
const stateName = 'Minnesota';
const registerIndexUrl = 'https://www.revisor.mn.gov/state_register/';
const executiveOrdersUrl = 'https://www.lrl.mn.gov/execorders/eoresults?gov=all';

function parseCurrentRegisterVolume(html) {
  const match = html.match(/<td><a[^>]+href="(?<href>https:\/\/www\.revisor\.mn\.gov\/state_register\/(?<volume>\d+)\/)"[^>]*>Vol\.\s*(?<label>\d+)<\/a><\/td>\s*<td>(?<dates>[\s\S]*?)<\/td>\s*<td>(?<numbers>[\s\S]*?)<\/td>/i);
  if (!match) return null;
  return {
    url: match.groups.href,
    volume: cleanText(match.groups.volume),
    dates: cleanText(match.groups.dates),
    numbers: cleanText(match.groups.numbers)
  };
}

function parseRegisterIssues(html, volumeUrl, volume) {
  const rows = [];
  for (const match of html.matchAll(/<tr>\s*<td><a[^>]+href="(?<href>https:\/\/www\.revisor\.mn\.gov\/state_register\/\d+\/(?<number>\d+)\/)"[^>]*>[\s\S]*?<\/a><\/td>\s*<td>(?<date>[\s\S]*?)<\/td>\s*<td>(?<pages>[\s\S]*?)<\/td>\s*<\/tr>/gi)) {
    const number = cleanText(match.groups.number);
    const date = cleanText(match.groups.date);
    rows.push(makeSignal({
      id: `${state}:rulemaking:${volume}:${number}`,
      title: `Minnesota State Register: Volume ${volume}, Number ${number}`,
      summary: `Minnesota State Register issue ${number}; pages ${cleanText(match.groups.pages)}.`,
      url: absoluteUrl(match.groups.href, volumeUrl),
      updatedAt: date,
      state,
      agency: 'Minnesota Department of Administration',
      status: 'published',
      source: 'Minnesota State Register',
      signalType: 'rulemaking'
    }));
  }
  return uniqueSignals(rows);
}

function parseExecutiveOrderRows(html) {
  const rows = [];
  for (const row of html.matchAll(/<tr>\s*<td>\s*<span[^>]*>(?<number>[^<]+)<\/span>[\s\S]*?<a[^>]+href="(?<href>[^"]+)"[\s\S]*?<\/a>\s*<\/td><td>(?<title>[\s\S]*?)<\/td><td>[\s\S]*?<\/td><td>\s*<span[^>]*>(?<dateSigned>[^<]+)<\/span>[\s\S]*?<\/td><td>\s*<span[^>]*>(?<dateFiled>[^<]+)<\/span>[\s\S]*?<\/td>[\s\S]*?<td>(?<governor>[^<]+)<\/td>/gi)) {
    const title = cleanText(row.groups.title);
    if (!title) continue;
    rows.push(makeSignal({
      id: `${state}:executive_order:${cleanText(row.groups.number)}`,
      title,
      summary: `Minnesota executive order ${cleanText(row.groups.number)}.`,
      url: absoluteUrl(row.groups.href, executiveOrdersUrl),
      updatedAt: row.groups.dateFiled || row.groups.dateSigned,
      state,
      agency: cleanText(row.groups.governor) || 'Office of the Governor',
      status: 'issued',
      source: 'Minnesota Legislative Reference Library Executive Orders',
      signalType: 'executive_order'
    }));
  }
  return uniqueSignals(rows);
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const index = await ctx.fetchText(registerIndexUrl);
    const currentVolume = parseCurrentRegisterVolume(index);
    if (!currentVolume?.url) return [];
    const volumeHtml = await ctx.fetchText(currentVolume.url);
    return parseRegisterIssues(volumeHtml, currentVolume.url, currentVolume.volume);
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrderRows(html);
  }
};
