import test from'node:test';import assert from'node:assert/strict';
import{generateKeyPairSync,createHash}from'node:crypto';
import{createCentralEarningService}from'../server/central-earning.mjs';
import{createCentralReadBatcher}from'../server/central-read-batch.mjs';
import{fixture as httpFixture,member as httpMember}from'./http-fixture.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const key=generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,owner='uain1'+sha(Buffer.from(key,'base64url')).slice(0,40),reviewer='uain1'+'f'.repeat(40),pins={chainId:'fictional-diagnostic',epoch:'a'.repeat(64),verifierSha256:'b'.repeat(64)},records={central_earning_activation:null,['central_earnings/'+owner]:null,['coin_balance/'+owner]:null,coin_supply:{minted:'0',reserved:'0',transparent:'0',shielded:'0'},coin_activation:null,['member/'+reviewer]:{id:reviewer,licence:'active'}};
 let reads=0,writes=0,patch=()=>{};
 const native={configured:true,pins,timeoutMs:5000,async publicState(selection){const selected=Object.fromEntries(selection.keys.map(k=>[k,records[k]??null]));const c={state:{chain_id:pins.chainId,height:'20',app_hash:'c'.repeat(64),event_count:'1',member:{id:owner,public_key:key,sequence:'2',licence:'active'},records:selected},proof:{authority:'native',chainId:pins.chainId,epoch:pins.epoch,genesisSha256:pins.epoch,verifierSha256:pins.verifierSha256,height:'20',appHash:'c'.repeat(64),headerTime:new Date().toISOString(),maxAgeSeconds:120}};patch(c,++reads);return c;}};
 native.centralPublicState=native.publicState;const store={read:()=>({}),transact(){writes++;throw Error('must not write');}};
 return{native,store,user:{address:owner,publicKey:Buffer.from(key,'base64url').toString('base64')},records,reviewer,patch:f=>patch=f,get writes(){return writes}};
}
const service=(f,sink)=>createCentralEarningService({native:f.native,store:f.store,onProofRefusal:sink});
const refused=promise=>assert.rejects(promise,e=>e.status===503&&e.code==='central_proof_unavailable');
test('refused status emits one bounded internal category without raw exception or owner data',async()=>{
 const f=fixture(),events=[];let getterCalls=0;const error=Object.create(null);Object.defineProperty(error,'message',{get(){getterCalls++;return 'SECRET';}});f.native.centralPublicState=async()=>{throw error;};
 await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events.length,1);assert.equal(events[0].category,'reader_refused');assert.equal(events[0].phase,'initial-state');assert.equal(events[0].operation,'status');assert.ok(Buffer.byteLength(JSON.stringify(events[0]))<=1024);assert.ok(!JSON.stringify(events).includes(f.user.address));assert.ok(!JSON.stringify(events).includes('SECRET'));assert.equal(getterCalls,0);assert.equal(f.writes,0);
});
test('throwing and rejected-promise sinks preserve denial without unhandled rejection',async()=>{
 const f=fixture();f.native.centralPublicState=async()=>{throw Error('SECRET URL payload');};
 let calls=0;for(const sink of [()=>{calls++;throw Error('sink SECRET');},()=>{calls++;return Promise.reject(Error('sink SECRET'));}])await refused(service(f,sink).status(f.user));
 await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(f.writes,0);
});
test('healthy status emits no diagnostic and remains read-only',async()=>{const f=fixture(),events=[];assert.equal((await service(f,e=>events.push(e)).status(f.user)).verified,true);assert.deepEqual(events,[]);assert.equal(f.writes,0);});
test('proof categories preserve stale and wrong-pin refusal rather than relaxing checks',async()=>{
 for(const[patch,category]of[[c=>c.proof.headerTime=new Date(Date.now()-121000).toISOString(),'proof_stale'],[c=>c.proof.verifierSha256='f'.repeat(64),'proof_identity']]){const f=fixture(),events=[];f.patch(patch);await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events.length,1);assert.equal(events[0].category,category);}
});
test('cross-batch state coherence reports only bounded height/event/sequence projection',async()=>{
 const f=fixture(),events=[];f.records.central_earning_activation={policy:'central-earning-five-kpi-fund-v2',reviewer:f.reviewer,height:'5',evidence_digest:'e'.repeat(64)};
 f.patch((c,n)=>{if(n===2){c.proof.height=c.state.height='21';c.proof.appHash=c.state.app_hash='d'.repeat(64);c.state.event_count='2';}});
 await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events.length,1);assert.equal(events[0].category,'state_coherence');assert.deepEqual(events[0].coherence,{headHeight:'20',currentHeight:'21',headEventCount:'1',currentEventCount:'2',headSequence:'2',currentSequence:'2',sameAppHash:false,sameEventCount:false,sameSequence:true});assert.ok(!JSON.stringify(events).includes('d'.repeat(64)));
});
test('asset and earnings refusal categories do not publish their malformed values',async()=>{
 for(const mutate of [f=>f.records.coin_supply.transparent='SECRET',f=>f.records['central_earnings/'+f.user.address]={member:'SECRET'}]){const f=fixture(),events=[];mutate(f);await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events.length,1);assert.ok(['coin_supply','earnings_record'].includes(events[0].category));assert.ok(!JSON.stringify(events).includes('SECRET'));}
});
test('actual signed HTTP denial keeps public body unchanged and only private callback sees diagnostics',async t=>{
 const events=[],f=await httpFixture(t,{onCentralProofRefusal:e=>events.push(e)}),owner=httpMember();await f.request(owner,'POST','/api/account',{displayName:'Diagnostic fixture'});
 const r=await f.request(owner,'GET','/api/native/central/status');assert.equal(r.status,503);assert.deepEqual(r.body,{error:{code:'central_proof_unavailable',message:'central_proof_unavailable',retryAfterSeconds:120,next:'The network could not prove its current state just now. Wait 120 seconds, then try again.'}});assert.equal(events.length,1);assert.equal(events[0].category,'reader_refused');assert.ok(!JSON.stringify(r.body).includes('coherence'));assert.equal((await f.request(null,'GET','/api/native/central/status')).status,401);assert.equal(events.length,1);
});
test('only typed internal batch refusals become batch categories; arbitrary exception codes stay private',async()=>{
 const f=fixture(),events=[],batch=createCentralReadBatcher({pins:{chainId:f.native.pins.chainId,genesisSha256:f.native.pins.epoch,verifierSha256:f.native.pins.verifierSha256},readSnapshot:async()=>({header_time:'SECRET'})});
 f.native.centralPublicState=(selection,options)=>batch.read(selection,options);
 try{await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events[0].category,'batch_proof');assert.ok(!JSON.stringify(events).includes('SECRET'));}finally{await batch.close();}
 events.length=0;f.native.centralPublicState=async()=>{throw Object.assign(Error('SECRET'),{code:'central_read_batch_capacity'});};await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events[0].category,'reader_refused');
});

