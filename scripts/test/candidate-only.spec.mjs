import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyCandidateOnly } from '../verify_candidate_only.mjs';
import { verifyMoneyCandidate } from '../verify_money_candidate.mjs';
import { fetchMoneyFlows } from '../../gcp/mcp-proxy/money-flows.js';
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
    const result=spawnSync('bash',['-c',stub+code],{encoding:'utf8',env:{...process.env,PROJECT_ID:'fixture',REGION:'fixture',SERVICE_NAME:'situation-room-mcp',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:`${dir}/output`,SYNC_SECRET_VERSIONS:'false',ALLOWED_ORIGINS:'fixture with spaces',ACLED_PROXY:'fixture',STATE_CONNECTOR_BASE_URL:'fixture',STATE_CONNECTOR_KEY_HEADER:'fixture'}});
    assert.equal(result.status,0,result.stderr);
    const args=fs.readFileSync(output,'utf8');
    const argv=args.split('\n').slice(0,-1);
    assert.equal(argv.includes(''),false,'empty optional arrays must not add an empty argument');
    assert.match(args,/--no-traffic/); assert.match(args,/--tag/);
    if(candidateOnly) assert.doesNotMatch(args,/--allow-unauthenticated|--(?:update|set)-secrets|--update-env-vars|--min|--timeout|iam/);
    else {
      assert.match(args,/--allow-unauthenticated[\s\S]*--min[\s\S]*--timeout[\s\S]*--update-env-vars/);
      assert.equal(argv[argv.indexOf('--update-env-vars')+1],'^|^ALLOWED_ORIGINS=fixture with spaces|ACLED_PROXY=fixture|STATE_CONNECTOR_BASE_URL=fixture|STATE_CONNECTOR_KEY_HEADER=fixture');
    }
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
const attribution='Contributor is donor; reported employer is affiliation only. Committee is recipient.';
function moneyRows() {
  return [
    {source:'LDA',sourceId:'opaque-id',type:'Lobbying Filing',bucket:'lobbying',amount:0,income:0,expenses:null,amountBasis:'reported_income',client:'CVS Health',registrant:'Private registrant',entity:'CVS Health',recipient:'Private registrant',donor:null,filingType:'RR',filingPeriod:'Q1',amendment:false},
    {source:'LDA',sourceId:'parent:2',filingId:'parent',childId:2,type:'Lobbying Contribution',bucket:'contributions',amount:-5,donor:'Private donor',entity:'Private donor',recipient:'Private payee',registrant:null},
    {source:'OpenFEC',sourceId:'receipt',type:'Campaign Receipt',bucket:'contributions',amount:25,amountBasis:'reported_receipt',includeInSubtotal:false,attribution,donor:'Private donor',entity:'Private donor',employer:'CVS Health',recipient:'Private committee',committee:'Private committee',contributorId:null,committeeId:'C00000001',entityType:'IND',memoCode:'X',amendmentIndicator:'A',twoYearTransactionPeriod:2026,matchRole:'reported_employer'},
    {source:'USAspending',sourceId:'a'.repeat(64),type:'Federal Transaction',bucket:'spending',amount:-20,amountBasis:'transaction_obligation',loanValue:null,subsidyCost:0,identityBasis:'award_modification_action_composite',awardId:'award',generatedAwardId:null,modificationNumber:'P00001',actionType:'C',recipientUei:'private-uei',donor:'Private agency',entity:'CVS Health',recipient:'CVS Health',publishedAt:'2026-03-01'},
    {source:'SAM.gov',sourceId:'private-uei',type:'SAM Entity',bucket:'registry',amount:null,amountBasis:'not_applicable',dateBasis:'current_registration_snapshot',uei:'private-uei',entity:'CVS Health',registryEntity:'CVS Health',donor:null,recipient:null}
  ];
}
const sourceKey=row=>row.source==='LDA'?(row.type==='Lobbying Contribution'?'ldaContributions':'lda'):({'OpenFEC':'fec','SAM.gov':'sam',USAspending:'usaspending'})[row.source];
function payload(mode='sample') {
  const items=[moneyRows()[0]];
  return {schemaVersion:2,query:fixed.query,range:{start:fixed.start,end:fixed.end},items,summary:{basis:'returned_rows_only'},coverage:{status:mode==='sample'?'discovery_sample':'lda_page',complete:false},sources:Object.fromEntries(['lda','ldaContributions','fec','sam','usaspending'].map(name=>[name,{count:name==='lda'?1:0,returnedCount:name==='lda'?1:0,error:null,coverage:{status:'partial',complete:false,pages:1,requests:1,reasons:['deadline']}}])),ldaTraversal:{complete:false,next:{...fixed,mode:'lda_pages',cursor:'fixture'}}};
}
async function observeRows(items, change=()=>{}) {
  const data=payload();data.items=items;data.ldaTraversal.next=null;
  for(const [name,source] of Object.entries(data.sources)) source.count=source.returnedCount=items.filter(row=>sourceKey(row)===name).length;
  change(data);let calls=0;
  const report=await verifyMoneyCandidate('feed','https://gha-123-1---situation-room-feed-fixture.run.app',{fetchImpl:async()=>{calls++;return new Response(JSON.stringify(data));},sleep:async()=>assert.fail('Unexpected further acquisition')});
  assert.equal(calls,1);return report;
}

