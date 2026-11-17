import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('MCP native archive proof gates immutable deployment before any promotion', () => {
  const workflow = fs.readFileSync('.github/workflows/deploy-mcp-proxy.yml', 'utf8');
  assert.ok(workflow.includes('bash scripts/build_mcp_native.sh'));
  assert.doesNotMatch(workflow, /--source gcp\/mcp-proxy/);
  assert.match(workflow, /--image "\$IMAGE"/);
  assert.ok(workflow.indexOf('bash scripts/build_mcp_native.sh') < workflow.indexOf('--image "$IMAGE"'));
  assert.doesNotMatch(workflow, /gcloud builds list/);
});

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { archiveMcp, configMcp, imageMcp, mcpBuild, assertMcpState, assertMcpIdentity } from '../mcp_native_release.mjs';
import { buildFeedManifest } from '../build_feed_manifest.mjs';
const sha = 'a'.repeat(40), tag = 'gha-12-1', candidate = 'situation-room-mcp-' + tag;
function nativeFixture() {
 const archive = {sourceSha:sha,contentSha256:'b'.repeat(64),bucket:mcpBuild.bucket,object:`services/situation-room-mcp/releases/${tag}/source.tgz`,image:`us-central1-docker.pkg.dev/${mcpBuild.project}/${mcpBuild.repository}/situation-room-mcp:${tag}`,bytes:42,md5:Buffer.alloc(16,1).toString('base64'),sha256:Buffer.alloc(32,2).toString('base64')};archive.uri=`gs://${archive.bucket}/${archive.object}`;
 const object={bucket:archive.bucket,name:archive.object,generation:'123',size:'42',md5Hash:archive.md5};const config=configMcp(archive,object),digest='sha256:'+'c'.repeat(64);
 const build={...structuredClone(config),id:'build-1',projectId:mcpBuild.project,name:`projects/${mcpBuild.projectNumber}/locations/us-central1/builds/build-1`,status:'SUCCESS',sourceProvenance:{resolvedStorageSource:config.source.storageSource,fileHashes:{[archive.uri+'#123']:{fileHash:[{type:'SHA256',value:archive.sha256}]}}},results:{images:[{name:archive.image,digest}]}};
 return{archive,object,config,build,submitted:{id:'build-1'},tag,image:archive.image.split(':')[0]+'@'+digest};
}
test('MCP native proof binds exact submitted build, generation, archive and only immutable destination',()=>{
 const f=nativeFixture();assert.equal(imageMcp(f),f.image);assert.ok(f.config.steps[0].args.includes('GOOGLE_NODEJS_VERSION=24.22.1'));
 for(const mutate of [x=>x.submitted.id='latest-unrelated',x=>x.build.status='FAILURE',x=>x.build.source.storageSource.generation='124',x=>delete x.build.sourceProvenance,x=>x.build.sourceProvenance.fileHashes[x.archive.uri+'#123'].fileHash[0].value=Buffer.alloc(32).toString('base64'),x=>x.build.results.images[0].name='unowned',x=>x.build.options.requestedVerifyOption='NOT_VERIFIED',x=>x.build.serviceAccount='other',x=>x.archive.object='services/situation-room-feed/releases/'+tag+'/source.tgz']){
  const x=structuredClone(f);mutate(x);assert.throws(()=>imageMcp(x));
 }
});
test('MCP archive uses exact reviewed buffers, excludes untracked files, pins runtime and fails changed bytes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-archive-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const files={'server.js':'server fixture','package.json':'{"engines":{"node":"24.22.1"}}','feeds.json':'{"feeds":[]}'};
 for(const[k,v]of Object.entries(files))fs.writeFileSync(path.join(dir,k),v);
 const manifest={...buildFeedManifest(dir,sha),schema:'tsr-mcp-build/v1'};fs.writeFileSync(path.join(dir,'build-manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(dir,'.env'),'must not archive');
 const git=(cmd,args)=>{assert.equal(cmd,'git');if(args[0]==='ls-tree'){assert.equal(args.at(-1),sha+':gcp/mcp-proxy');return Buffer.from(Object.keys(files).sort().join('\n'));}assert.ok(args[1].startsWith(sha+':gcp/mcp-proxy/'));return Buffer.from(files[args[1].split('/').at(-1)]);};
 const a=archiveMcp(dir,dir,sha,tag,{git});assert.equal(a.object,`services/situation-room-mcp/releases/${tag}/source.tgz`);assert.equal(a.sha256,createHash('sha256').update(fs.readFileSync(path.join(dir,'source.tgz'))).digest('base64'));
 fs.writeFileSync(path.join(dir,'server.js'),'changed');assert.throws(()=>archiveMcp(dir,dir,sha,tag,{git}),/bytes/);
});
function stateFixture(oldTag='') {
 const annotations={'autoscaling.knative.dev/minScale':'0','autoscaling.knative.dev/maxScale':'20'};
 const spec={containers:[{image:'old@sha256:'+'d'.repeat(64),env:[{name:'DATA_GOV',valueFrom:{secretKeyRef:{name:'key',key:'1'}}}],resources:{limits:{cpu:'1'}}}],timeoutSeconds:900,serviceAccountName:'existing'};
 const before={metadata:{name:'situation-room-mcp',generation:1,annotations:{'run.googleapis.com/minScale':'1','run.googleapis.com/ingress':'all'}},spec:{template:{metadata:{name:'old',annotations},spec},traffic:[{revisionName:'old',percent:100},...(oldTag?[{tag:oldTag,revisionName:'old'}]:[])]},status:{observedGeneration:1,latestCreatedRevisionName:'old',latestReadyRevisionName:'old',traffic:[{revisionName:'old',percent:100},...(oldTag?[{tag:oldTag,revisionName:'old'}]:[])]}};
 const current=structuredClone(before);current.metadata.generation=2;current.status.observedGeneration=2;current.spec.template.metadata.name=candidate;current.spec.template.spec.containers[0].image=nativeFixture().image;for(const k of ['latestCreatedRevisionName','latestReadyRevisionName'])current.status[k]=candidate;
 current.spec.traffic.push({tag,revisionName:candidate});current.status.traffic.push({tag,revisionName:candidate});
 const iam={bindings:[{role:'roles/run.invoker',members:['allUsers']}],etag:'same'};
 const beforeRevision={metadata:{name:'old',annotations},spec},revision={metadata:{name:candidate,annotations},spec:structuredClone(current.spec.template.spec),status:{imageDigest:nativeFixture().image,conditions:[{type:'Ready',status:'True'}]}};
 return{before,current,iamBefore:iam,iamCurrent:structuredClone(iam),candidate,tag,oldTag,phase:'candidate',beforeRevision,revision};
}
test('MCP state preserves every nonimage config, policy, minimum/max, secrets, desired traffic and exact tags',()=>{
 for(const oldTag of ['', 'accepted-old']){
 const f=stateFixture(oldTag);assertMcpState(f);
 for(const mutate of [x=>x.current.spec.template.spec.timeoutSeconds=100,x=>x.current.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key='latest',x=>x.current.metadata.annotations['run.googleapis.com/ingress']='internal',x=>x.iamCurrent.bindings[0].members=[],x=>x.current.spec.template.metadata.annotations['autoscaling.knative.dev/maxScale']='21',x=>x.current.status.traffic[0].percent=99,x=>x.current.status.latestReadyRevisionName='unrelated',x=>x.current.status.traffic.push({tag:'intruder',revisionName:'old'}),x=>x.current.spec.traffic.push({latestRevision:true,percent:0})]){const x=structuredClone(f);mutate(x);assert.throws(()=>assertMcpState(x));}
 }
});
test('MCP state guards promotion, single owned recovery, final cleanup and foreign traffic refusal',()=>{
 const f=stateFixture();for(const s of [f.current.spec,f.current.status])s.traffic=[{revisionName:candidate,percent:100},{tag,revisionName:candidate}];assertMcpState({...f,phase:'promoted'});assertMcpState({...f,phase:'recover'});
 f.current.status.traffic=[{revisionName:'foreign',percent:100},{tag,revisionName:candidate}];assert.throws(()=>assertMcpState({...f,phase:'recover'}));
 for(const s of [f.current.spec,f.current.status])s.traffic=[{revisionName:candidate,percent:100}];assertMcpState({...f,phase:'cleaned'});
 for(const s of [f.current.spec,f.current.status])s.traffic=[{revisionName:'old',percent:100}];assertMcpState({...f,phase:'cleaned-restored'});
});
test('MCP runtime identity refuses unverified packaged bytes, another source, revision or image',()=>{
 const f=stateFixture(),build=nativeFixture(),manifest={sourceSha:sha,contentSha256:'b'.repeat(64)};
 const data={identity:{available:true,schema:'tsr-mcp-build/v1',...manifest,service:'situation-room-mcp',revision:candidate},manifest,candidate,image:build.image,revision:f.revision};assertMcpIdentity(data);
 for(const mutate of [x=>x.identity.available=false,x=>x.identity.sourceSha='e'.repeat(40),x=>x.identity.contentSha256='e'.repeat(64),x=>x.identity.revision='other',x=>x.revision.spec.containers[0].image='wrong']){const x=structuredClone(data);mutate(x);assert.throws(()=>assertMcpIdentity(x));}
});

import { spawnSync } from 'node:child_process';
test('Actual MCP build script submits once, verifies native proof, and stops on prerequisite/provenance refusals', t=>{
 const realScripts=path.resolve('scripts');
 for(const scenario of ['success','missing-api','bad-provenance','upload-refused']){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-native-shell-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.symlinkSync(realScripts,path.join(dir,'scripts'));const root=path.join(dir,'gcp','mcp-proxy'),bin=path.join(dir,'bin'),diag=path.join(dir,'diagnostics');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(bin);fs.mkdirSync(diag);
 const files={'server.js':'console.log("fixture")','package.json':'{"engines":{"node":"24.22.1"}}','feeds.json':'{"feeds":[]}'};
 for(const[k,v]of Object.entries(files))fs.writeFileSync(path.join(root,k),v);
 fs.writeFileSync(path.join(dir,'files.json'),JSON.stringify(files));fs.writeFileSync(path.join(dir,'identity.json'),JSON.stringify({type:'service_account',client_email:mcpBuild.principal}));fs.writeFileSync(path.join(diag,'release.json'),JSON.stringify({tag,candidate,oldTag:''}));
 const executable=(name,code)=>{fs.writeFileSync(path.join(bin,name),'#!'+process.execPath+'\n'+code,{mode:0o755});};
 // Each shim is already a fresh Node process; execute the real CLI main here
 // with its real argv rather than starting a second interpreter.
 executable('node',`const fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);if(a[0]&&!a[0].startsWith('-')){const file=fs.realpathSync(a[0]);process.argv=[process.execPath,file,...a.slice(1)];import(require('node:url').pathToFileURL(file).href).catch(error=>{console.error(error);process.exitCode=1;});}else{const r=cp.spawnSync(process.execPath,a,{stdio:'inherit'});process.exit(r.status??1);}`);
 executable('git',`const fs=require('node:fs');const a=process.argv.slice(2),files=JSON.parse(fs.readFileSync(process.env.FIXTURE_DIR+'/files.json'));if(a[0]==='rev-parse')console.log('${sha}');else if(a[0]==='ls-tree')console.log(Object.keys(files).sort().join('\\n'));else if(a[0]==='show')process.stdout.write(files[a[1].split('/').at(-1)]);else process.exit(8);`);
 executable('gcloud',`const fs=require('node:fs'),crypto=require('node:crypto');const a=process.argv.slice(2),d=process.env.DIAG_DIR;fs.appendFileSync(d+'/cloud-commands.jsonl',JSON.stringify(a)+'\\n');const read=n=>JSON.parse(fs.readFileSync(d+'/'+n+'.json'));const out=x=>console.log(JSON.stringify(x));
 if(a[0]==='config'){const props={'core/should_prompt_to_enable_api':'false','auth/credential_file_override':process.env.FIXTURE_DIR+'/identity.json'};console.log(props[a[2]]||'');}
 else if(a[0]==='storage'&&a[1]==='buckets')out({name:'${mcpBuild.bucket}',projectNumber:'${mcpBuild.projectNumber}',location:'US-CENTRAL1'});
 else if(a[0]==='artifacts')out({name:'projects/${mcpBuild.project}/locations/us-central1/repositories/${mcpBuild.repository}',format:'DOCKER'});
 else if(a[0]==='iam')out({email:'${mcpBuild.buildAccount}',disabled:false});
 else if(a[0]==='services'){let names=['cloudbuild.googleapis.com','run.googleapis.com','artifactregistry.googleapis.com','storage.googleapis.com','containeranalysis.googleapis.com'];if(process.env.SCENARIO==='missing-api')names.pop();out(names.map(name=>({config:{name},name:'projects/${mcpBuild.projectNumber}/services/'+name,state:'ENABLED'})));}
 else if(a[0]==='storage'&&a[1]==='cp'){if(!a.includes('--if-generation-match=0')||process.env.SCENARIO==='upload-refused')process.exit(7);}
 else if(a[0]==='storage'&&a[1]==='objects'){const x=read('archive');out({bucket:x.bucket,name:x.object,generation:'123',size:String(x.bytes),md5Hash:x.md5});}
 else if(a[0]==='builds'&&a[1]==='submit'){if(!a.includes('--no-source'))process.exit(8);out({id:'exact-build'});}
 else if(a[0]==='builds'&&a[1]==='describe'){if(a[2]!=='exact-build')process.exit(9);const x=read('archive'),c=read('build-config');out({...c,id:'exact-build',projectId:'${mcpBuild.project}',name:'projects/${mcpBuild.project}/locations/us-central1/builds/exact-build',status:'SUCCESS',sourceProvenance:{resolvedStorageSource:c.source.storageSource,fileHashes:{[x.uri+'#123']:{fileHash:[{type:'SHA256',value:process.env.SCENARIO==='bad-provenance'?Buffer.alloc(32).toString('base64'):x.sha256}]}}},results:{images:[{name:x.image,digest:'sha256:'+'c'.repeat(64)}]}});}
 else process.exit(10);`);
 const run=spawnSync('bash',[path.join(realScripts,'build_mcp_native.sh')],{cwd:dir,encoding:'utf8',env:{PATH:bin+':'+path.dirname(process.execPath)+':/usr/bin:/bin',FIXTURE_DIR:dir,SCENARIO:scenario,PROJECT_ID:mcpBuild.project,REGION:mcpBuild.region,SERVICE_NAME:mcpBuild.service,GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',DIAG_DIR:diag,SYNC_SECRET_VERSIONS:'false',GOOGLE_GHA_CREDS_PATH:path.join(dir,'identity.json')}});
 const calls=fs.readFileSync(path.join(diag,'cloud-commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(x=>!x.includes('list')||x[0]==='services'));assert.ok(calls.every(x=>!['run','secrets'].includes(x[0])));assert.ok(calls.filter(x=>x[0]==='builds'&&x[1]==='submit').length<=1);
 if(scenario==='success'){assert.equal(run.status,0,run.stderr);assert.match(fs.readFileSync(path.join(diag,'immutable-image.txt'),'utf8'),/situation-room-mcp@sha256:c{64}/);}
 else{assert.notEqual(run.status,0,scenario);assert.ok(!fs.existsSync(path.join(diag,'immutable-image.txt'))||!fs.readFileSync(path.join(diag,'immutable-image.txt'),'utf8').trim());if(scenario==='missing-api'||scenario==='upload-refused')assert.equal(calls.filter(x=>x[0]==='builds').length,0);}
 }
});

import { readBuildIdentity as readMcpBuildIdentity } from '../../gcp/mcp-proxy/build-identity.js';
test('MCP runtime identity rehashes actual packaged bytes and fails closed after tampering',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-runtime-identity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'server.js'),'exact runtime bytes');fs.writeFileSync(path.join(dir,'feeds.json'),'{}');
 const manifest={...buildFeedManifest(dir,sha),schema:'tsr-mcp-build/v1'};fs.writeFileSync(path.join(dir,'build-manifest.json'),JSON.stringify(manifest));
 const identity=readMcpBuildIdentity(dir,{K_SERVICE:'situation-room-mcp',K_REVISION:candidate});assert.equal(identity.available,true);assert.equal(identity.contentSha256,manifest.contentSha256);
 fs.writeFileSync(path.join(dir,'server.js'),'different bytes');assert.equal(readMcpBuildIdentity(dir).available,false);
});
test('MCP rejects queued foreign desired traffic, labels and loss of public IAM even before observation changes',()=>{
 for(const mutate of [x=>x.current.spec.traffic[0].revisionName=candidate,x=>x.current.metadata.labels={changed:'true'},x=>{x.iamBefore.bindings=[];x.iamCurrent.bindings=[];}]){const f=stateFixture();mutate(f);assert.throws(()=>assertMcpState(f));}
});

test('Failed MCP deploy cleanup needs no Ready candidate or success-only file, but refuses any unowned change',t=>{
 const f=stateFixture('accepted-old');f.phase='failed-cleanup';f.image=nativeFixture().image;delete f.revision;
 f.current.status.latestReadyRevisionName=f.before.status.latestReadyRevisionName;
 assertMcpState(f);
 for(const mutate of [x=>x.current.status.traffic[0].revisionName=candidate,x=>x.current.spec.template.spec.containers[0].image='unowned',x=>x.current.status.traffic.at(-1).revisionName='foreign',x=>x.current.metadata.annotations['run.googleapis.com/ingress']='internal',x=>x.iamCurrent.bindings=[],x=>x.current.status.observedGeneration=1]){const x=structuredClone(f);mutate(x);assert.throws(()=>assertMcpState(x));}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-failed-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const b=nativeFixture();for(const[name,value]of Object.entries({'service-before':f.before,'service-current':f.current,'iam-before':f.iamBefore,'iam-current':f.iamCurrent,'revision-before':f.beforeRevision,release:{tag,candidate,oldTag:'accepted-old'},build:b.build,'build-submitted':b.submitted,archive:b.archive,'source-object':b.object,'build-config':b.config}))fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
 assert.equal(fs.existsSync(path.join(dir,'revision-candidate.json')),false);
 const result=spawnSync(process.execPath,['scripts/mcp_native_release.mjs','state',dir,'failed-cleanup'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 for(const state of [f.current.spec,f.current.status])state.traffic=state.traffic.filter(x=>x.tag!==tag);
 assertMcpState({...f,phase:'failed-cleaned'});
 const workflow=fs.readFileSync('.github/workflows/deploy-mcp-proxy.yml','utf8');const cleanup=workflow.split("name: Remove this release's temporary smoke tag")[1];assert.ok(cleanup.indexOf('failed-cleanup')<cleanup.indexOf('check_mcp_state.sh recover'));assert.ok(cleanup.includes('failed-cleaned'));
});

test('Successful MCP deploy with missing candidate snapshot cleans only its owned tag without promotion or traffic restoration', t=>{
 const workflow=fs.readFileSync('.github/workflows/deploy-mcp-proxy.yml','utf8');
 const block=workflow.split("      - name: Remove this release's temporary smoke tag\n")[1].split('\n      - name:')[0];
 const shell=block.split('        run: |\n')[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
 for(const scenario of ['full','candidate-only','old-tag','config-drift','secret-drift','iam-drift','foreign-traffic','foreign-tag','unowned-image','missing-provenance','promoted']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-success-no-snapshot-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=stateFixture(scenario==='old-tag'?'accepted-old':'');const b=nativeFixture();
  if(scenario==='config-drift')f.current.spec.template.spec.timeoutSeconds=1;
  if(scenario==='secret-drift')f.current.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key='latest';
  if(scenario==='iam-drift')f.iamCurrent.bindings=[];
  if(scenario==='foreign-traffic')for(const s of[f.current.spec,f.current.status])s.traffic[0].revisionName='foreign';
  if(scenario==='foreign-tag')for(const s of[f.current.spec,f.current.status])s.traffic.push({tag:'intruder',revisionName:'old'});
  if(scenario==='unowned-image')f.current.spec.template.spec.containers[0].image='unowned';
  if(scenario==='missing-provenance')delete b.build.sourceProvenance;
  if(scenario==='promoted')for(const s of[f.current.spec,f.current.status])s.traffic[0]={revisionName:candidate,percent:100};
  for(const[name,value]of Object.entries({'service-before':f.before,'service-current':f.current,'fixture-service':f.current,'iam-before':f.iamBefore,'iam-current':f.iamCurrent,'fixture-iam':f.iamCurrent,'revision-before':f.beforeRevision,release:{tag,candidate,oldTag:f.oldTag},build:b.build,'build-submitted':b.submitted,archive:b.archive,'source-object':b.object,'build-config':b.config}))fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'gcloud'),'#!'+process.execPath+'\n'+`const fs=require('node:fs'),p=process.env.DIAG_DIR,a=process.argv.slice(2);fs.appendFileSync(p+'/commands.jsonl',JSON.stringify(a)+'\\n');const read=n=>JSON.parse(fs.readFileSync(p+'/'+n+'.json'));if(a[0]!=='run'||a[1]!=='services')process.exit(8);if(a[2]==='describe')console.log(JSON.stringify(read('fixture-service')));else if(a[2]==='get-iam-policy')console.log(JSON.stringify(read('fixture-iam')));else if(a[2]==='update-traffic'){if(a[a.indexOf('--remove-tags')+1]!=='${tag}'||a.includes('--to-revisions'))process.exit(9);const x=read('fixture-service');for(const s of[x.spec,x.status])s.traffic=s.traffic.filter(v=>v.tag!=='${tag}');fs.writeFileSync(p+'/fixture-service.json',JSON.stringify(x));}else process.exit(10);`,{mode:0o755});
  const substitutions={'steps.deploy.outputs.candidate_revision':candidate,'steps.deploy.outputs.candidate_tag':tag,'steps.deploy.outputs.deploy_succeeded':'true','inputs.candidate_only':String(scenario==='candidate-only'),'steps.current.outputs.rollback_revision':'old','steps.promote.outcome':'skipped','steps.canonical.outcome':'skipped'};
  let code=shell.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,(_,k)=>{assert.ok(k in substitutions,k);return substitutions[k];}).replaceAll('/tmp/mcp-diagnostics',dir).replaceAll('/tmp/mcp-service-cleanup.json',dir+'/cleanup.json');
  assert.equal(fs.existsSync(path.join(dir,'revision-candidate.json')),false);
  const run=spawnSync('bash',['-c',code],{encoding:'utf8',env:{PATH:bin+':'+path.dirname(process.execPath)+':/usr/bin:/bin',DIAG_DIR:dir,PROJECT_ID:mcpBuild.project,REGION:mcpBuild.region,SERVICE_NAME:mcpBuild.service,EXPECTED_SERVING_TAG:f.oldTag}});
  const calls=fs.readFileSync(path.join(dir,'commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse),writes=calls.filter(a=>a[2]==='update-traffic');
  if(['full','candidate-only','old-tag'].includes(scenario)){
   assert.equal(run.status,0,scenario+': '+run.stderr);assert.equal(writes.length,1);const final=JSON.parse(fs.readFileSync(path.join(dir,'service-final.json')));assert.deepEqual(final.status.traffic,f.before.status.traffic);assert.ok(!fs.existsSync(path.join(dir,'rollback-once')));
  }else{assert.notEqual(run.status,0,scenario);assert.equal(writes.length,0,scenario);}
 }
});
