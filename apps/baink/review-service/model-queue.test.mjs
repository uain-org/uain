import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{createModelQueue}from'./model-queue.mjs';
const binding={custodyJobId:'a'.repeat(32),owner:'uain1'+'b'.repeat(40),publicKey:'c'.repeat(43),contextDigest:'d'.repeat(64),inspectionDigest:'e'.repeat(64)};
function fixture(){let db={};const blobs=new Map(),store={read:()=>structuredClone(db),transact:async fn=>{const draft=structuredClone(db),result=fn(draft);db=draft;return structuredClone(result);}},vault={put:async(k,v)=>blobs.set(k,structuredClone(v)),get:async k=>structuredClone(blobs.get(k))},options={store,vault};return{options,q:createModelQueue(options),get db(){return db;}};}
const finish=j=>({dispatchId:j.dispatchId,bindingDigest:j.bindingDigest,inspectionDigest:j.binding.inspectionDigest,status:'attested'});
test('immutable exact binding enqueue is idempotent and dispatch persisted before claim',async()=>{const f=fixture(),b=structuredClone(binding),ticket=await f.q.enqueue(b);b.owner='evil';assert.deepEqual(await f.q.enqueue(binding),ticket);const j=await f.q.claim();assert.equal(j.binding.owner,binding.owner);assert.equal(f.db.modelJobs[ticket.ticketId].status,'dispatched');assert.ok(Object.isFrozen(j.binding));assert.equal(await f.q.claim(),null);});
test('completed exact matching result returns opaque decision, duplicate status is stable',async()=>{const f=fixture(),t=await f.q.enqueue(binding),j=await f.q.claim();assert.deepEqual(await f.q.complete(t.ticketId,finish(j)),{status:'attested'});assert.deepEqual(await f.q.complete(t.ticketId,finish(j)),{status:'attested'});assert.deepEqual(await f.q.result(t.ticketId,binding),{status:'attested'});await assert.rejects(f.q.complete(t.ticketId,{...finish(j),status:'refused'}),/conflict/);});
test('wrong dispatch, inspection or owner binding cannot complete or poll',async()=>{const f=fixture(),t=await f.q.enqueue(binding),j=await f.q.claim();for(const body of [{...finish(j),dispatchId:'0'.repeat(32)},{...finish(j),inspectionDigest:'0'.repeat(64)}])await assert.rejects(f.q.complete(t.ticketId,body),/binding/);await assert.rejects(f.q.result(t.ticketId,{...binding,owner:'uain1'+'0'.repeat(40)}),/binding/);});
test('crash after dispatch never redispatches even across queue instances',async()=>{const f=fixture();await f.q.enqueue(binding);await f.q.claim();assert.equal(await createModelQueue(f.options).claim(),null);assert.equal(Object.values(f.db.modelJobs)[0].status,'dispatched');});
test('changed inspection for same custody job, extra report fields and full queue refuse',async()=>{const f=fixture();await f.q.enqueue(binding);await assert.rejects(f.q.enqueue({...binding,inspectionDigest:'0'.repeat(64)}),/conflict/);await assert.rejects(f.q.enqueue({...binding,report:{}}),/binding/);const q=createModelQueue({...f.options,maxQueued:1});await assert.rejects(q.enqueue({...binding,custodyJobId:'0'.repeat(32)}),/capacity/);});
test('detached review callback uses cached completion without binding this or redispatch',async()=>{const f=fixture(),t=await f.q.enqueue(binding),j=await f.q.claim();await f.q.complete(t.ticketId,finish(j));const callback=f.q.reviewJob;assert.deepEqual(await callback(binding),{status:'attested'});assert.equal(await f.q.claim(),null);});
test('lost claim acknowledgement recovers exact persisted dispatch, never selects another job',async()=>{const f=fixture(),claimId='f'.repeat(32);await f.q.enqueue(binding);const first=await f.q.claim({claimId});await f.q.enqueue({...binding,custodyJobId:'0'.repeat(32)});const restarted=createModelQueue(f.options);assert.deepEqual(await restarted.claim({claimId}),first);await restarted.complete(first.ticketId,finish(first));assert.deepEqual(await restarted.claim({claimId}),first);assert.notEqual((await restarted.claim({claimId:'0'.repeat(32)})).ticketId,first.ticketId);});
test('completed recovery lookup returns only matching existing result and never queues or claims',async()=>{const f=fixture(),t=await f.q.enqueue(binding),scope={custodyJobId:binding.custodyJobId,owner:binding.owner,publicKey:binding.publicKey,contextDigest:binding.contextDigest};assert.deepEqual(await f.q.completedFor(scope),{status:'unknown'});const j=await f.q.claim();await f.q.complete(t.ticketId,finish(j));assert.deepEqual(await f.q.completedFor(scope),{status:'attested',inspectionDigest:binding.inspectionDigest});await assert.rejects(f.q.completedFor({...scope,owner:'uain1'+'0'.repeat(40)}),/binding/);assert.equal(await f.q.claim(),null);});