test('Money diagnostic receipts retain only allowlisted evidence and preserve unknown versus zero', async () => {
  const safe = { sequence: 1, request: 1, attempt: 1, attempted: true, filter: 'contribution_payee', year: 2026, page: 2, pageKind: 'numbered', branch: 'no_new_identities', httpStatus: 200, exceptionCategory: null, rowCount: 2, newIdentityCount: 0, identityHash: 'a'.repeat(64), elapsedMs: 0, budgetMs: 45000, remainingMs: 45000 };
  const secret = 'private-value';
  const report = await observeRows([moneyRows()[0]], data => {
    data.sources.lda.coverage.diagnostics = { attempts: [
      { ...safe, url: 'https://secret.invalid/', cursor: secret, entity: secret, rawBody: secret, message: secret },
      { ...safe, branch: secret, filter: secret, exceptionCategory: secret, httpStatus: -1, rowCount: null, newIdentityCount: null, identityHash: secret, elapsedMs: null }
    ], omitted: 0, rawBody: secret };
  });
  const evidence = report.calls[0].sources.lda.diagnostics;
  assert.deepEqual(evidence.attempts[0], safe);
  assert.equal(evidence.attempts[1].branch, 'unknown');
  assert.equal(evidence.attempts[1].filter, null);
  assert.equal(evidence.attempts[1].exceptionCategory, 'unknown');
  for (const field of ['httpStatus', 'rowCount', 'newIdentityCount', 'identityHash', 'elapsedMs']) assert.equal(evidence.attempts[1][field], null);
  assert.equal(report.calls[0].sources.fec.diagnostics, null);
  assert.equal(report.calls[0].valid, true);
  assert.equal(report.complete, false);
  assert.doesNotMatch(JSON.stringify(evidence), /private-value|https?:|"url"|"cursor"|rawBody|"message"|"entity"/);
  const bounded = await observeRows([moneyRows()[0]], data => {
    data.sources.lda.coverage.diagnostics = { attempts: Array.from({ length: 35 }, (_, i) => ({ ...safe, sequence: i + 1 })), omitted: 5 };
  });
  assert.equal(bounded.calls[0].sources.lda.diagnostics.attempts.length, 32);
  assert.equal(bounded.calls[0].sources.lda.diagnostics.omitted, 8);
  const overflow = await observeRows([moneyRows()[0]], data => {
    data.sources.lda.coverage.diagnostics = { attempts: Array(33).fill(safe), omitted: Number.MAX_SAFE_INTEGER };
  });
  assert.equal(overflow.calls[0].sources.lda.diagnostics.omitted, null);
});

test('Money verifier rejects the owner exact-source registration and malformed-identity probes',async()=>{
  for(const row of [{source:'SAM.gov',sourceId:'fixture',amount:500,bucket:'spending'},{source:'LDA',amount:'not-a-number'}]) {
    const report=await observeRows([row]);assert.equal(report.status,'invalid_contract');assert.equal(report.calls[0].valid,false);
  }
});

