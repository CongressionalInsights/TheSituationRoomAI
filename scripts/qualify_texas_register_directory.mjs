import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const origin = 'https://www.sos.texas.gov';
const directory = `${origin}/texreg/index.shtml`;
const maxBytes = 1024 * 1024;

export function currentIssueDate(html) {
  const entries = Array.from(html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi), match=>match[1]);
  const matches = entries.flatMap(entry => {
    const match=entry.match(/<strong\b[^>]*>\s*Current Issue\s*\(([A-Z][a-z]+) (\d{1,2}), (20\d{2})\):\s*<\/strong>/);
    if (!match) return [];
    const label=match.slice(1).join(' ');
    const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
    if (!Number.isFinite(date.valueOf()) || label !== date.toLocaleDateString('en-US',{timeZone:'UTC',month:'long',day:'numeric',year:'numeric'}).replace(',','')) return [];
    const links=Array.from(entry.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi), m=>URL.parse(m[1], directory)?.href);
    return links.includes(`${origin}/texreg/sos/index.html`) && links.includes(`${origin}/texreg/pdf/currview/index.shtml`)
      ? [date.toISOString().slice(0,10)] : [];
  });
  return matches.length===1 ? matches[0] : null;
}

export async function readOfficialDirectory() {
  const observation = {route:directory,startedAt:new Date().toISOString()};
  try {
    const response=await fetch(directory,{redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{Accept:'text/html','User-Agent':'TheSituationRoomStateConnector/0.1 (+https://congressionalinsights.github.io/TheSituationRoomAI)'}});
    observation.status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      return {...observation,outcome:'http_error'};
    }
    if (!/^text\/html\b/i.test(response.headers.get('content-type')??'')) {
      await response.body?.cancel();
      return {...observation,outcome:'invalid_content_type'};
    }
    const chunks=[];
    let bytes=0;
    for await (const chunk of response.body) {
      bytes+=chunk.byteLength;
      if(bytes>maxBytes) return {...observation,outcome:'body_cap'};
      chunks.push(chunk);
    }
    const body=Buffer.concat(chunks);
    const date=currentIssueDate(body.toString('utf8'));
    return {...observation,bytes,date,fixtureSHA256:createHash('sha256').update(body).digest('hex'),
      outcome:date?'verified_publisher_current_issue':'no_unique_current_issue'};
  } catch {
    return {...observation,outcome:'transport_or_deadline'};
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
  const observation=process.argv[2] ?
    {date:currentIssueDate(readFileSync(process.argv[2],'utf8'))} : await readOfficialDirectory();
  console.log(JSON.stringify({officialDirectory:observation}));
  if (!process.argv[2]) {
    const {date,fixtureSHA256}=observation.outcome==='verified_publisher_current_issue' ? observation :
      {date:'2026-11-27',fixtureSHA256:'b1c04e26f5b775b30bc4c696e36d25ccc154bdeea5163b9b18fba4b07a67c57a'};
    writeFileSync('diagnostic-retained-current-parser.json',JSON.stringify({source:'Texas Register',date,fixtureSHA256,
      dateBasis:observation.outcome==='verified_publisher_current_issue'?'live_directory':'retained_control_only'}),{flag:'wx'});
  }
}
