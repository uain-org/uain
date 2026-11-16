import test from'node:test';import assert from'node:assert/strict';import{runCycle,runLoop}from'../src/runtime.mjs';
test('bounded cycle passes source cursor and never invents submissions',async()=>{let selection;const calls=[];const results=await runCycle({source:{discover:async opts=>(selection=opts,['S-1'])},worker:{enqueue:async id=>calls.push(id),run:async id=>({submission:id,state:'completed'})},after:32,limit:4});assert.deepEqual(selection,{after:32,limit:4});assert.deepEqual(calls,['S-1']);assert.equal(results.length,1);});
test('once runs one discovery page and no timer',async()=>{let n=0;await runLoop({source:{discover:async()=>[],taskCount:async()=>0},worker:{},once:true,onCycle:()=>n++});assert.equal(n,1);});
test('only uncertain custody jobs reconcile; provider uncertainty is never retried',async()=>{const calls=[];const worker={enqueue:async()=>{},status:id=>({state:'uncertain',phase:id==='S-1'?'custody':'provider'}),reconcile:async id=>(calls.push('receipt:'+id),{}),run:async id=>(calls.push('run:'+id),{})};await runCycle({source:{discover:async()=>['S-1','S-2']},worker});assert.deepEqual(calls,['receipt:S-1']);});
test('reconcile retained custody execution even after finalized task leaves discovery',async()=>{const calls=[];const results=await runCycle({source:{discover:async()=>[]},worker:{pendingReconciliations:()=>['S-finalized'],reconcile:async id=>(calls.push(id),{state:'completed'})}});assert.deepEqual(calls,['S-finalized']);assert.deepEqual(results,[{state:'completed'}]);});


import {NativeReaderError} from '../../../apps/baink/server/native-asset.mjs';
test('discovery outage waits and resumes same page without executing work during refusal',async()=>{
 const abort=new AbortController(),pages=[],events=[],calls=[];let reads=0;const started=Date.now();
 const source={discover:async({after})=>{pages.push(after);if(++reads===1)throw new NativeReaderError(1,null,'rpc_connection_refused');return ['S-1'];},taskCount:async()=>1};
 await runLoop({source,worker:{enqueue:async id=>calls.push(id),run:async id=>({submission:id,state:'completed'})},intervalMs:1000,signal:abort.signal,onUnavailable:event=>events.push(event),onCycle:()=>abort.abort()});
 assert.ok(Date.now()-started>=950,'retry retains the configured delay');assert.deepEqual(pages,[0,0]);assert.deepEqual(calls,['S-1']);assert.deepEqual(events,[{phase:'discovery',category:'rpc_connection_refused',exitCode:1}]);
});
test('task-count outage does not replay completed page or change cursor until recovery',async()=>{
 const abort=new AbortController(),pages=[],events=[];let counts=0;
 await runLoop({source:{discover:async({after})=>(pages.push(after),[]),taskCount:async()=>{if(++counts===1)throw new NativeReaderError(1,null,'rpc_connection_refused');return 100;}},worker:{},intervalMs:1000,signal:abort.signal,onUnavailable:event=>events.push(event),onCycle:()=>{if(pages.length===2)abort.abort();}});
 assert.deepEqual(pages,[0,32]);assert.equal(counts,2);assert.equal(events[0].phase,'task_count');
});
test('unknown failures and worker exceptions still reject immediately',async()=>{
 for(const error of [new Error('pin mismatch')]){
  await assert.rejects(runLoop({source:{discover:async()=>{throw error;}},worker:{},intervalMs:1000}),e=>e===error);
 }
 // Store-level worker failures still stop the loop with the journal intact.
 const closed=Error('worker busy or closed');
 await assert.rejects(runLoop({source:{discover:async()=>['S-1']},worker:{enqueue:async()=>{throw closed;}},intervalMs:1000}),e=>e===closed);
});
test('abort during dependency retry stops without another read',async()=>{
 const abort=new AbortController();let reads=0;
 await runLoop({source:{discover:async()=>{reads++;throw new NativeReaderError(1,null,'rpc_connection_refused');}},worker:{},intervalMs:1000,signal:abort.signal,onUnavailable:()=>abort.abort()});assert.equal(reads,1);
});

test('one-shot research check reports dependency refusal and never silently retries',async()=>{
 const error=new NativeReaderError(1,null,'rpc_connection_refused');let reads=0;
 await assert.rejects(runLoop({once:true,source:{discover:async()=>{reads++;throw error;}},worker:{}}),e=>e===error);assert.equal(reads,1);
});

