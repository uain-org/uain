import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createClaudeProvider} from '../src/claude-provider.mjs';
import {parseFenced} from '../src/leadership.mjs';
import {assessPriorArt} from '../ops/manager-stage.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function provider(t,answer){
 const root=await realpath(await mkdtemp(join(tmpdir(),'core-claude-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=join(root,'claude'),body=`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[a.indexOf('--tools')+1]!==''||a[a.indexOf('--allowedTools')+1]!=='')process.exit(8);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.01,modelUsage:{'claude-sonnet-5-5':{}},structured_output:${JSON.stringify(answer)}}));`;
 await writeFile(executable,body,{mode:0o700});return createClaudeProvider({executable,sha256:sha(body),budgetDirectory:join(root,'budget'),env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture'},fixture:true});
}
test('Claude role provider uses tool-free real subprocess and attributed neutral envelope with separate execution IDs',async t=>{
 const answer={main_kpi:'Fixture fixed KPI',strategy:'Fixture public strategy',blockers:[]},p=await provider(t,answer);
 for(const executionId of ['fixture-1','fixture-2']){
  const out=await p.execute({role:'ceo',projectId:'OPP-00004',executionId,prompt:'Fixture only'});
  assert.deepEqual(parseFenced(out.raw),answer);assert.equal(JSON.parse(out.raw).provider,'claude');assert.ok(!out.raw.includes('agent_message'));
  assert.equal(out.receipt.executionId,executionId);assert.equal(out.receipt.actual,false);assert.equal(out.receipt.model,'claude-sonnet-5-5');assert.match(out.receipt.nativeRawDigest,/^[a-f0-9]{64}$/);
 }
 await assert.rejects(p.execute({role:'ceo',projectId:'OPP-00004',executionId:'fixture-1',prompt:'fixture'}));
});
test('unsupported roles and nonconforming role JSON refuse; assessor consumes same neutral parser without gaining authority',async t=>{
 const p=await provider(t,{openSolutionFound:true,knownAnswer:false,rationale:'Fixture uncertain prior art; no novelty accepted.'});
 await assert.rejects(p.execute({role:'fund-manager',projectId:'OPP-00004',executionId:'fm',prompt:'fixture'}));
 await assert.rejects(p.execute({role:'ceo',projectId:'OPP-00004',executionId:'bad',prompt:'fixture'}));
 // Fixtures cannot claim actual assessment even with valid role output.
 const assessed=await assessPriorArt({provider:p,projectId:'OPP-00004',task:{title:'Fixture task',criteria:'Fixture strict criteria'},searches:[],pendingId:'fixture',newId:()=> 'assessment-1'});
 assert.equal(assessed.record.reason,'assessment_not_actual');assert.equal(assessed.assessment,null);
});

test('manager price and candidate JSON stays strict and assessor result remains Claude attributed',async t=>{
 const answer={main_kpi:'Fixture fixed KPI',round:1,tasks:[{title:'Fixture task',criteria:'Fixture exact criteria',eligibility:'new',eligibility_basis:'Fixture basis without approval',candidate_id:null,proposed_price:{solver_amount:'1',reviewer_amount:'1',rationale:{effort:'fixture',difficulty:'fixture',novelty:'fixture',verificationCost:'fixture'}}}]};
 const p=await provider(t,answer),out=await p.execute({role:'manager',projectId:'OPP-00004',executionId:'pm-1',prompt:'Fixture only'});
 assert.deepEqual(parseFenced(out.raw,{role:'manager',executionId:'pm-1',model:p.model}),answer);
 assert.deepEqual(out.receipt.reportedModels,['claude-sonnet-5-5']);assert.equal(out.receipt.provider,'claude');
 const assessor=await provider(t,{openSolutionFound:true,knownAnswer:false,rationale:'Fixture evidence remains uncertain.'});
 const assessment=await assessor.execute({role:'assessor',projectId:'OPP-00004',executionId:'pa-1',prompt:'Fixture only'});
 assert.equal(parseFenced(assessment.raw,{role:'assessor',executionId:'pa-1'}).openSolutionFound,true);
});

test('an uncertain execution stays claimed after provider recreation without another spawn or budget reservation',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'core-claude-reopen-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=join(root,'claude'),marker=join(root,'spawns'),budgetDirectory=join(root,'budget');
 const body="#!/bin/sh\nprintf 'spawn\\n' >> '"+marker.replaceAll("'","'\\''")+"'\nsleep 60\n";
 await writeFile(executable,body,{mode:0o700});
 const config={executable,sha256:sha(body),budgetDirectory,env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture'},fixture:true,timeoutMs:200};
 const input={role:'ceo',projectId:'OPP-00004',executionId:'uncertain-preserved',prompt:'Fixture only'};
 await assert.rejects(createClaudeProvider(config).execute(input),e=>e.message==='provider timeout');
 await assert.rejects(createClaudeProvider(config).execute(input),e=>e.code==='claude_execution_already_claimed');
 const {readFile}=await import('node:fs/promises');
 const rows=(await readFile(join(budgetDirectory,'receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,1,'a recreated provider cannot reserve/spawn the execution again');assert.equal(rows[0].status,'reserved');
 const claim=JSON.parse(await readFile(join(budgetDirectory,'claude-executions',sha(input.executionId)+'.json'),'utf8'));
 assert.equal(claim.executionId,input.executionId);assert.equal(claim.role,input.role);assert.equal(claim.projectId,input.projectId);assert.equal(claim.promptDigest,sha(input.prompt));
});

test('explicit subscription core provider keeps durable execution claim and leaves exhausted API journal untouched',async t=>{
 const {readFile}=await import('node:fs/promises');const root=await realpath(await mkdtemp(join(tmpdir(),'core-claude-sub-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=join(root,'claude'),budgetDirectory=join(root,'budget');const answer={main_kpi:'Fixture fixed KPI',strategy:'Fixture attributed strategy',blockers:[]};
 const body=`#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('auth'))console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}));else{if(a.includes('--max-budget-usd')||a[a.indexOf('--tools')+1]!=='')process.exit(8);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:3,structured_output:${JSON.stringify(answer)}}));}`;
 await writeFile(executable,body,{mode:0o700});const {openComputeBudget}=await import('../src/compute-budget.mjs');const b=openComputeBudget({directory:budgetDirectory});for(let i=0;i<2;i++)b.reserve({purpose:'fixture',projectIds:['OPP-99999'],model:'fixture'});const receipts=await readFile(join(budgetDirectory,'receipts.jsonl'),'utf8');
 const config={executable,sha256:sha(body),budgetDirectory,env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture'},fixture:true,usageSource:'subscription'};
 const input={role:'ceo',projectId:'OPP-00004',executionId:'fixture-subscription',prompt:'Fixture only'};const out=await createClaudeProvider(config).execute(input);
 assert.deepEqual(parseFenced(out.raw),answer);assert.equal(out.receipt.usageSource,'subscription');assert.equal(out.receipt.costBasis,'api-equivalent-estimate');assert.equal(out.receipt.authentication.authMethod,'oauth_token');assert.equal(await readFile(join(budgetDirectory,'receipts.jsonl'),'utf8'),receipts);
 const claim=JSON.parse(await readFile(join(budgetDirectory,'claude-executions',sha(input.executionId)+'.json'),'utf8'));assert.equal(claim.usageSource,'subscription');
 await assert.rejects(createClaudeProvider({...config,usageSource:'api'}).execute(input),e=>e.code==='claude_execution_already_claimed');assert.throws(()=>createClaudeProvider({...config,usageSource:'free'}));
});
