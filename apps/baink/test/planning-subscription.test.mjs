import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runPlanningSubscription,planningSubscriptionHeldProjects,planningSubscriptionEnvironment} from '../ops/planning-subscription.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{status={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'},hang=false,structuredOutput={plans:[{projectId:"OPP-00001"}]},requireUser=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'planning-subscription-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const marker=join(root,'calls'),executable=join(root,'claude');
 const body=`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const auth=a.includes('auth');if(process.cwd()===${JSON.stringify(root)})process.exit(44);const context=${JSON.stringify(join(root,'cwd'))};if(auth)fs.writeFileSync(context,process.cwd());else if(fs.readFileSync(context,'utf8')!==process.cwd())process.exit(45);fs.appendFileSync(${JSON.stringify(marker)},auth?'auth\\n':'model\\n');if(auth&&${requireUser}&&process.env.USER!==require('node:os').userInfo().username){console.log(JSON.stringify({loggedIn:false,authMethod:'none',apiProvider:'firstParty'}));process.exit(1);}if(auth)console.log(JSON.stringify(${JSON.stringify(status)}));else{if(a.includes('--max-budget-usd')||a[a.indexOf('--tools')+1]!==''||a[a.indexOf('--allowedTools')+1]!=='')process.exit(12);${hang?'setInterval(()=>{},1000)':'console.log('+JSON.stringify(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:7.5,structured_output:structuredOutput}))+')'};}`;
 await writeFile(executable,body,{mode:0o700});
 return{root,marker,options:{directory:root,executable,executableSha256:sha(body),model:'claude-sonnet-5-5',prompt:'Fixture source context only',schema:JSON.stringify({type:'object'}),sources:[{projectId:'OPP-00001',sourceDigest:'a'.repeat(64)}],env:{HOME:root,PATH:'/usr/bin:/bin'},timeoutMs:hang?1000:3000}};
}
test('verified keychain subscription bypasses dollar ledger and durably reuses exact response',async t=>{
 const {root,marker,options}=await fixture(t);const receipts='{"at":"2026-11-08T00:00:00Z","projectIds":["OPP-99999"],"model":"fixture","costUsd":25,"status":"reserved","purpose":"project_manager_plan"}\n';await writeFile(join(root,'receipts.jsonl'),receipts,{mode:0o600});
 const first=await runPlanningSubscription(options);assert.equal(first.metadata.costBasis,'api-equivalent-estimate');assert.equal(first.metadata.authentication.subscriptionType,'max');assert.equal(first.metadata.estimatedCostUsd,7.5);assert.equal(first.cached,false);
 const second=await runPlanningSubscription(options);assert.equal(second.cached,true);assert.equal(first.stdout,second.stdout);assert.equal(await readFile(marker,'utf8'),'auth\nmodel\n');assert.equal(await readFile(join(root,'receipts.jsonl'),'utf8'),receipts);await assert.rejects(stat(join(root,'compute-budget-policy.json')),{code:'ENOENT'});
});
test('API credentials or non-subscription status refuse before inference',async t=>{
 const a=await fixture(t);await assert.rejects(runPlanningSubscription({...a.options,env:{...a.options.env,ANTHROPIC_API_KEY:'fixture-only'}}),/subscription/);await assert.rejects(stat(a.marker),{code:'ENOENT'});
 const b=await fixture(t,{status:{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}});await assert.rejects(runPlanningSubscription(b.options),/subscription/);assert.equal(await readFile(b.marker,'utf8'),'auth\n');
});
test('unknown model execution prevents recreation and changed prompt or model cannot evade held project',async t=>{
 const {marker,options}=await fixture(t,{hang:true});await assert.rejects(runPlanningSubscription(options));
 await assert.rejects(runPlanningSubscription(options),/uncertain/);const{readdir}=await import('node:fs/promises');const request=(await readdir(join(options.directory,'subscription-executions'))).find(n=>n.endsWith('.request.json'));await writeFile(join(options.directory,'subscription-executions',request.replace('.request.','.response.')),'{',{mode:0o600});await assert.rejects(runPlanningSubscription({...options,prompt:'Changed prompt',model:'another-model'}),/uncertain/);assert.equal(await readFile(marker,'utf8'),'auth\nmodel\n');assert.deepEqual(await planningSubscriptionHeldProjects(options.directory,{includeLegacy:false}),['OPP-00001']);
});
test('legacy unknown planning reservation for overlapping project is not erased or bypassed',async t=>{
 const {root,marker,options}=await fixture(t);const rows='{"at":"2026-11-08T00:00:00Z","projectIds":["OPP-00001"],"model":"claude-sonnet-5-5","costUsd":2,"status":"reserved"}\n';await writeFile(join(root,'receipts.jsonl'),rows,{mode:0o600});
 await assert.rejects(runPlanningSubscription(options),/uncertain/);assert.equal(await readFile(join(root,'receipts.jsonl'),'utf8'),rows);await assert.rejects(stat(marker),{code:'ENOENT'});
});
test('pinned executable drift refuses before auth and overlapping concurrent execution runs once',async t=>{
 const a=await fixture(t);await writeFile(a.options.executable,'modified',{mode:0o700});await assert.rejects(runPlanningSubscription(a.options),/executable/);await assert.rejects(stat(a.marker),{code:'ENOENT'});
 const b=await fixture(t);const outcomes=await Promise.allSettled([runPlanningSubscription(b.options),runPlanningSubscription({...b.options,prompt:"Another prepared prompt"})]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(await readFile(b.marker,'utf8'),'auth\nmodel\n');
});

test('actual intake worker publishes a verified subscription batch locally despite full unrelated dollar journal',async t=>{
 const {worker}=await import('../ops/project-manager-worker.mjs');
 const plan={projectId:'OPP-00001',summary:'Check the original source evidence and establish a reproducible baseline before any research proposal is accepted.',tasks:[{title:'Identify original evidence sources',criteria:'List dated original sources, reproducibility constraints and unresolved questions with attributable evidence.',expectedEffort:'30 minutes'},{title:'Define baseline measurement criteria',criteria:'Record a falsifiable baseline and repeatable measurement method without claiming an achieved research result.',expectedEffort:'30 minutes'}],evidenceNeeded:['Dated original evidence sources'],suggestedSearches:['Original primary evidence sources','Baseline reproducibility measurement method']};
 const {root,marker,options}=await fixture(t,{structuredOutput:{plans:[plan]}});const rows='{"at":"2026-11-08T00:00:00Z","projectIds":["OPP-99999"],"model":"fixture","costUsd":25,"status":"reserved","purpose":"project_manager_plan"}\n';await writeFile(join(root,'receipts.jsonl'),rows,{mode:0o600});
 const progress=[];const result=await worker({directory:root,limit:1,claude:options.executable,executableSha256:options.executableSha256,usageSource:'subscription',env:options.env,onProgress:x=>progress.push(JSON.parse(x))});
 assert.equal(result.generated,1);assert.equal(result.batchWritten,true);assert.ok(progress.some(x=>x.usageSource==='subscription'&&x.costBasis==='api-equivalent-estimate'));assert.equal(await readFile(marker,'utf8'),'auth\nmodel\n');assert.equal(await readFile(join(root,'receipts.jsonl'),'utf8'),rows);await assert.rejects(stat(join(root,'compute-budget-policy.json')),{code:'ENOENT'});
 const batch=JSON.parse(await readFile(join(root,'plans.json'),'utf8'));assert.equal(batch.plans[0].projectId,'OPP-00001');assert.match(batch.plans[0].sourceDigest,/^[a-f0-9]{64}$/);
});
test('actual intake default API admission still pauses at existing full dollar cap without invoking CLI',async t=>{
 const {worker}=await import('../ops/project-manager-worker.mjs');const {root,marker,options}=await fixture(t);const rows='{"at":"2026-11-08T00:00:00Z","projectIds":["OPP-99999"],"model":"fixture","costUsd":25,"status":"reserved","purpose":"project_manager_plan"}\n';await writeFile(join(root,'receipts.jsonl'),rows,{mode:0o600});let paused;
 const result=await worker({directory:root,limit:1,claude:options.executable,onProgress:x=>{if(JSON.parse(x).paused)paused=JSON.parse(x);}});assert.equal(result.generated,0);assert.equal(paused.paused,'compute_budget');await assert.rejects(stat(marker),{code:'ENOENT'});assert.equal(await readFile(join(root,'receipts.jsonl'),'utf8'),rows);
});

test('subscription intake skips only unknown legacy projects and continues independent work without clearing receipts',async t=>{
 const {worker}=await import('../ops/project-manager-worker.mjs');const plan={projectId:'OPP-00002',summary:'Check the original source evidence and establish a reproducible baseline before any research proposal is accepted.',tasks:[{title:'Identify original evidence sources',criteria:'List dated original sources, reproducibility constraints and unresolved questions with attributable evidence.',expectedEffort:'30 minutes'},{title:'Define baseline measurement criteria',criteria:'Record a falsifiable baseline and repeatable measurement method without claiming an achieved research result.',expectedEffort:'30 minutes'}],evidenceNeeded:['Dated original evidence sources'],suggestedSearches:['Original primary evidence sources','Baseline reproducibility measurement method']};
 const {root,marker,options}=await fixture(t,{structuredOutput:{plans:[plan]}});const rows='{"at":"2026-11-08T00:00:00Z","projectIds":["OPP-00001"],"model":"fixture","costUsd":2,"status":"reserved"}\n';await writeFile(join(root,'receipts.jsonl'),rows,{mode:0o600});const progress=[];
 const result=await worker({directory:root,limit:1,claude:options.executable,executableSha256:options.executableSha256,usageSource:'subscription',env:options.env,onProgress:x=>progress.push(JSON.parse(x))});assert.equal(result.generated,1);assert.equal(JSON.parse(await readFile(join(root,'plans.json'),'utf8')).plans[0].projectId,'OPP-00002');assert.deepEqual(progress.find(x=>x.held==='uncertain_prior_execution').heldProjects,['OPP-00001']);assert.equal(await readFile(join(root,'receipts.jsonl'),'utf8'),rows);assert.equal(await readFile(marker,'utf8'),'auth\nmodel\n');
});

test('keychain account lookup keeps trusted OS USER while rejecting caller-selected account routing',async t=>{
 const {marker,options}=await fixture(t,{requireUser:true});const caller={...options.env,USER:'untrusted-account-name'};
 assert.equal(planningSubscriptionEnvironment(caller).USER,userInfo().username);
 const result=await runPlanningSubscription({...options,env:caller});
 assert.equal(result.metadata.authentication.subscriptionType,'max');assert.equal(await readFile(marker,'utf8'),'auth\nmodel\n');
});
