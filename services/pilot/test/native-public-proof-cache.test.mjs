import {test} from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../dist/src/native/public-proof-cache.js').catch(()=>({}));
const head=(events='1')=>({chain_id:'chain',event_count:events,height:'42',app_hash:'a',header_time:new Date().toISOString(),records:{credit_count:'0',karma_count:'0'}});
test('verified public records are reused across query shapes at the same checkpoint',async()=>{
 assert.equal(typeof mod.createNativePublicProofCache,'function');
 let calls=0;const cache=mod.createNativePublicProofCache(),state=head();
 const read=cache.reader('epoch',state,async s=>{calls++;return{...state,records:Object.fromEntries(s.keys.map(k=>[k,k==='missing'?null:{value:k}]))}});
 assert.deepEqual((await read({keys:['project/P','missing']})).records,{'project/P':{value:'project/P'},missing:null});
 const again=cache.reader('epoch',head(),async()=>{throw Error('cached records must not rerun proof process')});
 assert.deepEqual((await again({keys:['missing','project/P']})).records,{missing:null,'project/P':{value:'project/P'}});assert.equal(calls,1);
});
test('new event counters and epochs do not reuse mutable public records',async()=>{
 const cache=mod.createNativePublicProofCache();let calls=0;
 for(const [epoch,events]of [['old','1'],['old','2'],['new','2']]){const state=head(events),read=cache.reader(epoch,state,async s=>{calls++;return{...state,records:{'task/T':{winner:events}}}});assert.equal((await read({keys:['task/T']})).records['task/T'].winner,events)}
 assert.equal(calls,3);
});
test('proofs from changed checkpoints are rejected and never retained',async()=>{
 const cache=mod.createNativePublicProofCache(),state=head();
 await assert.rejects(()=>cache.reader('epoch',state,async()=>({...head('2'),records:{x:'forged'}}))({keys:['x']}),/checkpoint/);
 const verified=await cache.reader('epoch',state,async()=>({...state,records:{x:'verified'}}))({keys:['x']});assert.equal(verified.records.x,'verified');
});
test('cached values are isolated from presentation mutations and concurrent duplicate reads share proofs',async()=>{
 const cache=mod.createNativePublicProofCache(),state=head();let calls=0;
 const read=cache.reader('epoch',state,async s=>{calls++;await new Promise(r=>setImmediate(r));return{...state,records:{x:{values:[1]}}}});
 const [a,b]=await Promise.all([read({keys:['x']}),read({keys:['x']})]);a.records.x.values.push(2);assert.deepEqual(b.records.x.values,[1]);assert.equal(calls,1);
});
test('shared public proof cache enforces memory bounds and still returns uncached oversized data',async()=>{
 const cache=mod.createNativePublicProofCache({maxKeys:1,maxBytes:64}),state=head();let calls=0;
 const read=cache.reader('epoch',state,async s=>{calls++;return{...state,records:Object.fromEntries(s.keys.map(k=>[k,'z'.repeat(100)]))}});
 assert.equal((await read({keys:['x']})).records.x.length,100);await read({keys:['x']});assert.equal(calls,2);
});