// Capacity boundaries (P1-2, 11 November 2026). maxJobs bounds the ACTIVE file, never lifetime admission.
const memStore=()=>{let db={};return{read:()=>structuredClone(db),transact:async fn=>{const draft=structuredClone(db),result=fn(draft);db=draft;return structuredClone(result);},get db(){return db;}};};
const nth=i=>({...binding,custodyJobId:i.toString(16).padStart(32,'0')}),claimOf=i=>'c'+i.toString(16).padStart(31,'0');
const ticketOf=b=>createHash('sha256').update('BAINK/model-queue/ticket/v1\n'+b.custodyJobId).digest('hex').slice(0,32);
async function runFinished(q,from,to){for(let i=from;i<to;i++){const t=await q.enqueue(nth(i)),j=await q.claim({claimId:claimOf(i)});assert.equal(j.ticketId,t.ticketId);await q.complete(t.ticketId,finish(j));}}
test('1,000 jobs ever created, all finished: the default queue still admits the next payment check',async()=>{
 const f=fixture(),archive=memStore(),q=createModelQueue({...f.options,archive});
 await runFinished(q,0,1000);
 await q.enqueue(nth(1000));
 assert.ok(Object.keys(f.db.modelJobs).length<=1000,'active file stays bounded by maxJobs');
 assert.ok(Object.keys(f.db.modelClaims).length<=1000,'active claims stay bounded');
 assert.equal(Object.keys(f.db.modelJobs).length+Object.keys(archive.db.modelJobs??{}).filter(t=>!f.db.modelJobs[t]).length,1001,'every job is kept: archived, never deleted');
 assert.ok(Object.values(archive.db.modelJobs??{}).every(j=>j.status==='completed'),'only finished jobs leave the active file');
});
test('archived jobs keep idempotent enqueue, result, completedFor and lost-claim recovery, with no second model call',async()=>{
 const f=fixture(),archive=memStore(),opts={...f.options,archive,maxQueued:4,maxJobs:8},q=createModelQueue(opts);
 await runFinished(q,0,20);await q.enqueue(nth(20));
 const b=nth(0),ticket=ticketOf(b);
 assert.equal(f.db.modelJobs[ticket],undefined,'oldest finished job left the active file');assert.equal(archive.db.modelJobs[ticket].status,'completed');
 assert.equal((await q.enqueue(b)).ticketId,ticket);assert.equal(f.db.modelJobs[ticket],undefined,'re-enqueue of an archived job never queues it again');
 await assert.rejects(q.enqueue({...b,inspectionDigest:'0'.repeat(64)}),/conflict/);
 assert.deepEqual(await q.result(ticket,b),{status:'attested'});
 assert.deepEqual(await q.completedFor({custodyJobId:b.custodyJobId,owner:b.owner,publicKey:b.publicKey,contextDigest:b.contextDigest}),{status:'attested',inspectionDigest:b.inspectionDigest});
 const restarted=createModelQueue(opts),again=await restarted.claim({claimId:claimOf(0)});
 assert.equal(again.ticketId,ticket,'a lost claim acknowledgement for an archived job returns that job, never another');
 assert.equal((await restarted.claim({claimId:'a'.repeat(32)})).ticketId,ticketOf(nth(20)));assert.equal(await restarted.claim(),null,'nothing redispatched');
});
test('crash between the archive write and the active removal leaves a duplicate that the next compaction settles',async()=>{
 const f=fixture(),archive=memStore(),opts={...f.options,archive,maxQueued:4,maxJobs:8},q=createModelQueue(opts);
 await runFinished(q,0,7);const oldest=structuredClone(f.db.modelJobs[ticketOf(nth(0))]);
 await archive.transact(a=>{a.modelJobs={[oldest.ticketId]:oldest};});
 await runFinished(createModelQueue(opts),7,9);
 assert.deepEqual(archive.db.modelJobs[oldest.ticketId],oldest);assert.equal(f.db.modelJobs[oldest.ticketId],undefined);
 const tampered=structuredClone(f.db.modelJobs[ticketOf(nth(8))]);tampered.result={status:'refused'};await archive.transact(a=>{a.modelJobs[tampered.ticketId]=tampered;});
 await runFinished(q,9,30);assert.ok(f.db.modelJobs[tampered.ticketId],'a conflicting archive copy never removes the active record');
});
test('without an archive the old bounded refusal stays (no unbounded active file)',async()=>{const f=fixture(),q=createModelQueue({...f.options,maxQueued:2,maxJobs:2});await runFinished(q,0,2);await assert.rejects(q.enqueue(nth(9)),/capacity/);});
test('restart in the middle of a burst: dispatched work is never redispatched and unfinished work still counts against admission',async()=>{
 const f=fixture(),opts={...f.options,archive:memStore(),maxQueued:4,maxJobs:8},q=createModelQueue(opts);
 for(let i=0;i<4;i++)await q.enqueue(nth(i));const a=await q.claim(),b=await q.claim();
 await assert.rejects(q.enqueue(nth(4)),/capacity/);
 const r=createModelQueue(opts),c=await r.claim(),d=await r.claim();
 assert.equal(new Set([a,b,c,d].map(x=>x.ticketId)).size,4);assert.equal(await r.claim(),null);
 await r.complete(a.ticketId,finish(a));await r.enqueue(nth(4));
 assert.equal(Object.values(f.db.modelJobs).filter(j=>j.status==='dispatched').length,3);
});
test('archived jobs take their sealed binding to the vault archive, and an archived job still answers completedFor and a lost claim from it',async()=>{
 const f=fixture(),archive=memStore(),moved=[],blobs=new Map(),cold=new Map();
 const vault={archives:true,put:async(k,v)=>{if(!blobs.has(k)&&!cold.has(k))blobs.set(k,structuredClone(v));},get:async k=>structuredClone(blobs.get(k)??cold.get(k)),archive:async items=>{for(const{id}of items){moved.push(id);cold.set(id,blobs.get(id));blobs.delete(id);}return{moved:items.length,already:0,absent:0,conflicts:0};}};
 const opts={...f.options,vault,archive,maxQueued:4,maxJobs:8},q=createModelQueue(opts);
 await runFinished(q,0,20);await q.enqueue(nth(20));
 assert.ok(moved.length>=8,'bindings of archived jobs moved');assert.ok(blobs.size<=8+4,'active vault holds only the active file\'s bindings');
 assert.equal(blobs.size+cold.size,21,'every binding kept');
 const b=nth(0);assert.deepEqual(await q.completedFor({custodyJobId:b.custodyJobId,owner:b.owner,publicKey:b.publicKey,contextDigest:b.contextDigest}),{status:'attested',inspectionDigest:b.inspectionDigest});
 assert.equal((await createModelQueue(opts).claim({claimId:claimOf(0)})).ticketId,ticketOf(b));
});
test('a failed binding move keeps the jobs active and is retried by the next compaction',async()=>{
 const f=fixture(),archive=memStore();let fail=true;const blobs=new Map();
 const vault={archives:true,put:async(k,v)=>blobs.set(k,structuredClone(v)),get:async k=>structuredClone(blobs.get(k)),archive:async items=>{if(fail)throw Error('review_vault_archive_quota');return{moved:items.length,already:0,absent:0,conflicts:0};}};
 const errors=[],q=createModelQueue({...f.options,vault,archive,maxQueued:4,maxJobs:8,onError:e=>errors.push(e)});
 await runFinished(q,0,8);await q.enqueue(nth(8));
 assert.equal(Object.keys(f.db.modelJobs).length,9,'nothing left the active file');assert.equal(errors.length,1);
 fail=false;const t=await q.claim();await q.complete(t.ticketId,finish(t));await q.enqueue(nth(9));
 assert.ok(Object.keys(f.db.modelJobs).length<=8);
});
