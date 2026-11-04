import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyCandidateOnly } from '../verify_candidate_only.mjs';
import { verifyMoneyCandidate } from '../verify_money_candidate.mjs';
const workflows = Object.fromEntries(['mcp','feed'].map(kind => [kind, fs.readFileSync(`.github/workflows/deploy-${kind}-proxy.yml`, 'utf8')]));
const block = (workflow, name) => workflow.split(`      - name: ${name}\n`)[1].split('      - name: ')[0];
const script = block => block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const sha = 'a'.repeat(40), old = 'situation-room-mcp-old', tag = 'gha-123-1', candidate = `situation-room-mcp-${tag}`;
const replace = (text, candidateOnly = true) => text
  .replaceAll('${{ inputs.candidate_only }}', String(candidateOnly)).replaceAll('${{ inputs.sync_secret_versions }}', 'false')
  .replaceAll('${{ inputs.cisa_only }}', 'false').replaceAll('${{ inputs.metadata_only }}', 'false')
  .replaceAll('${{ steps.current.outputs.rollback_revision }}', old).replaceAll('${{ steps.deploy.outputs.candidate_revision }}', candidate)
  .replaceAll('${{ steps.deploy.outputs.candidate_tag }}', tag).replaceAll('${{ steps.promote.outcome }}', 'skipped').replaceAll('${{ steps.canonical.outcome }}', 'skipped');
function state() {
  const before = { metadata: { generation: 1, annotations: {} }, spec: { template: { metadata: { annotations: {} }, spec: { containers: [{ image: 'old', env: [] }] } }, traffic: [{ revisionName: old, percent: 100 }] }, status: { observedGeneration: 1, latestCreatedRevisionName: old, latestReadyRevisionName: old, traffic: [{ revisionName: old, percent: 100, tag: 'old-serving' }] } };
  const current = structuredClone(before);
  current.status.latestCreatedRevisionName = current.status.latestReadyRevisionName = candidate;
  current.status.traffic.push({ revisionName: candidate, tag, percent: 0 });
  current.spec.traffic.push({ revisionName: candidate, tag, percent: 0 });
  return { before, current };
}

test('Candidate-only guards retain main/full-SHA binding before authentication and disallow bypass modes', () => {
  for (const [kind, workflow] of Object.entries(workflows)) {
    assert.match(workflow, /candidate_only:\n[\s\S]*?required: true\n\s*default: true/);
    assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
    const name = kind === 'mcp' ? 'Bind manual release to reviewed main commit' : 'Bind release to reviewed main commit';
    const guard = script(block(workflow, name));
    for (const [ref, expected, actual, checkout, sync, candidateOnly, specialized, succeeds] of [
      ['refs/heads/main',sha,sha,sha,false,true,false,true], ['refs/heads/main',sha,sha,sha,false,false,false,true],
      ['refs/heads/feature',sha,sha,sha,false,true,false,false], ['refs/heads/main','short','short','short',false,true,false,false],
      ['refs/heads/main',sha,'b'.repeat(40),sha,false,true,false,false], ['refs/heads/main',sha,sha,'b'.repeat(40),false,true,false,false],
      ['refs/heads/main',sha,sha,sha,true,true,false,false], ['refs/heads/main',sha,sha,sha,false,'',false,false],
      ...(kind === 'mcp' ? [['refs/heads/main',sha,sha,sha,false,true,'cisa',false], ['refs/heads/main',sha,sha,sha,false,true,'metadata',false]] : [])
    ]) {
      const code = replace(guard.replaceAll('${{ inputs.sync_secret_versions }}', String(sync)).replaceAll('${{ inputs.cisa_only }}', String(specialized === 'cisa')).replaceAll('${{ inputs.metadata_only }}', String(specialized === 'metadata')), candidateOnly);
      const result = spawnSync('bash', ['-c', `git(){ printf '%s' "$CHECKOUT"; }; ${code}`], { encoding:'utf8', env: { ...process.env, CHECKOUT:checkout, EXPECTED_SHA:expected, ACTUAL_SHA:actual, ACTUAL_REF:ref, SYNC_SECRET_VERSIONS:String(sync), CANDIDATE_ONLY:String(candidateOnly) } });
      assert.equal(result.status === 0, succeeds, `${kind} ${JSON.stringify({ref,expected,sync,candidateOnly,specialized})}: ${result.stderr}`);
    }
    const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
    assert.ok(deploy.indexOf(name) < deploy.indexOf('google-github-actions/auth'));
  }
  for (const name of ['Promote verified MCP revision','Verify canonical MCP release','Restore captured traffic after failed promotion or parity','Fail release when promotion or canonical verification failed']) {
    assert.match(block(workflows.mcp, name).split('        run:')[0], /!inputs.candidate_only/);
  }
  assert.match(block(workflows.feed,'Run core sentinel after feed deploy'), /if: \$\{\{ !inputs.candidate_only \}\}/);
  const smoke = block(workflows.mcp,'Smoke test isolated MCP candidate');
  for (const gate of ['verify_mcp_candidate.mjs','run_core_sentinel.mjs','verify_typed_series_report.mjs']) assert.ok(smoke.includes(gate));
  assert.ok(smoke.indexOf('verify_money_candidate.mjs') > smoke.indexOf('verify_typed_series_report.mjs'));
});

