import { absoluteUrl, cleanText, extractAnchorDatePairs, makeSignal, uniqueSignals } from './helpers.js';

const state = 'NY';
const stateName = 'New York';
const stateRegisterUrl = 'https://dos.ny.gov/state-register';
const executiveOrdersUrl = 'https://www.governor.ny.gov/executiveorders';

function parseStateRegister(html) {
  const results = [];
  for (const match of html.matchAll(/<article(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/article>/gi)) {
    const attrs = match.groups.attrs || '';
    if (!/teaser--type--webny-document/.test(attrs)) continue;
    const href = attrs.match(/\sabout="(?<href>[^"]+)"/i)?.groups?.href || '';
    const title = match.groups.body.match(/<a[^>]+href="[^"]+"[^>]*>\s*(?<title>[A-Z][^<]*?Vol\.[^<]+?)\s*<\/a>/i)?.groups?.title || '';
    const cleanTitle = cleanText(title);
    if (!href || !cleanTitle) continue;
    results.push(makeSignal({
      id: `${state}:rulemaking:${cleanTitle}`,
      title: `New York State Register: ${cleanTitle}`,
      summary: 'New York State Register issue covering rule making activities of state agencies.',
      url: absoluteUrl(href, stateRegisterUrl),
      updatedAt: cleanTitle.split('/')[0],
      state,
      agency: 'New York Department of State',
      status: 'published',
      source: 'New York State Register',
      signalType: 'rulemaking'
    }));
  }
  return uniqueSignals(results);
}

function parseExecutiveOrders(html) {
  const results = [];
  for (const match of html.matchAll(/<article[^>]+node--type-executive-order[\s\S]*?<h3 class="content-title">[\s\S]*?<a[^>]+href="(?<href>[^"]+)"[\s\S]*?<span[^>]+field--name-title[^>]*>(?<title>[\s\S]*?)<\/span>[\s\S]*?<div class="content-dates">[\s\S]*?<span[^>]*>\s*(?<date>[^<]+?)\s*<\/span>[\s\S]*?<div class="content-description[^"]*"[\s\S]*?<div[^>]+field--name-field-eo-meta-description[^>]*>(?<summary>[\s\S]*?)<\/div>/gi)) {
    const title = cleanText(match.groups.title);
    results.push(makeSignal({
      id: `${state}:executive_order:${title}`,
      title,
      summary: cleanText(match.groups.summary),
      url: absoluteUrl(match.groups.href, executiveOrdersUrl),
      updatedAt: match.groups.date,
      state,
      agency: 'Office of the Governor',
      status: 'issued',
      source: 'Governor of New York Executive Orders',
      signalType: 'executive_order'
    }));
  }
  if (results.length) return uniqueSignals(results);
  for (const match of html.matchAll(/<h3>\s*<a[^>]+href="(?<href>[^"]+)"[^>]*>\s*(?<title>[\s\S]*?)<\/a>\s*<\/h3>\s*<div[^>]*>\s*(?<date>[^<]+?)\s*<\/div>\s*<div[^>]*>\s*(?<summary>[\s\S]*?)<\/div>/gi)) {
    const title = cleanText(match.groups.title);
    results.push(makeSignal({
      id: `${state}:executive_order:${title}`,
      title,
      summary: cleanText(match.groups.summary),
      url: absoluteUrl(match.groups.href, executiveOrdersUrl),
      updatedAt: match.groups.date,
      state,
      agency: 'Office of the Governor',
      status: 'issued',
      source: 'Governor of New York Executive Orders',
      signalType: 'executive_order'
    }));
  }
  if (results.length) return uniqueSignals(results);
  return extractAnchorDatePairs(html, {
    rowPattern: /<a[^>]+href="(?<href>[^"]+)"[^>]*>\s*(?<title>No\.[^<]+)<\/a>[\s\S]{0,300}?(?<date>[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}[^<]*)/gi,
    baseUrl: executiveOrdersUrl,
    state,
    source: 'Governor of New York Executive Orders',
    signalType: 'executive_order',
    agency: 'Office of the Governor',
    status: 'issued'
  });
}

export default {
  state,
  stateName,
  async fetchRulemaking(ctx) {
    const html = await ctx.fetchText(stateRegisterUrl);
    return parseStateRegister(html);
  },
  async fetchExecutiveOrders(ctx) {
    const html = await ctx.fetchText(executiveOrdersUrl);
    return parseExecutiveOrders(html);
  }
};