test('Money verifier rejects missing financial/attribution evidence and duplicate normalized identities',async()=>{
  const fields=[['amount','income','expenses','amountBasis','client','registrant','entity','recipient'],['amount','filingId','childId','donor','recipient'],['amount','amountBasis','attribution','includeInSubtotal','donor','employer','recipient','committee','committeeId','twoYearTransactionPeriod'],['amount','amountBasis','loanValue','subsidyCost','identityBasis','awardId','modificationNumber','recipientUei','donor','recipient'],['amount','amountBasis','registryEntity','dateBasis']];
  for(const [index,row] of moneyRows().entries()) {
    for(const field of ['sourceId',...fields[index]]) {
      const broken={...row};delete broken[field];
      assert.equal((await observeRows([broken])).status,'invalid_contract',`${row.type}: missing ${field}`);
    }
    for(const amount of ['0','not-a-number',{},true]) assert.equal((await observeRows([{...row,amount}])).status,'invalid_contract',`${row.type}: malformed amount`);
  }
  const filing=moneyRows()[0];
  for(const items of [[filing,{...filing}],[{...filing,sourceId:42},{...filing,sourceId:'42'}],[filing,{...filing,sourceId:' opaque-id '}]]) assert.equal((await observeRows(items)).status,'invalid_contract');
  for(const change of [row=>{row.amount=10;},row=>{row.amountBasis='award_total';},row=>{row.recipient='Different';}]) {
    const row={...filing};change(row);assert.equal((await observeRows([row])).status,'invalid_contract');
  }
  const fec=moneyRows()[2];
  assert.equal((await observeRows([{...fec,includeInSubtotal:true}])).status,'invalid_contract');
  assert.equal((await observeRows([{...fec,attribution:'Employer is donor'}])).status,'invalid_contract');
});

test('Money receipts preserve null, zero, negatives, exclusions and sanitized source-specific lineage',async()=>{
  for(const amount of [null,0,-123.5]) {
    const rows=moneyRows();
    for(const row of rows.slice(0,4)) row.amount=amount;
    rows[0].income=amount;rows[0].amountBasis=amount===null?'reported_expenses':'reported_income';
    for(const row of rows) Object.assign(row,{canonicalUrl:'https://secret.invalid/?api_key=private-key',detailFields:[{value:'sensitive-payload'}],summary:'arbitrary-secret-error',title:'sensitive-payload'});
    const report=await observeRows(rows);assert.equal(report.status,'incomplete');assert.equal(report.complete,false);
    const evidence=report.calls[0].financialEvidence;assert.equal(evidence.basis,'returned_rows_only');assert.equal(evidence.reconciledLedger,false);
    assert.deepEqual(evidence.rows.slice(0,4).map(row=>row.amount),Array(4).fill({state:amount===null?'unknown':'known',value:amount}));
    assert.deepEqual(evidence.rows[4].amount,{state:'unknown',value:null});
    assert.deepEqual(evidence.rows.map(row=>row.amountBasis),['reported_income','reported_contribution','reported_receipt','transaction_obligation','not_applicable'].map((basis,i)=>i===0&&amount===null?'reported_expenses':basis));
    assert.equal(evidence.rows[1].basisOrigin,'normalized_type');assert.equal(evidence.rows[2].includeInSubtotal,false);
    assert.equal(evidence.rows[2].attributionMatchRole,'reported_employer');assert.equal(evidence.rows[2].lineage.memoExcluded,true);
    assert.equal(evidence.rows[2].parties.recipient.hash,evidence.rows[2].parties.committee.hash);
    assert.notEqual(evidence.rows[2].parties.donor.hash,evidence.rows[2].parties.employer.hash);
    assert.equal(evidence.rows[3].lineage.identityBasis,'award_modification_action_composite');
    assert.deepEqual(evidence.rows[3].numeric.subsidyCost,{state:'known',value:0});
    for(const row of evidence.rows) assert.match(row.identity,/^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(report),/private-|Private|opaque-id|sensitive-payload|arbitrary-secret|https:|canonicalUrl|detailFields|"cursor"/);
  }
  const rows=moneyRows();rows[0].income=null;rows[0].expenses=-10;rows[0].amount=-10;rows[0].amountBasis='reported_expenses';
  rows[1].childId=null;rows[1].sourceId='parent:0';rows[2].memoCode=null;rows[2].includeInSubtotal=true;rows[2].twoYearTransactionPeriod=null;rows[2].employer='';rows[2].contributorId='';
  rows[4].uei='';rows[4].sourceId='CAGE-FALLBACK';
  const report=await observeRows(rows);assert.equal(report.status,'incomplete');assert.equal(report.calls[0].financialEvidence.rows[2].includeInSubtotal,true);
  assert.deepEqual(report.calls[0].financialEvidence.rows[2].parties.employer,{state:'unknown',hash:null});
});

