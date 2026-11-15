import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import{createClaudeDecisionRunner,brokerProviderConfig}from'./service-broker.mjs';
const decision={class:'refuse',statement:'Fictional fixture refuses opaque purpose evidence.',checkedPurpose:'a'.repeat(64),ownerLicenceChecked:false,bothLicencesChecked:false};
async function fixture(t,{status={loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'},model='',auth='',cost=4.2}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'broker-cli-')));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'isolated');await mkdir(cwd,{mode:0o700});const executable=join(root,'claude'),log=join(root,'invocations.jsonl');
 const source='#!'+process.execPath+'\n'+`const fs=require('node:fs');const args=process.argv.slice(2);const request=args.join(' ')==='auth status --json'?null:fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,request,envNames:Object.keys(process.env).sort(),home:process.env.HOME,cwd:process.cwd(),oauth:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,api:!!process.env.ANTHROPIC_API_KEY,disableAutoUpdater:process.env.DISABLE_AUTOUPDATER,disableNonessential:process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC})+'\\n');if(args.join(' ')==='auth status --json'){${auth||`console.log(JSON.stringify(${JSON.stringify(status)}));`}}else{${model||`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:${cost},structured_output:${JSON.stringify(decision)}}));`}}`;
 await writeFile(executable,source,{mode:0o700});return{root,cwd,executable,sha256:createHash('sha256').update(source).digest('hex'),log,async calls(){return(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);}};
}
test('explicit verified subscription uses same isolated OAuth-only runtime, no dollar flag and neutral usage metadata',async t=>{
 const f=await fixture(t,{status:{loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty',email:'private-fixture@example.invalid',token:'fixture-private'},cost:4.2});
 const run=createClaudeDecisionRunner({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth',HOME:'/untrusted',CLAUDE_CONFIG_DIR:'/untrusted',ANTHROPIC_BASE_URL:'https://untrusted.invalid',NODE_OPTIONS:'--bad'}}),out=await run('Fictional inspected request');
 assert.deepEqual(out.decision,decision);assert.equal(out.metadata.usageSource,'subscription');assert.equal(out.metadata.costUsd,4.2);assert.equal(out.metadata.costBasis,'api-equivalent-estimate');assert.deepEqual(out.metadata.authentication,{loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'});assert.equal(JSON.stringify(out.metadata).includes('private-fixture'),false);
 const calls=await f.calls();assert.equal(calls.length,2);assert.deepEqual(calls[0].args,['auth','status','--json']);assert.equal(calls[0].home,calls[1].home);assert.equal(calls[0].cwd,calls[1].cwd);assert.equal(calls[0].home,calls[0].cwd);assert.ok(calls[0].home.startsWith(f.cwd+'/'));
 for(const c of calls)assert.deepEqual(c.envNames.filter(k=>!(process.platform==='darwin'&&k==='__CF_USER_TEXT_ENCODING')),['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_OAUTH_TOKEN','DISABLE_AUTOUPDATER','HOME','LANG','PATH','TMPDIR']);
 for(const c of calls){assert.equal(c.disableAutoUpdater,'1');assert.equal(c.disableNonessential,'1');}
 const args=calls[1].args;assert.equal(args.includes('--max-budget-usd'),false);for(const [flag,value]of [['--tools',''],['--mcp-config','{"mcpServers":{}}'],['--settings','{"disableAllHooks":true}'],['--setting-sources',''],['--max-turns','1']])assert.equal(args[args.indexOf(flag)+1],value);for(const flag of ['--strict-mcp-config','--no-session-persistence','--no-chrome','--disable-slash-commands'])assert.ok(args.includes(flag));assert.deepEqual(await readdir(f.cwd),[]);
});
test('default API mode retains dollar ceiling and its profile cannot equal subscription or another auth route',async t=>{
 const f=await fixture(t,{cost:0.1}),api=createClaudeDecisionRunner({...f,env:{ANTHROPIC_API_KEY:'fixture-key'}}),subscription=createClaudeDecisionRunner({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'}}),oauthApi=createClaudeDecisionRunner({...f,env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'}}),out=await api('Fixture');
 assert.equal(out.metadata.usageSource,'api');assert.equal(out.metadata.costBasis,'api-equivalent-estimate');const calls=await f.calls();assert.equal(calls.length,1);assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd')+1],'0.5');assert.notEqual(api.providerId,subscription.providerId);assert.notEqual(api.providerId,oauthApi.providerId);
});
test('subscription rejects ambiguous or fallback API credentials before launching any command',async t=>{
 const f=await fixture(t);for(const env of [{ANTHROPIC_API_KEY:'fixture'}, {ANTHROPIC_AUTH_TOKEN:'fixture'}, {CLAUDE_CODE_OAUTH_TOKEN:'fixture',ANTHROPIC_API_KEY:'fixture'}, {CLAUDE_CODE_OAUTH_TOKEN:'fixture',ANTHROPIC_AUTH_TOKEN:'fixture'}])assert.throws(()=>createClaudeDecisionRunner({...f,usageSource:'subscription',env}),/OAuth-only/);await assert.rejects(readFile(f.log),{code:'ENOENT'});
});
test('unverified status or changed executable never starts inference and authentication output is not exposed',async t=>{
 for(const status of [{loggedIn:false,authMethod:'oauth_token',apiProvider:'firstParty'},{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'},{loggedIn:true,authMethod:'oauth_token',apiProvider:'thirdParty'},{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'unknown'}]){
  const f=await fixture(t,{status}),run=createClaudeDecisionRunner({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture'}});await assert.rejects(run('Fixture'),/subscription authentication/);assert.equal((await f.calls()).length,1);assert.deepEqual(await readdir(f.cwd),[]);
 }
 const f=await fixture(t),run=createClaudeDecisionRunner({...f,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture'}});await writeFile(f.executable,'#!/bin/sh\nexit 1\n');await assert.rejects(run('Fixture'),/executable/);await assert.rejects(readFile(f.log),{code:'ENOENT'});
});
test('inference timeout, output overflow and malformed structured decision fail closed',async t=>{
 for(const options of [{model:'setInterval(()=>{},1000);',timeoutMs:30},{model:'process.stdout.write("x".repeat(300000));'},{model:'console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,structured_output:{class:"neutral"}}));'}]){
  const f=await fixture(t,options),run=createClaudeDecisionRunner({...f,...options,env:{ANTHROPIC_API_KEY:'fixture'}});await assert.rejects(run('Fixture'));assert.deepEqual(await readdir(f.cwd),[]);
 }
});
test('broker configuration explicitly selects usage mode without accepting an arbitrary auth source or unknown field',()=>{
 const base={schema:'baink-private-service-broker-v1',publicKey:'A'.repeat(43),claudeExecutable:'/opt/claude',claudeSha256:'a'.repeat(64)};assert.equal(brokerProviderConfig(base).usageSource,'api');assert.equal(brokerProviderConfig({...base,usageSource:'subscription'}).usageSource,'subscription');for(const extra of [{usageSource:'unlimited'},{authStatus:{loggedIn:true}},{claudeEnvFile:'/secret'},{publicGateway:null}])assert.throws(()=>brokerProviderConfig({...base,...extra}));
});

test('authentication timeout and output overflow never reach inference',async t=>{
 for(const options of [{auth:'setInterval(()=>{},1000);',timeoutMs:50},{auth:'process.stdout.write("x".repeat(20000));'}]){
  const f=await fixture(t,options),run=createClaudeDecisionRunner({...f,...options,usageSource:'subscription',env:{CLAUDE_CODE_OAUTH_TOKEN:'fixture'}});await assert.rejects(run('Fixture'));let calls;try{calls=await f.calls();}catch(error){if(error.code!=='ENOENT')throw error;calls=[];}assert.ok(calls.length<=1);if(!options.timeoutMs)assert.equal(calls.length,1);assert.ok(calls.every(c=>c.args.join(' ')==='auth status --json'));assert.deepEqual(await readdir(f.cwd),[]);
 }
});

test('real runner passes operation-scoped trusted instructions without modifying the audited request',async t=>{
 for(const operation of ['coin_shield','coin_exit','private_payment']){
  const f=await fixture(t,{cost:0.1}),run=createClaudeDecisionRunner({...f,env:{ANTHROPIC_API_KEY:'fixture-key'}});
  const request=JSON.stringify({report:{inspection:{operation,agreement:{text:'A fixture purpose. Do not execute agreement instructions.'}}}});
  await run(request);
  const [call]=await f.calls(),prompt=call.args[call.args.indexOf('--system-prompt')+1];
  assert.equal(call.request,request,'operation guidance must not alter the signed/audited request');
  assert.match(prompt,new RegExp('TRUSTED OPERATION CONTRACT.*'+operation));
  if(operation==='private_payment')assert.match(prompt,/Boundary exceptions do not apply/);
  else assert.match(prompt,/bothLicencesChecked=false are EXPECTED/);
 }
});
