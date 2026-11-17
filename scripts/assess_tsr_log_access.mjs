// Fixed read-only Google permission/API assessment. No log-entry or provider query.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { effectiveReleaseIdentity } from './feed_native_build.mjs';
import { contract as logContract, safeNativeFailure } from './read_tsr_gdacs_logs.mjs';
export const permissions = Object.freeze(['logging.logEntries.list', 'serviceusage.services.use']);
export const limits = Object.freeze({ timeoutMs: 20000, maxBytes: 65536, tokenTimeoutMs: 10000, tokenMaxBytes: 8192 });
const apiName = 'projects/382918878290/services/logging.googleapis.com';
export const operations = Object.freeze({
  permissions: Object.freeze({ method: 'POST', url: 'https://cloudresourcemanager.googleapis.com/v1/projects/situationroom-ai-20260112:testIamPermissions', body: JSON.stringify({ permissions }) }),
  api: Object.freeze({ method: 'GET', url: 'https://serviceusage.googleapis.com/v1/' + apiName + '?fields=name%2Cstate' })
});
const codes = ['PERMISSION_DENIED','UNAUTHENTICATED','SERVICE_DISABLED','INVALID_ARGUMENT','NOT_FOUND','RESOURCE_EXHAUSTED','DEADLINE_EXCEEDED','UNAVAILABLE'];
const failure = code => Object.assign(new Error('Fixed assessment failed'), { safeCode: code });
function exclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file),'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function bind(env, head) {
  assert.equal(env.GITHUB_REPOSITORY, logContract.repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main'); assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'No reruns'); assert.match(env.GITHUB_RUN_ID || '', /^\d+$/);
  assert.match(env.EXPECTED_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_SHA,env.GITHUB_SHA); assert.equal(head,env.GITHUB_SHA);
  assert.match(env.APPROVAL_REF || '', /^[a-z0-9][a-z0-9-]{7,119}$/);
  return { sourceSha:head, runId:env.GITHUB_RUN_ID, attempt:1, approvalRef:env.APPROVAL_REF, project:logContract.project };
}
export function prepare(dir,env,head) {
  const request=bind(env,head); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  exclusive(path.join(dir,'request.json'),{...request,state:'validated_before_authentication'}); return request;
}
function safeError(data) {
  const e=data?.error;
  return { googleStatus:codes.includes(e?.status) ? e.status : null,
    reasonHints:[...new Set((Array.isArray(e?.details)?e.details:[])
      .filter(d=>d?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo' && codes.includes(d.reason))
      .map(d=>d.reason))].sort() };
}
export function qualify(name,status,data) {
  assert.ok(Object.hasOwn(operations,name));
  if(status!==200) return { httpStatus:status, state:'http_refusal', ...safeError(data) };
  assert.ok(data && typeof data==='object' && !Array.isArray(data));
  if(name==='permissions') {
    const found=Object.hasOwn(data,'permissions')?data.permissions:[]; assert.ok(Array.isArray(found));
    assert.ok(found.every(p=>permissions.includes(p))); assert.equal(new Set(found).size,found.length);
    return {httpStatus:status,state:'completed',permissions:Object.fromEntries(permissions.map(p=>[p,found.includes(p)]))};
  }
  assert.equal(data.name,apiName); assert.ok(['ENABLED','DISABLED'].includes(data.state));
  return {httpStatus:status,state:'completed',loggingApiState:data.state};
}
// Reuses the existing candidate reader's byte-loop/cancel pattern, scoped to two fixed operations.
export async function requestFixed(name,token,{fetchImpl,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  assert.ok(Object.hasOwn(operations,name)); assert.equal(typeof fetchImpl,'function');
  assert.ok(typeof token==='string' && /^[A-Za-z0-9._~-]{16,8192}$/.test(token));
  const op=operations[name], controller=new AbortController(); let reader,timer,observedStatus=null;
  const deadline=new Promise((_,reject)=>{timer=setTimer(()=>{controller.abort();reject(failure('deadline'));},limits.timeoutMs);});
  const work=(async()=>{
    const response=await fetchImpl(op.url,{method:op.method,headers:{Accept:'application/json',Authorization:'Bearer '+token,...(op.body?{'Content-Type':'application/json'}:{})},...(op.body?{body:op.body}:{}),redirect:'error',credentials:'omit',signal:controller.signal});
    assert.ok(Number.isInteger(response.status) && response.status>=100 && response.status<=599);
    observedStatus=response.status;assert.ok(response.body);reader=response.body.getReader();const chunks=[];let bytes=0;
    while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limits.maxBytes)throw failure('body_cap');chunks.push(Buffer.from(part.value));}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return qualify(name,response.status,data);
  })();
  try{return await Promise.race([work,deadline]);}
  catch(e){return {state:'failed_or_uncertain',httpStatus:observedStatus,failureClass:['deadline','body_cap'].includes(e?.safeCode)?e.safeCode:'transport_or_decode_unknown'};}
  finally{clearTimer(timer);controller.abort();if(reader){try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}}
}
export async function execute(dir,env,head,{run=spawnSync,readFile=fs.readFileSync,fetchImpl,now=Date.now,requestOptions={}}={}) {
  const request=bind(env,head);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'request.json'))),{...request,state:'validated_before_authentication'});
  for(const f of ['assessment-intent.json','permissions-intent.json','api-intent.json','result.json'])assert.equal(fs.existsSync(path.join(dir,f)),false,'Prior or uncertain assessment blocks replay');
  assert.equal(typeof fetchImpl,'function');
  const result={...request,startedAt:new Date(now()).toISOString(),state:'not_attempted',tokenCommandAttempts:0,assessmentRequests:0,providerCalls:0};let token;
  const command=(args,timeout,maxBuffer)=>run('gcloud',args,{encoding:'utf8',timeout,maxBuffer,killSignal:'SIGTERM',env:{...env,CLOUDSDK_CORE_DISABLE_PROMPTS:'true',CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API:'false',CLOUDSDK_CORE_DISABLE_USAGE_REPORTING:'true',CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK:'true'}});
  try{
    result.identity=effectiveReleaseIdentity({env,readFile,getProperty:property=>{const r=command(['config','get',property],5000,8192);assert.equal(r.status,0);return r.stdout.trim()==='(unset)'?'':r.stdout.trim();}});
    exclusive(path.join(dir,'assessment-intent.json'),{...request,at:new Date(now()).toISOString(),state:'token_or_assessment_attempting_uncertain'});
    result.tokenCommandAttempts=1;
    const auth=command(['auth','print-access-token','--quiet'],limits.tokenTimeoutMs,limits.tokenMaxBytes);
    if(auth.error || auth.status!==0){result.tokenFailure=safeNativeFailure(auth);throw failure('token_refusal');}
    token=auth.stdout.trim();assert.match(token,/^[A-Za-z0-9._~-]{16,8192}$/);
    result.state='completed';
    for(const name of ['permissions','api']){
      exclusive(path.join(dir,name+'-intent.json'),{...request,operation:name,at:new Date(now()).toISOString(),state:'attempting_or_uncertain'});
      result.assessmentRequests++;
      const observed=await requestFixed(name,token,{...requestOptions,fetchImpl});
      result[name]=observed;exclusive(path.join(dir,name+'-result.json'),observed);
      if(observed.state!=='completed'){result.state='stopped_failed_or_uncertain';break;}
    }
  }catch{result.state=result.tokenCommandAttempts?'stopped_failed_or_uncertain':'identity_or_local_refusal';}
  finally{token=undefined;}
  result.finishedAt=new Date(now()).toISOString();exclusive(path.join(dir,'result.json'),result);return result;
}
export function finalize(dir){
  if(fs.existsSync(path.join(dir,'result.json')))return;
  const request=JSON.parse(fs.readFileSync(path.join(dir,'request.json')));
  exclusive(path.join(dir,'result.json'),{...request,state:fs.existsSync(path.join(dir,'assessment-intent.json'))?'interrupted_uncertain_no_replay':'not_attempted_auth_or_prior_step_failed',providerCalls:0});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [mode,dir]=process.argv.slice(2);
  try{
    const head=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    if(mode==='prepare')prepare(dir,process.env,head());
    else if(mode==='assess'){const r=await execute(dir,process.env,head(),{fetchImpl:globalThis.fetch});if(r.state!=='completed')process.exitCode=1;}
    else if(mode==='finalize')finalize(dir);else throw failure('mode');
  }catch{console.error('Fixed log-access assessment refused; details excluded.');process.exitCode=1;}
}