test('Actual MCP deploy command omits IAM/configuration mutations in candidate-only mode', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tsr-mcp-command-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {before}=state(); fs.writeFileSync(`${dir}/before.json`,JSON.stringify(before));
  for (const candidateOnly of [true,false]) {
    const code=replace(script(block(workflows.mcp,'Deploy MCP proxy service')),candidateOnly).replaceAll('/tmp/mcp-diagnostics',`${dir}/diag`).replaceAll('/tmp/mcp-service-before.json',`${dir}/before.json`);
    const output=`${dir}/args.json`;
    const stub=`gcloud(){ if [ "$2" = services ]; then cat '${dir}/before.json'; elif [ "$2" = deploy ]; then printf '%s\\n' "$@" > '${output}'; else return 91; fi; };`;
    const result=spawnSync('bash',['-c',stub+code],{encoding:'utf8',env:{...process.env,PROJECT_ID:'fixture',REGION:'fixture',SERVICE_NAME:'situation-room-mcp',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:`${dir}/output`,SYNC_SECRET_VERSIONS:'false',ALLOWED_ORIGINS:'fixture',ACLED_PROXY:'fixture',STATE_CONNECTOR_BASE_URL:'fixture',STATE_CONNECTOR_KEY_HEADER:'fixture'}});
    assert.equal(result.status,0,result.stderr);
    const args=fs.readFileSync(output,'utf8');
    assert.match(args,/--no-traffic/); assert.match(args,/--tag/);
    if(candidateOnly) assert.doesNotMatch(args,/--allow-unauthenticated|--(?:update|set)-secrets|--update-env-vars|--min|--timeout|iam/);
    else assert.match(args,/--allow-unauthenticated[\s\S]*--min[\s\S]*--timeout[\s\S]*--update-env-vars/);
  }
});

test('Actual MCP candidate cleanup removes only its verified tag; drift fails without mutation', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tsr-mcp-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for (const scenario of ['valid','traffic','tag','configuration','old-tag']) {
    const {before,current}=state();
    if(scenario==='traffic') current.status.traffic[0].revisionName=candidate;
    if(scenario==='tag') current.status.traffic[1].revisionName='alien';
    if(scenario==='configuration') current.spec.template.spec.containers[0].env.push({name:'NEW',value:'changed'});
    if(scenario==='old-tag') current.status.traffic[0].tag='changed';
    fs.writeFileSync(`${dir}/before.json`,JSON.stringify(before));fs.writeFileSync(`${dir}/current.json`,JSON.stringify(current));fs.writeFileSync(`${dir}/mutations`, '');
    const code=replace(script(block(workflows.mcp,"Remove this release's temporary smoke tag"))).replaceAll('/tmp/mcp-service-before.json',`${dir}/before.json`).replaceAll('/tmp/mcp-service-cleanup.json',`${dir}/cleanup.json`).replaceAll('/tmp/mcp-service-final.json',`${dir}/final.json`).replaceAll('/tmp/mcp-diagnostics',dir);
    const stub=`gcloud(){ if [ "$3" = describe ]; then cat '${dir}/current.json'; elif [ "$3" = update-traffic ]; then printf '%s\\n' "$@" >> '${dir}/mutations'; jq 'del(.status.traffic[] | select(.tag == "${tag}")) | del(.spec.traffic[] | select(.tag == "${tag}"))' '${dir}/current.json' > '${dir}/next.json'; mv '${dir}/next.json' '${dir}/current.json'; else return 91; fi; };`;
    const result=spawnSync('bash',['-c',stub+code],{encoding:'utf8',env:{...process.env,SERVICE_NAME:'fixture',REGION:'fixture',PROJECT_ID:'fixture',EXPECTED_SERVING_TAG:'old-serving'}});
    const mutations=fs.readFileSync(`${dir}/mutations`,'utf8');
    if(scenario==='valid') {assert.equal(result.status,0,result.stderr);assert.match(mutations,/--remove-tags\ngha-123-1/);assert.doesNotMatch(mutations,/old-serving|--to-revisions|delete/);}
    else {assert.notEqual(result.status,0);assert.equal(mutations,'');}
  }
});