test('missing selected records and bad owner binding are categorized without selecting private keys',async()=>{
 for(const[patch,category]of[[c=>delete c.state.records.coin_supply,'record_missing'],[c=>c.state.member.public_key='SECRET','member_binding']]){const f=fixture(),events=[];f.patch(patch);await refused(service(f,e=>events.push(e)).status(f.user));assert.equal(events[0].category,category);assert.ok(!JSON.stringify(events).includes('SECRET'));assert.ok(!JSON.stringify(events).includes('coin_supply'));assert.equal(f.writes,0);}
});
test('every HTTP proof refusal is logged once with its reason and says whether the chain was unavailable',async t=>{
 const events=[],f=await httpFixture(t,{onCentralProofRefusal:e=>events.push(e)}),owner=httpMember();await f.request(owner,'POST','/api/account',{displayName:'Diagnostic fixture'});
 // A task read is not traced like status: before 10 November it was refused without any log line.
 const tasks=await f.request(owner,'GET','/api/native/central/tasks');
 assert.equal(tasks.status,503);assert.deepEqual(tasks.body,{error:{code:'central_proof_unavailable',message:'central_proof_unavailable',retryAfterSeconds:120,next:'The network could not prove its current state just now. Wait 120 seconds, then try again.'}});
 // The fixture's reader refuses, as a paused chain node would: wait about two minutes.
 assert.equal(tasks.headers.get('x-baink-proof-reason'),'chain-unavailable');assert.equal(tasks.headers.get('retry-after'),'120');
 assert.equal(events.length,1);assert.deepEqual(Object.keys(events[0]).sort(),['category','operation','schema']);
 assert.equal(events[0].operation,'GET /api/native/central/tasks');assert.equal(typeof events[0].category,'string');assert.notEqual(events[0].category,'');
 assert.ok(!JSON.stringify(events).includes(owner.address));
 // The status read reports its own richer line; the HTTP layer does not repeat it.
 events.length=0;const status=await f.request(owner,'GET','/api/native/central/status');
 assert.equal(status.status,503);assert.equal(status.headers.get('retry-after'),'120');assert.equal(events.length,1);assert.equal(events[0].operation,'status');
 // Other errors carry no wait hint.
 const invalid=await f.request(owner,'POST','/api/requests',{});assert.ok(invalid.status>=400&&invalid.status<500,String(invalid.status));assert.equal(invalid.headers.get('retry-after'),null);assert.equal(invalid.headers.get('x-baink-proof-reason'),null);assert.equal(events.length,1);
});
test('a proof that answered but did not check out is a proof-check refusal (30 s); reader and deadline refusals are chain-unavailable (120 s)',async()=>{
 const{centralProofRefusal}=await import('../server/central-earning.mjs');
 for(const [patch,category,chain] of [[c=>c.proof.verifierSha256='f'.repeat(64),'proof_identity',false],[c=>c.proof.headerTime=new Date(Date.now()-121000).toISOString(),'proof_stale',true]]){
  const f=fixture();f.patch(patch);let caught;await service(f,()=>{}).status(f.user).catch(e=>{caught=e;});
  const refusal=centralProofRefusal(caught);assert.equal(refusal.category,category);assert.equal(refusal.chainUnavailable,chain);assert.equal(refusal.reported,true);
 }
 const f=fixture();f.native.centralPublicState=async()=>{throw Error('reader down');};let caught;await service(f,null).status(f.user).catch(e=>{caught=e;});
 assert.deepEqual({...centralProofRefusal(caught)},{category:'reader_refused',chainUnavailable:true,reported:false});
 assert.equal(centralProofRefusal(new Error('central_proof_unavailable')),null);
});
