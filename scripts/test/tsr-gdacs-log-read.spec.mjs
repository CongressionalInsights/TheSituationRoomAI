import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { contract, validateInputs, readArgs, sanitizeEntries, prepare, executeRead, finalize, safeNativeFailure } from '../read_tsr_gdacs_logs.mjs';
const sha='a'.repeat(40), now=Date.parse('2026-11-16T15:00:00Z');
const env={GITHUB_REPOSITORY:contract.repository,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',GITHUB_SHA:sha,EXPECTED_SHA:sha,APPROVAL_REF:'tsr-log-fixture-not-real-authority',START_UTC:'2026-11-16T14:45:00Z',END_UTC:'2026-11-16T14:50:00Z',GOOGLE_GHA_CREDS_PATH:'/fixture/identity.json'};
const entry={timestamp:'2026-11-16T14:46:57.560641Z',resource:{labels:{service_name:'situation-room-feed',revision_name:contract.revisions['situation-room-feed']}},jsonPayload:{event:'gdacs_primary_failure',feedId:'gdacs-alerts',errorClass:'invalid_response',upstreamStatus:200,bodyCharacterCount:5706,xmlContentTypeHint:false,htmlDocumentHint:true,body:'PRIVATE_BODY',headers:{cookie:'PRIVATE_COOKIE'},title:'PRIVATE_TITLE',cause:'PRIVATE_CAUSE'}};
function fixture(t, options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tsr-log-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 prepare(dir,env,sha,now);const calls=[];const properties={'core/should_prompt_to_enable_api':'false','auth/credential_file_override':'/fixture/identity.json',...(options.properties||{})};
 const run=(cmd,args,opts)=>{calls.push({cmd,args,opts});assert.equal(cmd,'gcloud');if(args[0]==='config')return{status:0,stdout:properties[args[2]]||'',stderr:'PRIVATE_STDERR'};assert.equal(args[0],'logging');assert.ok(fs.existsSync(path.join(dir,'read-intent.json')));return options.response||{status:0,stdout:JSON.stringify(options.rows??[entry]),stderr:'PRIVATE_STDERR'};};
 const readFile=file=>{assert.equal(file,'/fixture/identity.json');return JSON.stringify({type:'service_account',client_email:options.principal||contract.principal,private_key:'PRIVATE_FAKE_KEY'});};
 return{dir,calls,run,readFile,args:{run,readFile,now:()=>now}};
}
test('Log-only workflow is manual/main bound and validates before existing credential action',()=>{
 const s=fs.readFileSync('.github/workflows/read-tsr-gdacs-logs.yml','utf8');assert.doesNotMatch(s,/\n  (push|pull_request|schedule):/);assert.match(s,/contents: read/);assert.doesNotMatch(s,/id-token: write|contents: write|gcloud run deploy|workflow run|secrets\.DATA_GOV/);
 assert.ok(s.indexOf('read_tsr_gdacs_logs.mjs prepare')<s.indexOf('google-github-actions/auth@v3'));
 assert.ok(s.indexOf('node --test scripts/test/tsr-gdacs-log-read.spec.mjs')<s.indexOf('google-github-actions/auth@v3'));
 assert.match(s,/credentials_json: \$\{\{ secrets.GCP_SA_KEY \}\}/);assert.match(s,/persist-credentials: false/);assert.match(s,/if: always\(\)/);
 assert.ok(!s.includes('/tmp/tsr-gdacs-log-read/*.json'),'upload explicit sanitized receipts only');
});
test('Inputs reject changed source, repository/ref/event, reruns, injection, impossible/future/oversized windows',()=>{
 assert.equal(validateInputs(env,sha,now).sourceSha,sha);
 for(const change of [{EXPECTED_SHA:'b'.repeat(40)},{GITHUB_REPOSITORY:'foreign/repo'},{GITHUB_REF:'refs/heads/other'},{GITHUB_EVENT_NAME:'push'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_RUN_ID:'abc'},{APPROVAL_REF:'role" OR true'},{START_UTC:'2026-02-30T14:45:00Z'},{END_UTC:'2026-11-16T14:45:00Z'},{END_UTC:'2026-11-16T15:01:00Z'},{END_UTC:'2026-11-16T14:45:00Z" OR true'}])assert.throws(()=>validateInputs({...env,...change},sha,now));
 assert.throws(()=>validateInputs(env,'b'.repeat(40),now));
});
test('Fixed read cannot expand project, service/revision, event, row bound or selected diagnostic fields',()=>{
 const a=readArgs(validateInputs(env,sha,now));assert.equal(a[0],'logging');assert.equal(a[1],'read');assert.ok(a.includes('--project=situationroom-ai-20260112'));assert.ok(a.includes('--limit=10'));assert.ok(a[2].includes('jsonPayload.event="gdacs_primary_failure"'));for(const rev of Object.values(contract.revisions))assert.ok(a[2].includes(rev));assert.doesNotMatch(a.at(-2),/textPayload|headers|body,|cookie|secret/i);assert.doesNotMatch(a.join(' '),/enable|set-iam|deploy|access-token/);
});
test('Successful actual read adapter has one logging command, bounded subprocess, exact-once receipt and no private text',t=>{
 const f=fixture(t),r=executeRead(f.dir,env,sha,f.args);assert.equal(r.state,'completed_sanitized');assert.equal(r.logicalReadAttempts,1);assert.equal(r.entries.length,1);assert.equal(r.entries[0].diagnostic.bodyCharacterCount,5706);assert.equal(r.identity.principal,contract.principal);
 const calls=f.calls.filter(x=>x.args[0]==='logging');assert.equal(calls.length,1);assert.equal(calls[0].opts.timeout,30000);assert.equal(calls[0].opts.maxBuffer,65536);assert.equal(calls[0].opts.env.CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API,'false');
 assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'result.json'),'utf8'),/PRIVATE_|body"|headers|cause|title|private_key/);assert.throws(()=>executeRead(f.dir,env,sha,f.args));assert.equal(f.calls.filter(x=>x.args[0]==='logging').length,1);
});
test('Wrong existing identity, impersonation or conflicting credential binding refuses before log read',t=>{
 for(const options of [{principal:'foreign@example.invalid'},{properties:{'auth/impersonate_service_account':'foreign'}},{properties:{'auth/credential_file_override':'/other/file'}}]){
  const f=fixture(t,options);const r=executeRead(f.dir,env,sha,f.args);assert.equal(r.state,'identity_or_local_validation_refusal');assert.equal(r.logicalReadAttempts,0);assert.ok(!f.calls.some(x=>x.args[0]==='logging'));assert.doesNotMatch(JSON.stringify(r),/foreign|PRIVATE_|\/other/);
 }
});
test('Native refusal, timeout, output cap, malformed JSON and too many rows remain terminal without retry',t=>{
 for(const response of [{status:1,stdout:'PRIVATE_BODY',stderr:'PRIVATE_KEY'},{status:null,error:{code:'ETIMEDOUT'},stdout:''},{status:null,error:{code:'ENOBUFS'},stdout:''},{status:0,stdout:'PRIVATE_INVALID'},{status:0,stdout:JSON.stringify(Array(11).fill(entry))},{status:0,stdout:' '.repeat(65537)}]){
  const f=fixture(t,{response}),r=executeRead(f.dir,env,sha,f.args);assert.equal(r.state,'read_failed_or_uncertain');assert.equal(r.logicalReadAttempts,1);assert.equal(f.calls.filter(x=>x.args[0]==='logging').length,1);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|stderr|stack/);assert.throws(()=>executeRead(f.dir,env,sha,f.args));
 }
});
test('Unrecognized rows never leak labels, payload or forged timestamp and do not imply complete observation',()=>{
 const request=validateInputs(env,sha,now);for(const mutate of [x=>x.resource.labels.service_name='PRIVATE_FOREIGN',x=>x.resource.labels.revision_name='PRIVATE_REVISION',x=>x.timestamp='PRIVATE_DATE',x=>x.timestamp='2026-11-16T12:00:00Z',x=>x.jsonPayload.event='PRIVATE_EVENT']){
  const x=structuredClone(entry);mutate(x);const r=sanitizeEntries([x],request);assert.equal(r.unrecognizedMatchingRecords,1);assert.equal(r.entries.length,0);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
 }
});
test('Empty result is honest; unknown transport values cannot become private output',t=>{
 const f=fixture(t,{rows:[]}),r=executeRead(f.dir,env,sha,f.args);assert.equal(r.entries.length,0);assert.equal(r.state,'completed_sanitized');assert.equal(r.providerCalls,0);
 const x=structuredClone(entry);x.jsonPayload.transportCode='PRIVATE_CODE';x.jsonPayload.upstreamStatus=null;assert.equal(sanitizeEntries([x],validateInputs(env,sha,now)).entries[0].diagnostic.transportCode,null);
});
test('Prior uncertain read intent or changed request blocks a new command',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'read-intent.json'),'{}');assert.throws(()=>executeRead(f.dir,env,sha,f.args));assert.equal(f.calls.length,0);
 const g=fixture(t);const x=JSON.parse(fs.readFileSync(path.join(g.dir,'request.json')));x.sourceSha='b'.repeat(40);fs.writeFileSync(path.join(g.dir,'request.json'),JSON.stringify(x));assert.throws(()=>executeRead(g.dir,env,sha,g.args));assert.equal(g.calls.length,0);
});
test('Finalize retains no-read or interrupted-uncertain state without command or overwrite',t=>{
 for(const attempted of [false,true]){const f=fixture(t);if(attempted)fs.writeFileSync(path.join(f.dir,'read-intent.json'),'{}');finalize(f.dir);const file=path.join(f.dir,'result.json'),before=fs.readFileSync(file,'utf8');assert.equal(JSON.parse(before).state,attempted?'interrupted_uncertain_no_replay':'not_read_auth_or_prior_step_failed');finalize(f.dir);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(f.calls.length,0);}
});
test('Actual CLI refuses invalid pre-auth input without reading key or invoking gcloud',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tsr-log-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const run=spawnSync(process.execPath,['scripts/read_tsr_gdacs_logs.mjs','prepare',dir],{env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',...env,EXPECTED_SHA:'wrong'},encoding:'utf8'});assert.notEqual(run.status,0);assert.match(run.stderr,/validation refused/);assert.ok(!fs.existsSync(path.join(dir,'request.json')));
});

test('Fixed CLI and structured SDK refusal identifiers survive without private error details',()=>{
 for(const [id,hint] of Object.entries({PERMISSION_DENIED:'permission_denied',UNAUTHENTICATED:'unauthenticated',SERVICE_DISABLED:'service_disabled',INVALID_ARGUMENT:'invalid_argument',NOT_FOUND:'not_found',RESOURCE_EXHAUSTED:'quota',DEADLINE_EXCEEDED:'deadline_exceeded',UNAVAILABLE:'unavailable'})){
  for(const stderr of [`ERROR: (gcloud.logging.read) ${id}: PRIVATE_KEY PRIVATE_URL`, `  reason: ${id}`, `  "reason": "${id}",`]){
   assert.deepEqual(safeNativeFailure({status:1,stderr}),{exitStatus:1,signal:null,refusalHints:[hint]});
  }
 }
});
test('Unstructured hostile text, arbitrary codes, headers and signals never escape',()=>{
 for(const stderr of ['PRIVATE_KEY PERMISSION_DENIED','Authorization: PRIVATE_TOKEN','ERROR: (gcloud.run.deploy) PERMISSION_DENIED: PRIVATE_TEXT','reason: PRIVATE_REASON','reason: SERVICE_DISABLED PRIVATE_KEY','"reason": "PERMISSION_DENIED_PRIVATE"']){
  const r=safeNativeFailure({status:'PRIVATE_STATUS',signal:'PRIVATE_SIGNAL',error:{code:'PRIVATE_CODE',message:'PRIVATE_MESSAGE',stack:'PRIVATE_STACK'},stderr});
  assert.deepEqual(r,{exitStatus:null,signal:null,refusalHints:[]});assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
 }
});
test('Spawn failure exit and signal are bounded; no unobserved Google permission inference',()=>{
 assert.deepEqual(safeNativeFailure({status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'}}),{exitStatus:null,signal:'SIGTERM',refusalHints:['command_timeout']});
 assert.deepEqual(safeNativeFailure({status:1,stderr:'unknown failure'}),{exitStatus:1,signal:null,refusalHints:[]});
 for(const [code,hint] of [['ENOBUFS','selected_output_cap'],['ENOENT','executable_not_found'],['ECONNREFUSED','network_refused'],['ECONNRESET','network_reset'],['ENOTFOUND','dns_failure'],['EAI_AGAIN','dns_temporary']])assert.deepEqual(safeNativeFailure({status:null,error:{code}}).refusalHints,[hint]);
});
test('Refused actual adapter persists only safe hints and refuses any replay',t=>{
 const f=fixture(t,{response:{status:1,signal:null,stdout:'PRIVATE_BODY',stderr:'ERROR: (gcloud.logging.read) PERMISSION_DENIED: PRIVATE_KEY\nreason: SERVICE_DISABLED'}});
 const r=executeRead(f.dir,env,sha,f.args);assert.equal(r.state,'read_failed_or_uncertain');assert.deepEqual(r.nativeFailure,{exitStatus:1,signal:null,refusalHints:['permission_denied','service_disabled']});assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'result.json'),'utf8'),/PRIVATE_|stderr|stack/);assert.throws(()=>executeRead(f.dir,env,sha,f.args));assert.equal(f.calls.filter(x=>x.args[0]==='logging').length,1);
});