const fixed={query:'CVS Health',entities:['CVS Health'],start:'2026-01-01',end:'2026-11-03',limit:120};
function payload(mode='sample') {
  return {schemaVersion:2,query:fixed.query,range:{start:fixed.start,end:fixed.end},items:[{source:'LDA',sourceId:'opaque-id'}],summary:{basis:'returned_rows_only'},coverage:{status:mode==='sample'?'discovery_sample':'lda_page',complete:false},sources:Object.fromEntries(['lda','ldaContributions','fec','sam','usaspending'].map(name=>[name,{count:1,returnedCount:1,error:null,coverage:{status:'partial',complete:false,pages:1,requests:1,reasons:['deadline']}}])),ldaTraversal:{complete:false,next:{...fixed,mode:'lda_pages',cursor:'fixture'}}};
}
for(const kind of ['mcp','feed']) test(`Finite ${kind} feature check uses one aggregate and at most three paced LDA calls`,async()=>{
  const calls=[],delays=[]; const base=`https://gha-123-1---situation-room-${kind}-fixture.run.app`;
  const report=await verifyMoneyCandidate(kind,base,{sleep:async ms=>delays.push(ms),now:()=>0,fetchImpl:async(raw,init)=>{
    const url=new URL(raw);assert.equal(init.redirect,'error');let args,id;
    if(kind==='mcp') {const request=JSON.parse(init.body);args=request.params.arguments;id=request.id;assert.equal(request.params.name,'money.flows');}
    else args=Object.fromEntries(url.searchParams);
    assert.equal(args.query||args.q,fixed.query);assert.equal(args.start,fixed.start);assert.equal(args.end,fixed.end);assert.equal(Number(args.limit),120);
    calls.push(args);const data=payload(args.mode);
    return new Response(JSON.stringify(kind==='mcp'?{jsonrpc:'2.0',id,result:{structuredContent:data}}:data));
  }});
  assert.equal(calls.length,4);assert.equal(calls[0].mode,undefined);assert.ok(calls.slice(1).every(a=>a.mode==='lda_pages'));
  assert.deepEqual(delays,[4100,4100,4100]);assert.equal(report.complete,false);assert.equal(report.status,'incomplete');
  assert.doesNotMatch(JSON.stringify(report),/opaque-id|"cursor"|https:/);
});

test('Feature check does not retry/fallback, follows no changed query, and preserves honest quota coverage',async()=>{
  const base='https://gha-123-1---situation-room-mcp-fixture.run.app';
  for(const scenario of ['http','rpc','quota','changed','long-delay']) {
    let calls=0;
    const report=await verifyMoneyCandidate('mcp',base,{sleep:async()=>{throw Error('No pacing call expected');},now:()=>0,fetchImpl:async(raw,init)=>{
      calls++;if(scenario==='http')return new Response('secret-transport',{status:504});
      const request=JSON.parse(init.body),data=payload();
      if(scenario==='quota'){data.sources.lda.error='HTTP 429';data.sources.lda.retryAfterSeconds=120;}
      if(scenario==='changed')data.ldaTraversal.next.query='Different';
      if(scenario==='long-delay')data.sources.lda.retryAfterSeconds=120;
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,...(scenario==='rpc'?{error:{message:'secret-provider'}}:{result:{structuredContent:data}})}));
    }});
    assert.equal(calls,1);assert.equal(report.complete,false);assert.doesNotMatch(JSON.stringify(report),/secret-/);
    if(scenario==='quota')assert.equal(report.calls[0].sources.lda.retryAfterSeconds,120);
    if(scenario==='long-delay')assert.equal(report.stopReason,'retry_after_deferred');
  }
  await assert.rejects(verifyMoneyCandidate('mcp','https://situation-room-mcp-fixture.run.app'),/isolated candidate/);
});
