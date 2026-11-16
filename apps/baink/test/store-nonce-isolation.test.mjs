import test from 'node:test';
import assert from 'node:assert/strict';
import {createGroupCommitStore} from '../server/store.mjs';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const initial=()=>({accounts:{a:{name:'Before',nested:{safe:true}}},nonces:{old:1},business:{count:0}});

test('generic callback aliases cannot change the durable candidate during fsync or committed accounts/nonces after acknowledgement',async()=>{
 const entered=gate(),durable=gate();let retained,candidate,disk,ack=false;
 const store=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async next=>{candidate=next;disk=structuredClone(next);entered.resolve();await durable.promise;}});
 const work=store.transact(d=>{d.accounts.a.name='Approved';d.nonces.added=2;d.business.count=1;retained=d;return d.accounts;}).then(v=>{ack=true;return v;});
 await entered.promise;retained.accounts.a.name='DURING_BARRIER';retained.accounts.a.nested.safe=false;retained.nonces.added=999;retained.business.count=99;
 assert.equal(ack,false);assert.deepEqual(store.read(),initial());assert.equal(candidate.accounts.a.name,'Approved');assert.equal(candidate.nonces.added,2);assert.equal(candidate.business.count,1);assert.equal(candidate.accounts.a.nested.safe,true);
 durable.resolve();const result=await work;result.a.name='RETURNED_ALIAS';retained.accounts.a.name='AFTER_ACK';retained.nonces.old=999;
 assert.equal(store.read().accounts.a.name,'Approved');assert.equal(store.read().nonces.old,1);assert.deepEqual(store.read(),disk);await store.close();
});

test('nonce view and mixed ordering observe the detached approved generic accounts, never retained aliases',async()=>{
 let retained;const disk=[];const store=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async next=>disk.push(structuredClone(next))});
 await store.transact(d=>{retained=d.accounts;d.accounts.a.name='Approved';});retained.a.name='FORGED';
 await store.transactNonces(d=>{assert.equal(d.accounts.a.name,'Approved');assert.ok(Object.isFrozen(d.accounts.a));d.nonces.one=2;});
 await Promise.all([store.transact(d=>{d.accounts.a.name='Next';}),store.transactNonces(d=>{assert.equal(d.accounts.a.name,'Next');d.nonces.two=3;})]);
 assert.equal(store.read().accounts.a.name,'Next');assert.deepEqual(store.read(),disk.at(-1));await store.close();
});

test('callback and capacity rejection preserve the previous committed accounts and nonce state',async()=>{
 let calls=0;const store=createGroupCommitStore({initialState:initial(),validate:next=>{if(next.accounts.a.name==='OVER_CAPACITY')throw Error('capacity');},persist:async()=>{calls++;}});
 let failed;await assert.rejects(store.transact(d=>{failed=d;d.accounts.a.name='callback';throw Error('callback');}),/callback/);failed.accounts.a.name='LATE_CALLBACK';
 await assert.rejects(store.transact(d=>{d.accounts.a.name='OVER_CAPACITY';d.nonces.bad=2;}),/capacity/);
 assert.deepEqual(store.read(),initial());assert.equal(calls,0);await store.transactNonces(d=>{d.nonces.good=2;});assert.equal(store.read().nonces.good,2);await store.close();
});

test('rename then fsync uncertainty poisons all mutation paths and cannot publish or overwrite retained aliases',async()=>{
 const entered=gate(),release=gate();let retained,disk,calls=0;
 const store=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async next=>{calls++;disk=structuredClone(next);entered.resolve();await release.promise;throw Error('directory fsync uncertain');}});
 const work=store.transact(d=>{d.accounts.a.name='Approved';retained=d;});const refused=assert.rejects(work,/fsync uncertain/);await entered.promise;retained.accounts.a.name='FORGED';release.resolve();await refused;
 assert.deepEqual(store.read(),initial());assert.equal(disk.accounts.a.name,'Approved');
 for(const method of ['transact','transactNonces','transactRequestCreate','transactMessages'])await assert.rejects(store[method](()=>{}),/unavailable/);
 assert.equal(calls,1);await store.close();
});

test('committed primitive nonce maps are detached and frozen; generic clones remain editable',async()=>{
 let committedMap,retained;const s=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async next=>{committedMap=next.nonces;}});
 await s.transactNonces(d=>{retained=d.nonces;d.nonces.one=2;});assert.ok(Object.isFrozen(committedMap));assert.notEqual(committedMap,retained);retained.one=999;assert.equal(s.read().nonces.one,2);
 await s.transact(d=>{assert.equal(Object.isFrozen(d.nonces),false);d.nonces.two=3;});await s.transactNonces(d=>{assert.equal(d.nonces.two,3);d.nonces.three=4;});assert.ok(Object.isFrozen(committedMap));await s.close();
});

test('nonce descriptor validation rejects malformed fields without invoking their getters or persisting',async()=>{
 let getterCalls=0,writes=0;const s=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async()=>{writes++;}});
 const malformed=[d=>Object.defineProperty(d.nonces,'getter',{enumerable:true,get(){getterCalls++;return 2;}}),d=>Object.defineProperty(d.nonces,'hidden',{value:2,enumerable:false}),d=>d.nonces[Symbol('not-json')]=2,d=>Object.setPrototypeOf(d.nonces,null),d=>Object.setPrototypeOf(d.nonces,{fake:true})];
 for(const mutate of malformed)await assert.rejects(s.transactNonces(d=>{mutate(d);}));
 for(const value of [new Date(),new Map(),new Set(),new Uint8Array([1]),new Number(2),NaN,Infinity,-Infinity,0,-0,-1,Number.MAX_SAFE_INTEGER+1,2n,'2',null,undefined,()=>2])await assert.rejects(s.transactNonces(d=>{d.nonces.bad=value;}));
 assert.equal(getterCalls,0);assert.equal(writes,0);assert.deepEqual(s.read(),initial());await s.close();
});

test('nonce data keys cannot change prototypes and max-safe primitive remains detached',async()=>{
 let alias;const s=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async()=>{}});
 await s.transactNonces(d=>{Object.defineProperty(d.nonces,'__proto__',{value:2,enumerable:true,writable:true,configurable:true});d.nonces.max=Number.MAX_SAFE_INTEGER;alias=d.nonces;});
 const committed=s.read().nonces;assert.equal(Object.getPrototypeOf(committed),Object.prototype);assert.equal(Object.hasOwn(committed,'__proto__'),true);assert.equal(committed.__proto__,2);assert.equal(committed.max,Number.MAX_SAFE_INTEGER);alias.max=1;assert.equal(s.read().nonces.max,Number.MAX_SAFE_INTEGER);await s.close();
});

test('a generic clone cannot smuggle malformed map or internal-slot state into the validated nonce fast path',async()=>{
 for(const value of [new Map([['x',2]]),new Set([2]),new Date(0),new Uint8Array([2]),[],null,{bad:NaN},{bad:Infinity},{bad:Number.MAX_SAFE_INTEGER+1}]){
  let writes=0,entered=false;const s=createGroupCommitStore({initialState:initial(),validate:()=>{},persist:async()=>{writes++;}});
  await s.transact(d=>{d.nonces=value;});await assert.rejects(s.transactNonces(()=>{entered=true;}));assert.equal(entered,false);assert.equal(writes,1);await s.close();
 }
});