test('Unavailable sources remain distinct from known zero receipts and cannot claim returned rows',async()=>{
  const report=await observeRows([moneyRows()[0]],data=>{
    for(const name of ['fec','sam','usaspending']) Object.assign(data.sources[name],{error:'arbitrary-secret',coverage:{status:'unavailable',complete:false,pages:0,requests:0,reasons:['arbitrary-secret']}});
    data.sources.ldaContributions.coverage.status='not_requested';
  });
  assert.equal(report.status,'incomplete');assert.equal(report.calls[0].sources.sam.status,'unavailable');
  assert.equal(report.calls[0].sources.sam.error,'provider_error');assert.doesNotMatch(JSON.stringify(report),/arbitrary-secret|totalAmount/);
  assert.equal(report.calls[0].financialEvidence.rows.length,1);assert.deepEqual(report.calls[0].financialEvidence.rows[0].amount,{state:'known',value:0});
  for(const status of ['unavailable','not_requested']) assert.equal((await observeRows([moneyRows()[0]],data=>{data.sources.lda.coverage.status=status;})).status,'invalid_contract');
  assert.equal((await observeRows([moneyRows()[0]],data=>{data.sources.lda.returnedCount=0;})).status,'invalid_contract');
});

test('LD203 receipts distinguish explicit missing-ID fallback from native and malformed lineage',async()=>{
  const child={...moneyRows()[1],childId:null,sourceId:`parent:fallback-${'a'.repeat(64)}-0`,childIdentityBasis:'content_occurrence_fallback',amount:null};
  const accepted=await observeRows([child]);
  assert.equal(accepted.status,'incomplete');
  assert.equal(accepted.calls[0].financialEvidence.rows[0].lineage.childIdentityBasis,'content_occurrence_fallback');
  assert.deepEqual(accepted.calls[0].financialEvidence.rows[0].amount,{state:'unknown',value:null});
  for(const invalid of [{...child,childIdentityBasis:'native_id'},{...child,childIdentityBasis:undefined},{...child,sourceId:'parent:fallback-invalid-0'},{...moneyRows()[1],childIdentityBasis:'content_occurrence_fallback'}]) {
    assert.equal((await observeRows([invalid])).status,'invalid_contract');
  }
});

test('Exact production normalizer output passes financial verification using only inert provider fixtures',async()=>{
  const previous=process.env.DATA_GOV;process.env.DATA_GOV='inert-candidate-fixture';
  try {
    const normalized=await fetchMoneyFlows(fixed,{sleep:async()=>{},fetch:async(raw)=>{
      const url=new URL(raw);let data;
      if(url.hostname==='lda.gov') data={results:url.pathname.includes('/contributions/')
        ?[{filing_uuid:'filing-child',registrant:{name:'CVS Health'},contribution_items:[{id:2,contributor_name:'CVS Health',payee_name:'Committee',amount:0,date:'2026-03-01'},{contributor_name:'CVS Health',payee_name:'Committee',amount:null,date:'2026-03-01'}]}]
        :[{filing_uuid:'filing-parent',client:{name:'CVS Health'},income:null,expenses:-40}],next:null};
      else if(url.hostname==='api.open.fec.gov') data={results:url.searchParams.has('last_index')?[]:[{sub_id:'receipt',contributor_name:'Private donor',contributor_employer:'CVS Health',contribution_receipt_amount:0}],pagination:{last_indexes:url.searchParams.has('last_index')?null:{last_index:'receipt',last_contribution_receipt_date:'2026-03-01'}}};
      else if(url.hostname==='api.usaspending.gov') data={results:[{'Award ID':'award','Recipient Name':'CVS Health','Transaction Amount':-10,Mod:'1'}],page_metadata:{hasNext:false}};
      else if(url.hostname==='api.sam.gov') data={entityData:[{entityRegistration:{ueiSAM:'FIXTURE-UEI',legalBusinessName:'CVS Health'}}],totalRecords:1};
      else assert.fail('Unexpected fixture transport');
      return new Response(JSON.stringify(data));
    }});
    assert.deepEqual([...new Set(normalized.items.map(sourceKey))].sort(),['fec','lda','ldaContributions','sam','usaspending']);
    const report=await observeRows(normalized.items,data=>{data.sources=normalized.sources;});
    assert.equal(report.status,'incomplete',JSON.stringify(report.calls[0].financialEvidence));
    assert.ok(report.calls[0].financialEvidence.rows.every(row=>row.valid));
    assert.ok(report.calls[0].financialEvidence.rows.some(row=>row.lineage.childIdentityBasis==='content_occurrence_fallback'));
  } finally {if(previous===undefined)delete process.env.DATA_GOV;else process.env.DATA_GOV=previous;}
});

