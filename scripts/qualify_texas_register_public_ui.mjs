import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.env.TSR_PLAYWRIGHT_ROOT || '.', 'package.json'));
const { chromium } = require('playwright');
const cwd = process.cwd();
const url = 'https://texas-sos.appianportalsgov.com/rules-and-meetings?interface=SEARCH_TEXAS_REGISTER';
const issuer = new URL(url).origin;
const dateEvidence = JSON.parse(readFileSync(resolve(cwd, 'diagnostic-retained-current-parser.json')));
assert.equal(dateEvidence.source, 'Texas Register');
const date = dateEvidence.date;
assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
const when = new Date(`${date}T00:00:00Z`);
assert.equal(when.toISOString().slice(0,10),date);
const [year,month,day]=date.split('-');
const [weekday, monthName]=['weekday','month'].map(key=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',[key]:'long'}).format(when));
const dayNumber=Number(day);
const suffix=dayNumber%100>=11&&dayNumber%100<=13?'th':({1:'st',2:'nd',3:'rd'}[dayNumber%10]??'th');
const dayLabel=`Select ${weekday}, ${monthName} ${dayNumber}${suffix} ${year}`;
const report={url,sourceDate:date,sourceDateEvidence:dateEvidence.fixtureSHA256,dateBasis:dateEvidence.dateBasis,startedAt:new Date().toISOString(),searchSubmissions:0,
  egress:process.env.TSR_EXISTING_WORKSPACE_PROXY==='1'?'existing_workspace_proxy':'runner_default', stage:'launch'};
const record=(name)=>writeFileSync(resolve(cwd,name),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
record('appian-exact-date-browser-intent.json');
let browser;
try {
  browser=await chromium.launch({ headless:true, executablePath:process.env.TSR_CHROME_BIN||'/usr/bin/google-chrome',
    timeout:10000, ...(process.env.TSR_EXISTING_WORKSPACE_PROXY==='1'?{proxy:{server:process.env.HTTPS_PROXY}}:{}) });
  report.browserVersion=browser.version();
  const page=await browser.newPage({acceptDownloads:false});
  page.setDefaultTimeout(7000);
  report.stage='navigate';
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});
  report.httpStatus=response?.status()??null;
  assert.ok(response?.ok()&&new URL(page.url()).origin===issuer);
  report.stage='public_rule_form';
  const rule=page.getByRole('combobox').filter({hasText:/^Rule$/});
  await rule.waitFor();
  for (const label of ['Issue Date From','Issue Date To']) {
    report.stage=label.endsWith('From')?'calendar_from':'calendar_to';
    const input=page.getByLabel(label,{exact:true});
    const button=input.locator('xpath=ancestor::*[.//button][1]').getByRole('button',{name:'Open Calendar',exact:true});
    await button.click();
    await page.getByRole('button',{name:dayLabel,exact:true}).click();
    assert.equal(await input.inputValue(),`${month}/${day}/${year}`);
  }
  report.stage='public_search';
  await page.getByRole('button',{name:'Search',exact:true}).click();
  report.searchSubmissions=1;
  report.stage='verify_visible_issue_dates';
  const displayed=[`${month}/${day}/${year}`,`${Number(month)}/${dayNumber}/${year}`];
  await page.waitForFunction(dates=>[...document.querySelectorAll('tr,[role="row"]')].some(row=>
    [...row.querySelectorAll('td,[role="gridcell"]')].some(cell=>dates.includes(cell.innerText.trim()))),
    displayed, {timeout:16000}).catch(()=>{});
  report.result=await page.evaluate(({displayed,issuer})=>{
    const rows=[...new Set(document.querySelectorAll('tr,[role="row"]'))].filter(row=>row.getClientRects().length>0);
    const grids=rows.map(row=>({
      matches:[...row.querySelectorAll('td,[role="gridcell"]')].some(cell=>displayed.includes(cell.innerText.trim())),
      linked:[...row.querySelectorAll('a[href]')].some(a=>{
        const u=new URL(a.href);
        return u.protocol==='https:'&&(u.origin===issuer || ['www.sos.texas.gov','www.sos.state.tx.us'].includes(u.hostname));
      }),
      dateCells:[...row.querySelectorAll('td,[role="gridcell"]')].map(cell=>cell.innerText.trim()).filter(s=>/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s))
    }));
    return {visibleRows:grids.length,matchedDateRows:grids.filter(x=>x.matches).length,officialAnchoredRows:grids.filter(x=>x.matches&&x.linked).length,
      renderedDateCells:[...new Set(grids.flatMap(x=>x.dateCells))].slice(0,8)};
  },{displayed,issuer});
  assert.ok(report.result.matchedDateRows>0 && report.result.matchedDateRows===report.result.officialAnchoredRows);
  report.stage='verified_exact_issue_date';
} catch {
  report.failure=report.stage;
} finally {
  await browser?.close();
  report.finishedAt=new Date().toISOString();
  record('appian-exact-date-browser-result.json');
  console.log(JSON.stringify(report,null,2));
}
process.exitCode=report.failure?1:0;
