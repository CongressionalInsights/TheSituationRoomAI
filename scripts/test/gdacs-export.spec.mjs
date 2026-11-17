import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const requireFromMcp = createRequire(new URL('../../gcp/mcp-proxy/server.js', import.meta.url));
const { XMLParser, XMLValidator } = requireFromMcp('fast-xml-parser');
const url = 'https://www.gdacs.org/contentdata/xml/rss.xml';
const paths = ['data/feeds.json','public/data/feeds.json','gcp/feed-proxy/feeds.json','gcp/mcp-proxy/feeds.json'];
const feed = JSON.parse(fs.readFileSync(paths[0])).feeds.find(f=>f.id==='gdacs-alerts');
// Synthetic field-complete RSS; not a retained provider body or a coverage claim.
const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:gdacs="http://www.gdacs.org" xmlns:georss="http://www.georss.org/georss"><channel><title>GDACS</title><link>https://www.gdacs.org</link><item><title>Synthetic earthquake</title><link>http://www.gdacs.org/report.aspx?eventid=1&amp;episodeid=2&amp;eventtype=EQ</link><description>Synthetic observation</description><pubDate>Tue, 17 Nov 2026 21:00:00 GMT</pubDate><gdacs:eventid>1</gdacs:eventid><gdacs:episodeid>2</gdacs:episodeid><gdacs:eventtype>EQ</gdacs:eventtype><gdacs:alertlevel>Green</gdacs:alertlevel><georss:point>10 20</georss:point></item></channel></rss>`;
function fn(s,n){const a=s.indexOf(`function ${n}(`);assert.ok(a>=0,n);return s.slice(a,s.indexOf('\n}',a)+2);}
test('GDACS publisher export is primary in all owning catalogs without changing recovery policy',()=>{
 for(const path of paths){const f=JSON.parse(fs.readFileSync(path)).feeds.find(f=>f.id===feed.id);assert.deepEqual(f,feed);assert.equal(f.url,url);assert.equal(f.format,'rss');assert.equal(f.timeoutMs,20000);assert.equal(f.ttlMinutes,30);assert.deepEqual(f.proxy,['allorigins','jina']);}
});
test('Feed and Pages preserve complete publisher XML and reject HTML before treating it as RSS',async()=>{
 for(const path of ['gcp/feed-proxy/server.js','scripts/build_static_cache.mjs']){
 const s=fs.readFileSync(path,'utf8');let calls=0;
 const c={Date,Math,normalizeContentType:undefined,buildFetchCandidates:u=>[u],fetchWithTimeout:async(u)=>{calls++;assert.equal(u,url);return {ok:true,status:200,headers:new Headers({'content-type':'application/xml'}),text:async()=>rss};}};
 vm.runInNewContext(['normalizeContentType','looksLikeHtmlDocument','looksLikeXmlFeed','isLikelyRssPayload'].map(n=>fn(s,n)).join('\n')+'\n'+s.slice(s.indexOf('async function fetchRssWithFallbacks('),s.indexOf('\n}',s.indexOf('async function fetchRssWithFallbacks('))+2)+'\nthis.fetchRss=fetchRssWithFallbacks;this.predicate=isLikelyRssPayload;',c);
 const r=await c.fetchRss(url,{},[],20000);assert.equal(calls,1);assert.equal(r.valid,true);assert.equal(r.body,rss);assert.equal(c.predicate('text/html','<html>JavaScript required</html>'),false);
 }
});
test('MCP existing RSS mapper retains publisher HTTP report link and real date without new identity requirements',()=>{
 assert.equal(XMLValidator.validate(rss),true);const s=fs.readFileSync('gcp/mcp-proxy/server.js','utf8');const c={xmlParser:new XMLParser({ignoreAttributes:false,attributeNamePrefix:''}),ensureArray:x=>Array.isArray(x)?x:[x],normalizeSummary:x=>x,Date};vm.runInNewContext(fn(s,'parseRss')+'\nthis.parse=parseRss;',c);
 const r=c.parse(rss,feed);assert.equal(r.length,1);assert.equal(r[0].url,'http://www.gdacs.org/report.aspx?eventid=1&episodeid=2&eventtype=EQ');assert.equal(r[0].publishedAt,Date.parse('2026-11-17T21:00:00Z'));assert.equal(r[0].source,'GDACS Alerts');
 const item=new XMLParser().parse(rss).rss.channel.item;for(const key of ['gdacs:eventid','gdacs:episodeid','gdacs:eventtype','gdacs:alertlevel','georss:point'])assert.ok(item[key]);
});
test('browser maps space-separated GeoRSS coordinates and keeps HTTP report links',()=>{
 const s=fs.readFileSync('public/app.js','utf8');
 const values={title:'Synthetic earthquake',link:'http://www.gdacs.org/report.aspx?eventid=1',pubDate:'Tue, 17 Nov 2026 21:00:00 GMT','georss:point':'10 20'};
 const item={getElementsByTagName:n=>values[n]?[{textContent:values[n]}]:[],querySelector:()=>({textContent:'Synthetic observation',innerHTML:'Synthetic observation'})};
 const c={DOMParser:class {parseFromString(){return {getElementsByTagName:n=>n==='item'?[item]:[]};}},normalizeSummary:()=>({summary:'Synthetic observation',summaryHtml:'Synthetic observation'}),Date};
 vm.runInNewContext(fn(s,'parseRss')+'\nthis.parse=parseRss;',c);
 const r=c.parse(rss,feed);assert.equal(r.length,1);assert.equal(r[0].geo.lat,10);assert.equal(r[0].geo.lon,20);assert.equal(r[0].url,values.link);assert.equal(r[0].source,'GDACS Alerts');assert.equal(r[0].publishedAt,Date.parse(values.pubDate));
 for(const point of ['10   20','10\t20','10\n20']){values['georss:point']=point;const x=c.parse(rss,feed)[0];assert.equal(x.geo.lat,10);assert.equal(x.geo.lon,20);}
});