test('USAspending normalized null display Award ID retains generated/transaction identity; omission and malformed values fail',async()=>{
  for(const awardId of [null,undefined,{},[],true,123,'']) {
    const normalized=await fetchMoneyFlows(fixed,{sleep:async()=>{},fetch:async(raw)=>{
      const url=new URL(raw);
      if(url.hostname==='api.usaspending.gov') return new Response(JSON.stringify({results:[
        {'Award ID':awardId,generated_internal_id:'CONT_AWD_KNOWN',transaction_id:'transaction-known','Recipient Name':'CVS Health','Transaction Amount':-10,Mod:'1'},
        {'Award ID':awardId,generated_internal_id:'CONT_AWD_KNOWN','Recipient Name':'CVS Health','Transaction Amount':0,Mod:'2'}
      ],page_metadata:{hasNext:false}}));
      if(url.hostname==='lda.gov')return new Response(JSON.stringify({results:[],next:null}));
      if(url.hostname==='api.open.fec.gov')return new Response(JSON.stringify({results:[],pagination:{last_indexes:null}}));
      if(url.hostname==='api.sam.gov')return new Response(JSON.stringify({entityData:[],totalRecords:0}));
      assert.fail('Unexpected fixture transport');
    }});
    assert.equal(normalized.items.length,2);
    for(const row of normalized.items) {assert.deepEqual(row.awardId,awardId);assert.equal(row.generatedAwardId,'CONT_AWD_KNOWN');}
    const report=await observeRows(normalized.items,data=>{data.sources=normalized.sources;});
    const evidence=report.calls[0].financialEvidence.rows;
    if(awardId===null) {
      assert.equal(report.status,'incomplete',JSON.stringify(evidence));
      assert.equal(report.complete,false);
      assert.deepEqual(evidence.map(row=>row.lineage.awardId),Array(2).fill({state:'unknown',hash:null}));
      assert.deepEqual(evidence.map(row=>row.lineage.identityBasis).sort(),['award_modification_action_composite','provider_transaction_id']);
      assert.equal(new Set(evidence.map(row=>row.identity)).size,2);
      for(const row of evidence) {
        assert.match(row.identity,/^[a-f0-9]{64}$/);
        assert.equal(row.lineage.generatedAwardId.state,'known');assert.match(row.lineage.generatedAwardId.hash,/^[a-f0-9]{64}$/);
        assert.equal(row.amountBasis,'transaction_obligation');
      }
      assert.doesNotMatch(JSON.stringify(report),/CONT_AWD_KNOWN|transaction-known/);
    } else {
      assert.equal(report.status,'invalid_contract',`awardId: ${JSON.stringify(awardId)}`);
      assert.ok(evidence.every(row=>row.errors.includes('invalid_awardId')));
    }
  }
});

test('Invalid financial evidence on a later LDA page stops traversal without retry or fallback',async()=>{
  let calls=0;const delays=[];
  const report=await verifyMoneyCandidate('mcp','https://gha-123-1---situation-room-mcp-fixture.run.app',{now:()=>0,sleep:async ms=>delays.push(ms),fetchImpl:async(raw,init)=>{
    const request=JSON.parse(init.body),data=payload(calls++?'lda_pages':'sample');
    if(calls===2)data.items[0].income='bad';
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{structuredContent:data}}));
  }});
  assert.equal(calls,2);assert.deepEqual(delays,[4100]);assert.equal(report.status,'invalid_contract');
  assert.equal(report.calls[0].valid,true);assert.equal(report.calls[1].valid,false);
  assert.ok(report.calls[1].financialEvidence.rows[0].errors.includes('invalid_income'));
});
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
