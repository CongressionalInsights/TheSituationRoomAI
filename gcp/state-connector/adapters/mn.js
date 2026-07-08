import { absoluteUrl, cleanText, makeSignal, uniqueSignals } from './helpers.js';

const state = 'MN';
const stateName = 'Minnesota';
const registerIndexUrl = 'https://www.revisor.mn.gov/state_register/';
const executiveOrdersUrl = 'https://www.lrl.mn.gov/execorders/eoresults?gov=all';

export function parseCurrentRegisterVolume(html) {
  const match = html.match(/<td><a[^>]+href="(?<href>https:\/\/www\.revisor\.mn\.gov\/state_register\/(?<volume>\d+)\/)"[^>]*>Vol\.\s*(?<label>\d+)<\/a><\/td>\s*<td>(?<dates>[\s\S]*?)<\/td>\s*<td>(?<numbers>[\s\S]*?)<\/td>/i);
  if (!match) return null;
  return {
    url: match.groups.href,
    volume: cleanText(match.groups.volume),
    dates: cleanText(match.groups.dates),
    numbers: cleanText(match.groups.numbers)
  };
}

export function parseRegisterIssues(html, volumeUrl, volume) {
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

function tableCells(rowHtml) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
}

export function parseExecutiveOrderRows(html) {
  const rows = [];
  for (const row of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells = tableCells(row[0]);
    if (cells.length < 7) continue;
    const number = cleanText(cells[0]);
    const href = cells[2]?.match(/<a[^>]+href="(?<href>[^"]+)"/i)?.groups?.href || '';
    const title = cleanText(cells[3]);
    const dateSigned = cleanText(cells[5]);
    const dateFiled = cleanText(cells[6]);
    if (!title) continue;
    rows.push(makeSignal({
      id: `${state}:executive_order:${number}`,
      title,
      summary: `Minnesota executive order ${number}.`,
      url: absoluteUrl(href, executiveOrdersUrl),
      updatedAt: dateFiled || dateSigned,
      state,
      agency: 'Office of the Governor',
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
