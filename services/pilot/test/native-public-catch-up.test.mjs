import {test} from 'node:test';import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const mod=await import('../dist/src/native/public-catch-up.js').catch(()=>({}));
test('concurrent identical checkpoints share only an in-flight head proof and never cache a completed head',async()=>{
 assert.equal(typeof mod.createNativePublicHeadReader,'function');let reads=0,release;const waiting=new Promise(r=>release=r),read=mod.createNativePublicHeadReader(async()=>{reads++;await waiting;return{event_count:String(reads)}}),config={genesisHash:'a',binaryHash:'b',rpc:'loopback'};
 const first=read(config),second=read(config);release();assert.equal((await first).event_count,'1');assert.equal((await second).event_count,'1');assert.equal(reads,1);assert.equal((await read(config)).event_count,'2','settled head must be independently re-read');
});
test('catch-up eligibility accepts only a matching active epoch with forward event or reward lag',()=>{
 assert.equal(typeof mod.nativeProjectionBehind,'function');const epoch={chain_id:'c',cursor:'4'},head={chain_id:'c',event_count:'5',records:{credit_count:'2',karma_count:'1'}},journals=[{kind:'credit',cursor:'2'},{kind:'karma',cursor:'1'}];
 assert.equal(mod.nativeProjectionBehind(epoch,head,journals),true);assert.equal(mod.nativeProjectionBehind({...epoch,cursor:'5'},head,journals),false);assert.equal(mod.nativeProjectionBehind({...epoch,cursor:'6'},head,journals),false);assert.equal(mod.nativeProjectionBehind({...epoch,retired_at:'2026-10-13'},head,journals),false);assert.equal(mod.nativeProjectionBehind({...epoch,chain_id:'other'},head,journals),false);assert.equal(mod.nativeProjectionBehind(epoch,head,[{kind:'credit',cursor:'3'}]),false);assert.equal(mod.nativeProjectionBehind({...epoch,cursor:'5'},head,[{kind:'credit',cursor:'1'},{kind:'karma',cursor:'1'}]),true);
});
test('public catch-up shares one bounded nonblocking event and reward attempt across concurrent reads',async()=>{
 assert.equal(typeof mod.createNativePublicCatchUp,'function','bounded public projection catch-up required');
 const calls=[],config={genesisHash:'a'.repeat(64)};let release;
 const blocked=new Promise(r=>release=r),coordinator=mod.createNativePublicCatchUp({}, {waitMs:30,cooldownMs:100,syncEvents:async(_pool,_config,limit,options)=>{calls.push(['events',limit,options]);await blocked;return{more:false}},syncJournals:async(_pool,_config,limit,options)=>{calls.push(['journals',limit,options]);return{more:false}}});
 const first=coordinator.catchUp(config),second=coordinator.catchUp(config);assert.equal(await first,false);assert.equal(await second,false);assert.equal(calls.length,1,'concurrent checkpoints must share pending proof work');release();await delay(5);
 assert.deepEqual(calls.map(([kind,limit,options])=>[kind,limit,options.nonblocking,options.signal instanceof AbortSignal]),[['events',32,true,true],['journals',32,true,true]]);assert.equal(await coordinator.catchUp(config),false);assert.equal(calls.length,2,'cooldown must suppress another attempt');
});
test('public catch-up aborts proof work at its hard deadline and permits a later generation',async()=>{
 let attempts=0;
 const coordinator=mod.createNativePublicCatchUp({}, {waitMs:10,runMs:25,syncEvents:async(_pool,_config,_limit,{signal})=>{attempts++;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return{more:false}}});
 assert.equal(await coordinator.catchUp({genesisHash:'a'}),false);await delay(35);assert.equal(await coordinator.catchUp({genesisHash:'b'}),false);assert.equal(attempts,2,'aborted work retained the single-flight slot');await delay(35);
});
test('public catch-up shutdown aborts its work, closes the pool once and refuses further attempts',async()=>{
 let started=0,ended=0;const coordinator=mod.createNativePublicCatchUp({end:async()=>{ended++}}, {waitMs:100,syncEvents:async(_pool,_config,_limit,{signal})=>{started++;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return{more:false}}});
 const work=coordinator.catchUp({genesisHash:'a'}),first=coordinator.close(),second=coordinator.close();assert.equal(first,second);await first;assert.equal(await work,false);assert.equal(ended,1);assert.equal(await coordinator.catchUp({genesisHash:'b'}),false);assert.equal(started,1);
});
test('public catch-up does not wait behind an existing projector or turn proof failure into success',async()=>{
 assert.equal(typeof mod.createNativePublicCatchUp,'function');let journals=0;
 const busy=mod.createNativePublicCatchUp({}, {syncEvents:async()=>({busy:true,more:true}),syncJournals:async()=>{journals++;return{more:false}}});assert.equal(await busy.catchUp({genesisHash:'a'}),false);assert.equal(journals,0);
 const failed=mod.createNativePublicCatchUp({}, {syncEvents:async()=>{throw Error('proved state refused')}});assert.equal(await failed.catchUp({genesisHash:'b'}),false);
});
test('nonblocking projection and journal sync return busy before proof work when their advisory locks are owned',async()=>{
 const {syncNativeProjection}=await import('../dist/src/native/projection.js'),{syncNativeJournals}=await import('../dist/src/native/journals.js');
 const pool={connect:async()=>({query:async sql=>{if(sql.startsWith('SELECT pg_try_advisory_lock('))return{rows:[{locked:false}]};throw Error('blocking lock or proof work attempted')},release(){}})};
 assert.equal((await syncNativeProjection(pool,{},32,{nonblocking:true})).busy,true);assert.equal((await syncNativeJournals(pool,{},32,{nonblocking:true})).busy,true);
});
