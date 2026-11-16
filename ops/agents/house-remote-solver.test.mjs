import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,rm,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runRemoteSolver,SSH_ARGS} from './house-remote-solver.mjs';
import {systemdArgs} from './house-remote-solver-host.mjs';
const value={verdict:'NO_FINDING',evidence:'',selfCheck:'fixture only'};
async function setup(t){const root=await realpath(await mkdtemp(join(tmpdir(),'remote-house-')));t.after(()=>rm(root,{recursive:true,force:true}));return{claimDirectory:join(root,'claims'),budgetDirectory:join(root,'budget'),executionId:'fixture-1',role:'solver',projectId:'house-fleet',prompt:'Fixture prompt'};}
const reply=req=>({schema:'uain-house-remote-result-v1',executionId:req.executionId,role:req.role,projectId:req.projectId,promptDigest:req.promptDigest,value,costUsd:0.02,nativeRawDigest:'a'.repeat(64)});
test('local authoritative reservation precedes fixed SSH; durable successful replay never executes twice',async t=>{
 const o=await setup(t);let calls=0;const transport=async req=>{calls++;const rows=(await readFile(join(o.budgetDirectory,'receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows[0].status,'reserved');return reply(req);};
 assert.deepEqual(await runRemoteSolver(o,{transport}),value);assert.deepEqual(await runRemoteSolver(o,{transport:()=>{throw Error('must never execute');}}),value);assert.equal(calls,1);
 const rows=(await readFile(join(o.budgetDirectory,'receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows[0].costUsd,0.02);assert.equal(rows[0].status,'returned');
 await assert.rejects(runRemoteSolver({...o,prompt:'changed'},{transport}),/binding/);
 assert.ok(SSH_ARGS.includes('uain-app-1'));assert.ok(SSH_ARGS.every(a=>!a.includes(o.prompt)));
});
test('uncertain remote execution keeps reservation and refuses replay after process recreation',async t=>{
 const o=await setup(t);await assert.rejects(runRemoteSolver(o,{transport:async()=>{throw Error('lost SSH');}}));
 await assert.rejects(runRemoteSolver(o,{transport:async()=>{throw Error('must never execute');}}),/uncertain/);
 const row=JSON.parse((await readFile(join(o.budgetDirectory,'receipts.jsonl'),'utf8')).trim());assert.equal(row.status,'reserved');
});
test('wrong authenticated response binding or excessive cost fails closed',async t=>{
 for(const change of [{executionId:'other'},{promptDigest:'b'.repeat(64)},{costUsd:0.51},{role:'refuter'}]){const o=await setup(t);await assert.rejects(runRemoteSolver(o,{transport:async r=>({...reply(r),...change})}));}
});
test('fixed systemd isolation uses existing environment without credential reads or prompt argv',()=>{
 const args=systemdArgs('fixture-1');for(const text of ['User=uain-house-solver','Group=uain-house-solver','ProtectProc=invisible','ProcSubset=pid','EnvironmentFile=/etc/uain-broker/claude.env','ProtectSystem=strict','PrivateTmp=yes','NoNewPrivileges=yes'])assert.ok(args.some(a=>a.includes(text)),text);
 assert.ok(!args.some(a=>a==='--property=User=uain-broker'||a==='--property=Group=uain-broker'));
 assert.ok(args.some(a=>a.includes('InaccessiblePaths=')&&a.includes('/var/lib/uain-custody')));assert.ok(!args.includes('Fixture prompt'));
});

test('bounded fixture subprocess receives request over stdin; malformed/oversized output stays uncertain',async t=>{
 const {boundedProcess}=await import('./house-remote-solver.mjs');const o=await setup(t);
 const transport=r=>boundedProcess(process.execPath,['-e',`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const r=JSON.parse(s);console.log(JSON.stringify({...r,schema:'uain-house-remote-result-v1',value:${JSON.stringify(value)},costUsd:0.01,nativeRawDigest:'${'c'.repeat(64)}'}));});`],JSON.stringify(r),{timeoutMs:1000});
 assert.deepEqual(await runRemoteSolver(o,{transport}),value);
 await assert.rejects(boundedProcess(process.execPath,['-e',"console.log('x'.repeat(3000))"],'',{maxBytes:1000,timeoutMs:1000}));
 await assert.rejects(boundedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],'',{timeoutMs:20}));
});
test('shared cap exhaustion prevents SSH and remains held without increasing limits',async t=>{
 const {openComputeBudget}=await import('../../services/project-organizations/src/compute-budget.mjs');const o=await setup(t);
 const budget=openComputeBudget({directory:o.budgetDirectory});for(let i=0;i<2;i++)assert.ok(budget.reserve({purpose:'fixture',projectIds:['fixture'],model:'fixture'}).id);
 let called=false;assert.equal((await runRemoteSolver(o,{transport:async()=>{called=true;throw Error('must not call');}})).schema,'uain-house-compute-pause-v1');assert.equal(called,false);assert.equal(budget.status().receipts,2);assert.equal(budget.status().limits.dailyUsd,5);
});

test('fleet command may omit execution ID: identical bound prompt deterministically replays without rerun',async t=>{
 const o=await setup(t);delete o.executionId;let called=0;const transport=async r=>{called++;assert.match(r.executionId,/^HSR-[a-f0-9]{48}$/);return reply(r);};
 await runRemoteSolver(o,{transport});await runRemoteSolver(o,{transport});assert.equal(called,1);
});


test('proven denial resumes same execution after UTC recovery and concurrent retries execute at most once',async t=>{
 const {openComputeBudget}=await import('../../services/project-organizations/src/compute-budget.mjs');const o=await setup(t);
 let now=Date.parse('2026-11-08T12:00:00Z');const budget=openComputeBudget({directory:o.budgetDirectory,now:()=>now});
 for(let i=0;i<2;i++)budget.reserve({purpose:'fixture',projectIds:['fixture'],model:'fixture'});
 let calls=0;const transport=async r=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return reply(r);};
 assert.equal((await runRemoteSolver(o,{transport,now:()=>now})).schema,'uain-house-compute-pause-v1');assert.equal(calls,0);
 now+=86400000;
 const outcomes=await Promise.allSettled([runRemoteSolver(o,{transport,now:()=>now}),runRemoteSolver(o,{transport,now:()=>now})]);
 assert.ok(outcomes.some(x=>x.status==='fulfilled'&&x.value.verdict==='NO_FINDING'));assert.equal(calls,1);assert.equal(budget.status().receipts,3);
 assert.deepEqual(await runRemoteSolver(o,{transport,now:()=>now}),value);assert.equal(calls,1);
});

const subscriptionReply=r=>({...reply(r),usageSource:'subscription',costUsd:4.2,costBasis:'api-equivalent-estimate',authentication:{loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}});
test('subscription execution bypasses exhausted dollar budget, persists before transport and never replays',async t=>{
 const {openComputeBudget}=await import('../../services/project-organizations/src/compute-budget.mjs');const o=await setup(t);
 const budget=openComputeBudget({directory:o.budgetDirectory});for(let i=0;i<2;i++)budget.reserve({purpose:'fixture',projectIds:['fixture'],model:'fixture'});
 const before=await readFile(join(o.budgetDirectory,'receipts.jsonl'),'utf8');let calls=0;
 const transport=async r=>{calls++;assert.equal(r.usageSource,'subscription');const {createHash}=await import('node:crypto');const claim=JSON.parse(await readFile(join(o.claimDirectory,createHash('sha256').update(o.executionId).digest('hex')+'.json')));assert.equal(claim.status,'executing-subscription');assert.equal(claim.reservationId,undefined);return subscriptionReply(r);};
 assert.deepEqual(await runRemoteSolver({...o,usageSource:'subscription'},{transport}),value);
 assert.deepEqual(await runRemoteSolver({...o,usageSource:'subscription'},{transport:()=>{throw Error('must not rerun');}}),value);
 assert.equal(calls,1);assert.equal(await readFile(join(o.budgetDirectory,'receipts.jsonl'),'utf8'),before);
});
test('proven pre-execution dollar denial can resume identical task under verified subscription',async t=>{
 const {openComputeBudget}=await import('../../services/project-organizations/src/compute-budget.mjs');const o=await setup(t);
 const budget=openComputeBudget({directory:o.budgetDirectory});for(let i=0;i<2;i++)budget.reserve({purpose:'fixture',projectIds:['fixture'],model:'fixture'});
 assert.equal((await runRemoteSolver(o,{transport:()=>{throw Error('must not run');}})).schema,'uain-house-compute-pause-v1');
 assert.deepEqual(await runRemoteSolver({...o,usageSource:'subscription'},{transport:async r=>subscriptionReply(r)}),value);assert.equal(budget.status().receipts,2);
});
test('subscription unknown outcome is terminal without dollar journal; source changes cannot retry an uncertain API call',async t=>{
 const o=await setup(t);let calls=0;const transport=async()=>{calls++;throw Error('unknown');};
 await assert.rejects(runRemoteSolver({...o,usageSource:'subscription'},{transport}));
 await assert.rejects(runRemoteSolver({...o,usageSource:'subscription'},{transport}),/uncertain/);assert.equal(calls,1);
 await assert.rejects(stat(join(o.budgetDirectory,'receipts.jsonl')),{code:'ENOENT'});
 const a=await setup(t);await assert.rejects(runRemoteSolver(a,{transport}));
 await assert.rejects(runRemoteSolver({...a,usageSource:'subscription'},{transport}),/uncertain/);assert.equal(calls,2);
});
test('subscription authenticated result cannot omit billing source/proof or return API classification',async t=>{
 for(const change of [{usageSource:'api'},{authentication:undefined},{authentication:{authMethod:'api_key',apiProvider:'firstParty'}},{costBasis:'api-reported-cost'}]){const o=await setup(t);await assert.rejects(runRemoteSolver({...o,usageSource:'subscription'},{transport:async r=>({...subscriptionReply(r),...change})}));}
});

test('concurrent subscription retries execute at most once and cached result survives later source selection',async t=>{
 const o=await setup(t);let calls=0;const transport=async r=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return subscriptionReply(r);};
 const results=await Promise.allSettled([runRemoteSolver({...o,usageSource:'subscription'},{transport}),runRemoteSolver({...o,usageSource:'subscription'},{transport})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);
 assert.deepEqual(await runRemoteSolver(o,{transport:()=>{throw Error('must not replay cached subscription under API');}}),value);assert.equal(calls,1);
});

test('dispatcher symlink entrypoint runs fail-closed bootstrap instead of silently skipping CLI',async t=>{
 const {symlink}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const root=await mkdtemp(join(tmpdir(),'house-host-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=fileURLToPath(new URL('./house-remote-solver-host.mjs',import.meta.url));
 const entry=join(root,'current-host.mjs');await symlink(target,entry);
 const result=spawnSync(process.execPath,[entry],{input:'',encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/Immutable remote dispatcher refused or uncertain/);
});

test('read-only returned-claim validator refuses ambiguous and changed bindings without transport',async()=>{
 const api=await import('./house-remote-solver.mjs'),binding={executionId:'fixture-returned',role:'solver',projectId:'house-fleet',promptDigest:'d'.repeat(64)},response=subscriptionReply(binding),claim={schema:'uain-house-remote-claim-v1',binding,status:'returned',usageSource:'subscription',value,response};
 assert.deepEqual(api.validateReturnedClaim(claim,binding),value);
 for(const patch of [{status:'executing-subscription'},{binding:{...binding,promptDigest:'b'.repeat(64)}},{value:{...value,selfCheck:'changed'}},{response:{...response,authentication:{loggedIn:false}}}])assert.throws(()=>api.validateReturnedClaim({...claim,...patch},binding));
});
