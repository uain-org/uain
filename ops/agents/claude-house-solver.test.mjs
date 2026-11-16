import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm,stat,realpath,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runClaude} from './claude-house-solver.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,body){
 const root=await realpath(await mkdtemp(join(tmpdir(),'claude-house-test-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=join(root,'claude');const script=`#!${process.execPath}\n${body}`;await writeFile(executable,script,{mode:0o700});
 return{root,executable,sha256:sha(script),role:'solver',budgetDirectory:join(root,'budget'),projectId:'P-OPP-00004',prompt:'fixture prompt',env:{ANTHROPIC_API_KEY:'fixture-only',UNRELATED_SECRET:'must-not-propagate'}};
}
const output={verdict:'NO_FINDING',evidence:'',selfCheck:'No fixture result'};
test('pinned subprocess gets only web tools, isolated settings/cwd, stdin prompt; output is exact structured JSON',async t=>{
 const f=await fixture(t,`const fs=require('fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify('/tmp/unused-placeholder')},'');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.01,structured_output:${JSON.stringify(output)},result:JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt:s,secret:process.env.UNRELATED_SECRET,mode:fs.statSync(process.cwd()).mode&511})}));});`);
 // Record subprocess arguments in a separate fixture-owned file, never production output.
 const capture=join(f.root,'capture');let script=await readFile(f.executable,'utf8');script=script.replace("fs.writeFileSync(\"/tmp/unused-placeholder\",'');",`fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt:s,secret:process.env.UNRELATED_SECRET,mode:fs.statSync(process.cwd()).mode&511}));`);await writeFile(f.executable,script);f.sha256=sha(script);
 assert.deepEqual(await runClaude(f),output);
 const c=JSON.parse(await readFile(capture,'utf8'));assert.equal(c.prompt,f.prompt);assert.equal(c.mode,0o700);assert.equal(c.secret,undefined);assert.notEqual(c.cwd,f.root);
 for(const flag of ['--no-chrome','--no-session-persistence','--disable-slash-commands','--strict-mcp-config','--json-schema'])assert.ok(c.args.includes(flag));
 assert.equal(c.args[c.args.indexOf('--tools')+1],'WebSearch,WebFetch');assert.equal(c.args[c.args.indexOf('--max-budget-usd')+1],'0.50');
 assert.equal(c.args[c.args.indexOf('--settings')+1],'{"disableAllHooks":true}');assert.equal(c.args[c.args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 await assert.rejects(stat(c.cwd),{code:'ENOENT'});
 const rows=(await readFile(join(f.budgetDirectory,'receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows[0].costUsd,0.01);assert.equal(rows[0].status,'returned');
});
test('invalid pins, unsafe executable permissions, malformed output and timeouts fail closed',async t=>{
 const f=await fixture(t,`console.log('invalid provider output')`);
 await assert.rejects(runClaude({...f,sha256:'0'.repeat(64)}));await chmod(f.executable,0o777);await assert.rejects(runClaude(f));await chmod(f.executable,0o700);
 await assert.rejects(runClaude(f));
 const h=await fixture(t,'setInterval(()=>{},1000)');await assert.rejects(runClaude({...h,timeoutMs:50}),/timeout/);
 const rows=(await readFile(join(h.budgetDirectory,'receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows[0].status,'reserved');
});
test('refuter schema and strict output prevent error/extra keys or invalid verdicts',async t=>{
 for(const result of [{subtype:'error_max_budget_usd',structured_output:output},{subtype:'success',structured_output:{...output,extra:1}},{subtype:'success',structured_output:{verdict:'FINDING',evidence:'',selfCheck:''}}]){
  const f=await fixture(t,`console.log(JSON.stringify(${JSON.stringify({type:'result',is_error:false,total_cost_usd:0.1,...result})}))`);await assert.rejects(runClaude(f));
 }
 const f=await fixture(t,`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.1,structured_output:{verdict:'REFUTED',reasons:'Fixture reason'}}))`);
 assert.deepEqual(await runClaude({...f,role:'refuter'}),{verdict:'REFUTED',reasons:'Fixture reason'});
});

test('OAuth runtime auth is inherited without ambient secrets; exhausted shared budget refuses before subprocess',async t=>{
 const {openComputeBudget}=await import('../../services/project-organizations/src/compute-budget.mjs');
 const f=await fixture(t,`if(process.env.CLAUDE_CODE_OAUTH_TOKEN!=='fixture-oauth'||process.env.ANTHROPIC_API_KEY||process.env.UNRELATED_SECRET)process.exit(4);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.01,structured_output:${JSON.stringify(output)}}));`);
 assert.deepEqual(await runClaude({...f,env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth',UNRELATED_SECRET:'not-inherited'}}),output);
 const budget=openComputeBudget({directory:f.budgetDirectory});
 for(let i=0;i<2;i++)assert.ok(budget.reserve({purpose:'fixture',projectIds:['P-fixture'],model:'fixture'}).id);
 await assert.rejects(runClaude(f),/budget exhausted/);
 assert.equal(budget.status().receipts,3);
});
test('oversized prompt, stdout and reported cost above per-call ceiling are refused',async t=>{
 const f=await fixture(t,`console.log('x'.repeat(300000))`);
 await assert.rejects(runClaude({...f,prompt:'x'.repeat(131073)}),/prompt/);
 await assert.rejects(runClaude(f),/output limit/);
 const g=await fixture(t,`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.51,structured_output:${JSON.stringify(output)}}))`);
 await assert.rejects(runClaude(g),/result refused/);
});


test('reviewed executable metadata accepts installed binary size through 512MiB and rejects above it',async t=>{
 const f=await fixture(t,`console.log('not run for a hash mismatch')`);
 const fd=await open(f.executable,'r+');
 try{
  await fd.truncate(291638640);
  await assert.rejects(runClaude({...f,sha256:'0'.repeat(64)}),/executable hash differs/);
  await fd.truncate(512*1024*1024+1);
  await assert.rejects(runClaude(f),/unsafe executable metadata/);
 }finally{await fd.close();}
});

test('structured core primitive has zero tools and preserves native raw provenance',async t=>{
 const {runClaudeStructured}=await import('./claude-house-solver.mjs');
 const f=await fixture(t,`const a=process.argv.slice(2);if(a[a.indexOf('--tools')+1]!==''||a[a.indexOf('--allowedTools')+1]!=='')process.exit(8);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.01,modelUsage:{'claude-sonnet-5-5':{}},structured_output:{strategy:'fixture'}}));`);
 const out=await runClaudeStructured({...f,purpose:'core-ceo',tools:'',outputSchema:{type:'object'},validateOutput:v=>v});
 assert.deepEqual(out.value,{strategy:'fixture'});assert.equal(out.metadata.provider,'claude');assert.equal(out.metadata.model,'claude-sonnet-5-5');assert.match(out.metadata.nativeRawDigest,/^[a-f0-9]{64}$/);
});


test('verified subscription bypasses estimated dollar journal and CLI dollar ceiling but preserves strict schema',async t=>{
 const f=await fixture(t,`const fs=require('fs');const args=process.argv.slice(2);if(args.join(' ')==='auth status --json'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));}else{if(args.includes('--max-budget-usd'))process.exit(9);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:4.2,structured_output:${JSON.stringify(output)}}));}`);
 const result=await runClaude({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'}});
 assert.deepEqual(result,output);await assert.rejects(stat(join(f.budgetDirectory,'receipts.jsonl')),{code:'ENOENT'});
});
test('OAuth environment alone, API auth and unknown subscription types cannot bypass dollar admission',async t=>{
 for(const status of [{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty',subscriptionType:'max'}, {loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'unknown'}, {loggedIn:false,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}]){
  const f=await fixture(t,`const fs=require('fs');if(process.argv.slice(2).join(' ')==='auth status --json')console.log(JSON.stringify(${JSON.stringify(status)}));else{fs.writeFileSync(${JSON.stringify('/tmp/fixture-should-not-run')},'bad');process.exit(9);}`);
  await assert.rejects(runClaude({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'}}),/subscription/);
 }
});

test('official setup-token mode qualifies without profile-derived plan field; mixed API credentials refuse',async t=>{
 const f=await fixture(t,`if(process.argv.slice(2).join(' ')==='auth status --json')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}));else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:1.2,structured_output:${JSON.stringify(output)}}));`);
 const options={...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'}};
 assert.deepEqual(await runClaude(options),output);
 await assert.rejects(runClaude({...options,env:{...options.env,ANTHROPIC_API_KEY:'fixture-only'}}),/OAuth-only/);
});

test('subscription auth proof retains no account identity/token fields and auth timeout cannot start inference',async t=>{
 const {runClaudeStructured}=await import('./claude-house-solver.mjs');
 const f=await fixture(t,`if(process.argv.slice(2).join(' ')==='auth status --json')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty',email:'private-fixture@example.invalid',token:'private-fixture-token'}));else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:1.2,structured_output:${JSON.stringify(output)}}));`);
 const result=await runClaudeStructured({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'},tools:'',outputSchema:{type:'object'},validateOutput:v=>v});
 assert.deepEqual(result.metadata.authentication,{loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'});assert.equal(JSON.stringify(result).includes('private-fixture'),false);
 for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'])await assert.rejects(runClaude({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth',[name]:'fixture-only'}}),/OAuth-only/);
 const h=await fixture(t,`if(process.argv.slice(2).join(' ')==='auth status --json')setInterval(()=>{},1000);else process.exit(12);`);
 await assert.rejects(runClaude({...h,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'},timeoutMs:40}),/timeout/);
 await assert.rejects(stat(join(h.budgetDirectory,'receipts.jsonl')),{code:'ENOENT'});
});

test('actual primitive CLI accepts explicit subscription mode without a dollar reservation',async t=>{
 const {spawnSync}=await import('node:child_process');
 const f=await fixture(t,`if(process.argv.slice(2).join(' ')==='auth status --json')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}));else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:2.4,structured_output:${JSON.stringify(output)}}));`);
 const r=spawnSync(process.execPath,[new URL('./claude-house-solver.mjs',import.meta.url).pathname,'--executable',f.executable,'--sha256',f.sha256,'--role','solver','--budget-dir',f.budgetDirectory,'--project',f.projectId,'--usage-source','subscription'],{input:f.prompt,encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',HOME:f.root,CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'}});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),output);await assert.rejects(stat(join(f.budgetDirectory,'receipts.jsonl')),{code:'ENOENT'});
});

test('default capped OAuth execution reports a CLI estimate without claiming API invoice billing',async t=>{
 const {runClaudeStructured}=await import('./claude-house-solver.mjs');
 const f=await fixture(t,`const a=process.argv.slice(2);if(a[a.indexOf('--max-budget-usd')+1]!=='0.50'||!process.env.CLAUDE_CODE_OAUTH_TOKEN||process.env.ANTHROPIC_API_KEY)process.exit(11);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.02,structured_output:${JSON.stringify(output)}}));`);
 const options={...f,purpose:'fixture-oauth-capped',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'},tools:'',outputSchema:{type:'object'},validateOutput:v=>v};
 const result=await runClaudeStructured(options);
 assert.equal(result.metadata.usageSource,'api'); // conservative admission policy, not billing authentication
 assert.equal(result.metadata.costBasis,'api-equivalent-estimate');
 const rows=(await readFile(join(f.budgetDirectory,'receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,1);assert.equal(rows[0].status,'returned');assert.equal(rows[0].costUsd,0.02);
 const over=await fixture(t,`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.51,structured_output:${JSON.stringify(output)}}));`);
 await assert.rejects(runClaudeStructured({...options,executable:over.executable,sha256:over.sha256,budgetDirectory:over.budgetDirectory}),/result refused/);
});
