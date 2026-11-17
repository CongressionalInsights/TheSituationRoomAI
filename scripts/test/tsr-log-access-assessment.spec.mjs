import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let forbiddenNetwork=0;
globalThis.fetch=async()=>{forbiddenNetwork++;throw Error('Real network forbidden');};
const {permissions,limits,operations,bind,prepare,qualify,requestFixed,execute,finalize}=await import('../assess_tsr_log_access.mjs');
const sha='a'.repeat(40), token='PRIVATE_TOKEN_ONLY_IN_MEMORY', now=Date.parse('2026-11-17T02:00:00Z');
const principal='gh-actions-deployer@situationroom-ai-20260112.iam.gserviceaccount.com';
const env={GITHUB_REPOSITORY:'CongressionalInsights/TheSituationRoomAI',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'456',GITHUB_SHA:sha,EXPECTED_SHA:sha,APPROVAL_REF:'fixture-not-real-assessment-authority',GOOGLE_GHA_CREDS_PATH:'/fixture/binding.json'};
const api={name:'projects/382918878290/services/logging.googleapis.com',state:'ENABLED',config:{PRIVATE_KEY:'PRIVATE_BODY'}};
const response=(body,status=200)=>({status,body:new ReadableStream({start(c){c.enqueue(Buffer.from(typeof body==='string'?body:JSON.stringify(body)));c.close();}})});
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tsr-access-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));prepare(dir,env,sha);const calls=[],fetches=[];
 const props={'core/should_prompt_to_enable_api':'false','auth/credential_file_override':'/fixture/binding.json',...(options.properties||{})};
 const run=(cmd,args,opts)=>{assert.equal(cmd,'gcloud');calls.push({args,opts});if(args[0]==='config')return{status:0,stdout:props[args[2]]||'',stderr:'PRIVATE_STDERR'};
  assert.deepEqual(args,['auth','print-access-token','--quiet']);assert.ok(fs.existsSync(path.join(dir,'assessment-intent.json')));return options.auth??{status:0,stdout:token+'\n',stderr:'PRIVATE_STDERR'};};
 const readFile=file=>{assert.equal(file,'/fixture/binding.json');return JSON.stringify({type:'service_account',client_email:options.principal||principal,private_key:'PRIVATE_KEY'});};
 const fetchImpl=async(url,init)=>{fetches.push({url,init});const name=url===operations.permissions.url?'permissions':'api';assert.ok(fs.existsSync(path.join(dir,name+'-intent.json')));return options.responses?.[fetches.length-1]??response(name==='permissions'?{permissions:[...permissions],private:'PRIVATE_BODY'}:api);};
 return{dir,calls,fetches,args:{run,readFile,fetchImpl,now:()=>now}};
}
test('Manual-only workflow binds source/role and inert fixtures before existing auth, exact outputs only',()=>{
 const s=fs.readFileSync('.github/workflows/assess-tsr-log-access.yml','utf8');assert.doesNotMatch(s,/\n  (push|pull_request|schedule):/);assert.match(s,/contents: read/);assert.match(s,/timeout-minutes: 5/);assert.doesNotMatch(s,/id-token: write|contents: write|gcloud.*deploy|secrets\.DATA_GOV/);assert.ok(s.indexOf('mjs prepare')<s.indexOf('google-github-actions/auth@v3'));assert.ok(s.indexOf('node --test')<s.indexOf('google-github-actions/auth@v3'));assert.match(s,/credentials_json: \$\{\{ secrets.GCP_SA_KEY \}\}/);assert.match(s,/persist-credentials: false/);assert.doesNotMatch(s,/\*\.json/);
});
test('Wrong source/ref/repository/event/run/role and reruns refuse deterministically',()=>{
 assert.equal(bind(env,sha).sourceSha,sha);for(const bad of [{GITHUB_REPOSITORY:'foreign/repo'},{GITHUB_REF:'refs/heads/other'},{GITHUB_EVENT_NAME:'push'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_RUN_ID:'PRIVATE_ID'},{EXPECTED_SHA:'b'.repeat(40)},{APPROVAL_REF:'bad?key=PRIVATE_KEY'}])assert.throws(()=>bind({...env,...bad},sha));assert.throws(()=>bind(env,'b'.repeat(40)));
});
test('Only two fixed request shapes; caller permission semantics and absent permissions are honest',()=>{
 assert.deepEqual(JSON.parse(operations.permissions.body),{permissions:['logging.logEntries.list','serviceusage.services.use']});assert.equal(operations.permissions.method,'POST');assert.equal(operations.permissions.url,'https://cloudresourcemanager.googleapis.com/v1/projects/situationroom-ai-20260112:testIamPermissions');assert.equal(operations.api.method,'GET');assert.equal(operations.api.url,'https://serviceusage.googleapis.com/v1/projects/382918878290/services/logging.googleapis.com?fields=name%2Cstate');assert.deepEqual(qualify('permissions',200,{}).permissions,{'logging.logEntries.list':false,'serviceusage.services.use':false});assert.equal(qualify('api',200,{...api,state:'DISABLED'}).loggingApiState,'DISABLED');
 for(const body of [{permissions:null},{permissions:['PRIVATE_PERMISSION']},{permissions:[permissions[0],permissions[0]]},[]])assert.throws(()=>qualify('permissions',200,body));assert.throws(()=>qualify('api',200,{...api,name:'PRIVATE_RESOURCE'}));assert.throws(()=>qualify('api',200,{...api,state:'PRIVATE_STATE'}));
});
test('Google HTTP refusal retains fixed status/reason only and never infers missing permission from metadata',()=>{
 const x=qualify('permissions',403,{error:{status:'PERMISSION_DENIED',message:'PRIVATE_ERROR',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'SERVICE_DISABLED',metadata:{PRIVATE_KEY:'PRIVATE_VALUE'}},{'@type':'PRIVATE_TYPE',reason:'UNAUTHENTICATED'},{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'PRIVATE_REASON'}]}});assert.deepEqual(x,{httpStatus:403,state:'http_refusal',googleStatus:'PERMISSION_DENIED',reasonHints:['SERVICE_DISABLED']});assert.doesNotMatch(JSON.stringify(x),/PRIVATE_/);assert.deepEqual(qualify('api',404,{error:{status:'PRIVATE_STATUS'}}),{httpStatus:404,state:'http_refusal',googleStatus:null,reasonHints:[]});
});
test('Actual fixed transport uses anonymous cookie omission, bearer only in memory, no redirects/retries',async()=>{
 let count=0;const r=await requestFixed('permissions',token,{fetchImpl:async(url,init)=>{count++;assert.equal(url,operations.permissions.url);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.deepEqual(JSON.parse(init.body),{permissions:[...permissions]});assert.equal(init.headers.Authorization,'Bearer '+token);assert.deepEqual(Object.keys(init.headers).sort(),['Accept','Authorization','Content-Type']);return response({permissions});}});assert.equal(count,1);assert.equal(r.state,'completed');assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|Bearer/);await assert.rejects(requestFixed('PRIVATE_URL',token,{fetchImpl:()=>{throw Error('must not send');}}));
});
test('Actual 64KiB body cap accepts boundary and stops at one byte over; cancel and release lock',async()=>{
 const valid=JSON.stringify({permissions:[]});for(const [size,expected] of [[65536,'completed'],[65537,'failed_or_uncertain']]){let cancelled=0,released=0,n=0;const r=await requestFixed('permissions',token,{fetchImpl:async()=>({status:200,body:{getReader(){return{read:async()=>n++?{done:true}:{done:false,value:Buffer.from(valid+' '.repeat(size-valid.length))},cancel(){cancelled++;},releaseLock(){released++;}};}}})});assert.equal(r.state,expected);if(size>65536)assert.equal(r.failureClass,'body_cap');assert.equal(cancelled,1);assert.equal(released,1);}
});
test('20s through-body deadline is shared across fetch and decode; stalled readers abort without replay',async()=>{
 for(const stalledBody of [false,true]){let timerMs,cleared=0,cancelled=0,released=0,signal;const r=await requestFixed('api',token,{setTimer:(f,ms)=>{timerMs=ms;return setTimeout(f,5);},clearTimer:t=>{cleared++;clearTimeout(t);},fetchImpl:async(url,init)=>{signal=init.signal;if(!stalledBody)return new Promise(()=>{});return{status:200,body:{getReader(){return{read:()=>new Promise(()=>{}),cancel(){cancelled++;return new Promise(()=>{});},releaseLock(){released++;}};}}};}});assert.equal(timerMs,20000);assert.equal(r.failureClass,'deadline');assert.equal(signal.aborted,true);assert.equal(cleared,1);if(stalledBody){assert.equal(cancelled,1);assert.equal(released,1);}}
});
test('Malformed/redirect/HTML/private exception remains unknown; observed HTTP status retained',async()=>{
 for(const r of [response('PRIVATE_HTML',403),response({name:'PRIVATE_RESOURCE',state:'ENABLED'}),response({},302)]){const x=await requestFixed('api',token,{fetchImpl:async()=>r});assert.notEqual(x.state,'completed');assert.doesNotMatch(JSON.stringify(x),/PRIVATE_/);}const x=await requestFixed('api',token,{fetchImpl:async()=>{throw Object.assign(Error('PRIVATE_ERROR'),{cause:{PRIVATE_KEY:'PRIVATE_VALUE'}});}});assert.equal(x.failureClass,'transport_or_decode_unknown');assert.equal(x.httpStatus,null);assert.doesNotMatch(JSON.stringify(x),/PRIVATE_/);
});
test('Complete assessment has one token command/two fixed requests, source intents and fully redacted receipts',async t=>{
 const f=fixture(t);const r=await execute(f.dir,env,sha,f.args);assert.equal(r.state,'completed');assert.equal(r.tokenCommandAttempts,1);assert.equal(r.assessmentRequests,2);assert.equal(f.fetches.length,2);assert.equal(r.identity.principal,principal);assert.equal(r.api.loggingApiState,'ENABLED');assert.equal(r.providerCalls,0);
 const auth=f.calls.find(c=>c.args[0]==='auth');assert.equal(auth.opts.timeout,10000);assert.equal(auth.opts.maxBuffer,8192);assert.equal(auth.opts.env.CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API,'false');for(const file of fs.readdirSync(f.dir))assert.doesNotMatch(fs.readFileSync(path.join(f.dir,file),'utf8'),/PRIVATE_|Bearer|private_key|stderr|stack/);await assert.rejects(execute(f.dir,env,sha,f.args));assert.equal(f.fetches.length,2);
});
test('Observed missing permission is false, not an access grant or failed API-state query',async t=>{
 const f=fixture(t,{responses:[response({}),response({...api,state:'DISABLED'})]});const r=await execute(f.dir,env,sha,f.args);assert.equal(r.state,'completed');assert.equal(r.permissions.permissions['logging.logEntries.list'],false);assert.equal(r.api.loggingApiState,'DISABLED');assert.equal(f.fetches.length,2);
});
test('HTTP refusal or bad first response spends assessment and stops before second request',async t=>{
 for(const first of [response({error:{status:'PERMISSION_DENIED',message:'PRIVATE_ERROR'}},403),response('PRIVATE_INVALID')]){const f=fixture(t,{responses:[first]});const r=await execute(f.dir,env,sha,f.args);assert.equal(r.state,'stopped_failed_or_uncertain');assert.equal(r.assessmentRequests,1);assert.equal(f.fetches.length,1);assert.ok(!fs.existsSync(path.join(f.dir,'api-intent.json')));await assert.rejects(execute(f.dir,env,sha,f.args));assert.equal(f.fetches.length,1);}
});
test('Identity mismatch/conflicting bindings block token command and both requests',async t=>{
 for(const bad of [{principal:'foreign@example.invalid'},{properties:{'auth/impersonate_service_account':'foreign'}},{properties:{'auth/credential_file_override':'/foreign/file'}}]){const f=fixture(t,bad);const r=await execute(f.dir,env,sha,f.args);assert.equal(r.state,'identity_or_local_refusal');assert.equal(r.tokenCommandAttempts,0);assert.equal(f.fetches.length,0);assert.ok(!f.calls.some(c=>c.args[0]==='auth'));assert.doesNotMatch(JSON.stringify(r),/foreign|PRIVATE_/);}
});
test('Token refusal/timeout/cap/malformed value remain sanitized terminal with zero assessment calls',async t=>{
 for(const auth of [{status:1,stdout:token,stderr:'ERROR: PRIVATE_KEY'},{status:null,error:{code:'ETIMEDOUT',message:'PRIVATE_ERROR'},stdout:''},{status:null,error:{code:'ENOBUFS'},stdout:''},{status:0,stdout:'PRIVATE token with whitespace'}]){const f=fixture(t,{auth});const r=await execute(f.dir,env,sha,f.args);assert.equal(r.state,'stopped_failed_or_uncertain');assert.equal(r.tokenCommandAttempts,1);assert.equal(f.fetches.length,0);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|stderr|stack/);await assert.rejects(execute(f.dir,env,sha,f.args));}
});
test('Prior uncertain intent, changed request and terminal result refuse before credentials/network',async t=>{
 for(const file of ['assessment-intent.json','permissions-intent.json','api-intent.json','result.json']){const f=fixture(t);fs.writeFileSync(path.join(f.dir,file),'{}');await assert.rejects(execute(f.dir,env,sha,f.args));assert.equal(f.calls.length,0);assert.equal(f.fetches.length,0);}const f=fixture(t);fs.writeFileSync(path.join(f.dir,'request.json'),'{}');await assert.rejects(execute(f.dir,env,sha,f.args));assert.equal(f.calls.length,0);
});
test('Interrupted finalize never fabricates permission/API observations or overwrites receipt',t=>{
 for(const attempted of [false,true]){const f=fixture(t);if(attempted)fs.writeFileSync(path.join(f.dir,'assessment-intent.json'),'{}');finalize(f.dir);const file=path.join(f.dir,'result.json'),raw=fs.readFileSync(file,'utf8');assert.equal(JSON.parse(raw).state,attempted?'interrupted_uncertain_no_replay':'not_attempted_auth_or_prior_step_failed');assert.ok(!Object.hasOwn(JSON.parse(raw),'permissions'));finalize(f.dir);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(f.calls.length,0);}
});
test('Actual CLI invalid pre-auth source refuses without key access or gcloud',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tsr-access-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const r=spawnSync(process.execPath,['scripts/assess_tsr_log_access.mjs','prepare',dir],{encoding:'utf8',env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',...env,EXPECTED_SHA:'wrong'}});assert.notEqual(r.status,0);assert.match(r.stderr,/assessment refused/);assert.ok(!fs.existsSync(path.join(dir,'request.json')));
});
test('All fixtures used injected transports; no real network was attempted',()=>{assert.equal(forbiddenNetwork,0);});

test('Logging API metadata requests only name/state so unrelated large config is not requested',async()=>{
 const full={...api,config:{description:'PRIVATE_UNRELATED_CONFIG'.repeat(4000)}};assert.ok(Buffer.byteLength(JSON.stringify(full))>limits.maxBytes);
 let calls=0;const r=await requestFixed('api',token,{fetchImpl:async(url,init)=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://serviceusage.googleapis.com');assert.equal(u.pathname,'/v1/projects/382918878290/services/logging.googleapis.com');assert.deepEqual([...u.searchParams],[['fields','name,state']]);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');return response({name:full.name,state:full.state});}});
 assert.equal(calls,1);assert.deepEqual(r,{httpStatus:200,state:'completed',loggingApiState:'ENABLED'});assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|config/);
});