import {openCursorStore,itemFailure} from '../src/runtime.mjs';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('a poison submission ahead of a valid one is isolated; the valid one is reviewed',async()=>{
 const notes=[],errors=[],runs=[];
 const worker={enqueue:async()=>{},status:()=>null,noteBlocked:async(id,reason)=>notes.push([id,reason]),run:async id=>{runs.push(id);if(id==='S-bad')throw Error('authenticated cumulative project budget');return {submission:id,state:'completed'};}};
 const results=await runCycle({source:{discover:async()=>['S-bad','S-good']},worker,onItemError:e=>errors.push(e)});
 assert.deepEqual(runs,['S-bad','S-good']);assert.deepEqual(notes,[['S-bad','submission_error']]);
 assert.deepEqual(results,[{submission:'S-bad',state:'blocked',reason:'submission_error'},{submission:'S-good',state:'completed'}]);
 assert.equal(errors[0].submission,'S-bad');assert.match(errors[0].message,/budget/);
});
test('a retryable read error inside run blocks only that item and the loop survives',async()=>{
 const abort=new AbortController(),cycles=[];
 const worker={enqueue:async()=>{},status:()=>null,noteBlocked:async()=>{},run:async id=>{if(id==='S-1')throw new NativeReaderError(1,null,'rpc_connection_refused');return {submission:id,state:'completed'};}};
 await runLoop({source:{discover:async()=>['S-1','S-2'],taskCount:async()=>2},worker,intervalMs:1000,signal:abort.signal,onCycle:r=>{cycles.push(r);abort.abort();}});
 assert.deepEqual(cycles[0].map(r=>r.state),['blocked','completed']);assert.equal(cycles[0][0].reason,'assignment_unavailable');
});
test('failure categories are typed, never message text',()=>{
 assert.equal(itemFailure(new NativeReaderError(1,null,'rpc_connection_refused')),'assignment_unavailable');
 assert.equal(itemFailure(new NativeReaderError(1,null,'reader_refused')),'assignment_unreadable');
 assert.equal(itemFailure(Object.assign(Error('x'),{code:'stale_proof'})),'stale_proof');
 assert.equal(itemFailure(Object.assign(Error('x'),{code:'ENOENT'})),'submission_error');
 assert.equal(itemFailure(new TypeError('boom')),'submission_error');
});
test('cursor persists between restarts and advances only after a processed page',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cr-cursor-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cursor=await openCursorStore(dir);assert.equal(await cursor.read(),0);
 const pages=[];const abort=new AbortController();
 await runLoop({source:{discover:async({after})=>(pages.push(after),[]),taskCount:async()=>100},worker:{},cursor,intervalMs:1000,signal:abort.signal,onCycle:()=>{if(pages.length===2)abort.abort();}});
 assert.deepEqual(pages,[0,32]);assert.equal(await cursor.read(),32,'first page done; second page in progress is not skipped');
 // Restart: resume at 32, not 0.
 const restarted=[];const again=new AbortController();
 await runLoop({source:{discover:async({after})=>(restarted.push(after),[]),taskCount:async()=>100},worker:{},cursor:await openCursorStore(dir),intervalMs:1000,signal:again.signal,onCycle:()=>again.abort()});
 assert.deepEqual(restarted,[32]);
 // A crash mid-page (thrown store failure) leaves the cursor where it was.
 await assert.rejects(runLoop({source:{discover:async()=>['S-1'],taskCount:async()=>100},worker:{enqueue:async()=>{throw Error('database capacity');}},cursor,intervalMs:1000}));
 assert.equal(await cursor.read(),32);
 // Wrapping back to 0 is persisted as 0.
 await cursor.write(96);const wrap=new AbortController();let n=0;
 await runLoop({source:{discover:async()=>[],taskCount:async()=>100},worker:{},cursor,intervalMs:1000,signal:wrap.signal,onCycle:()=>{if(++n===2)wrap.abort();}});
 assert.equal(await cursor.read(),0);
 await writeFile(join(dir,'cursor.json'),'{"schema":"x","after":3}');await chmod(join(dir,'cursor.json'),0o600);
 await assert.rejects(cursor.read(),/cursor format/);
});

// 10 November 2026: the nightly node backup pauses the node at 03:10 UTC and the pinned reader refuses
// the selection (reader_refused). A read changes nothing, so the loop waits and reads again instead of exiting.
test('a refused proof read during discovery or task count waits and resumes instead of exiting',async()=>{
 const abort=new AbortController(),events=[],pages=[];let reads=0,counts=0;
 const source={discover:async({after})=>{pages.push(after);if(++reads===1)throw new NativeReaderError(1,null,'reader_refused');return [];},taskCount:async()=>{if(++counts===1)throw new NativeReaderError(1,null,'reader_refused');return 100;}};
 let cycles=0;
 await runLoop({source,worker:{},intervalMs:1000,signal:abort.signal,onUnavailable:e=>events.push(e),onCycle:()=>{if(++cycles===2)abort.abort();}});
 assert.deepEqual(events.map(e=>[e.phase,e.category]),[['discovery','reader_refused'],['task_count','reader_refused']]);
 assert.deepEqual(pages,[0,0,32]);
});
test('a one-shot run still reports a refused proof read instead of waiting',async()=>{
 const error=new NativeReaderError(1,null,'reader_refused');
 await assert.rejects(runLoop({once:true,source:{discover:async()=>{throw error;}},worker:{}}),e=>e===error);
});
