import {NativeReaderError} from '../../../apps/baink/server/native-asset.mjs';
import {mkdir,open,readFile,rename,lstat} from 'node:fs/promises';import {join,isAbsolute} from 'node:path';import {randomUUID} from 'node:crypto';
const retryable = error => error instanceof NativeReaderError && error.retryable;
class DiscoveryUnavailable extends Error { constructor(reader) { super('Native discovery unavailable'); this.reader=reader; } }
/** A per-submission failure category. It is operational, never a review verdict, and never reaches custody. */
export function itemFailure(error){
 if(retryable(error))return 'assignment_unavailable';
 if(error instanceof NativeReaderError)return 'assignment_unreadable';
 if(error?.code&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code))return error.code;
 return 'submission_error';
}
const fatal=error=>/^(worker busy or closed|worker busy|database capacity|store format|store directory|lock (file|inode))$/.test(error?.message??'');
/**
 * Bounded orchestration. Host entrypoint supplies qualified source, custody and provider.
 * One submission's failure is isolated: it is recorded as an operational blocked reason on the
 * still-queued job (no verdict, no custody call), reported through onItemError, and retried on the
 * next pass over that page. Store-level failures (closed worker, full database) still stop the loop.
 */
export async function runCycle({source,worker,after=0,limit=32,onItemError=()=>{}}){
 const results=[],reconciled=new Set();
 const isolate=async(submission,step)=>{
  try{return await step();}
  catch(error){
   if(fatal(error))throw error;
   const reason=itemFailure(error);
   try{await worker.noteBlocked?.(submission,reason);}catch(noteError){if(fatal(noteError))throw noteError;}
   await onItemError({submission,reason,message:String(error?.message??error).slice(0,256)});
   return {submission,state:'blocked',reason};
  }
 };
 for(const submission of (worker.pendingReconciliations?.()??[]).slice(0,limit)){results.push(await isolate(submission,()=>worker.reconcile(submission)));reconciled.add(submission);}
 // Fair share (10 November 2026): before the page in discovery order, run the one job that is next
 // across all pages (a free rule-decided rejection, else the author with the fewest reviews started this
 // hour, oldest first). Without it, the first author on the first page took every review of the hour.
 const fair=worker.nextFair?.();
 if(fair&&!reconciled.has(fair)){results.push(await isolate(fair,()=>worker.run(fair)));reconciled.add(fair);}
 let pending;
 try { pending=await source.discover({after,limit}); }
 // A refused proof read changes nothing, so waiting and reading again is always safe. The nightly
 // node backup pauses the node (03:10 UTC), which made this exit the service (10 November 2026).
 catch(error) { if(error instanceof NativeReaderError)throw new DiscoveryUnavailable(error);throw error; }
 for(const submission of pending){
  if(reconciled.has(submission))continue;
  results.push(await isolate(submission,async()=>{await worker.enqueue(submission);const prior=worker.status?.(submission);if(prior?.state==='uncertain')return prior.phase==='custody'?await worker.reconcile(submission):prior;return worker.run(submission);}));
 }
 return results;
}
/**
 * Durable discovery cursor. The cursor advances only after a page has been fully processed, so a
 * restart resumes at the page in progress: work is neither skipped nor restarted from page 0.
 */
export async function openCursorStore(directory){
 if(!isAbsolute(directory))throw Error('cursor directory');
 await mkdir(directory,{recursive:true,mode:0o700});const file=join(directory,'cursor.json');
 return Object.freeze({
  async read(){
   let raw;try{const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>1024)throw Error('cursor file');raw=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return 0;throw error;}
   const value=JSON.parse(raw);if(value?.schema!=='uain-central-review-cursor-v1'||!Number.isInteger(value.after)||value.after<0||value.after%32)throw Error('cursor format');return value.after;
  },
  async write(after,clock=()=>new Date().toISOString()){
   if(!Number.isInteger(after)||after<0||after%32)throw Error('cursor value');
   const temp=join(directory,'cursor.'+randomUUID()+'.tmp');const f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify({schema:'uain-central-review-cursor-v1',after,updated_at:clock()}));await f.sync();}finally{await f.close();}
   await rename(temp,file);const d=await open(directory,'r');try{await d.sync();}finally{await d.close();}
  }
 });
}
function wait(intervalMs,signal){
 return new Promise(resolve=>{const timer=setTimeout(done,intervalMs);function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}if(signal?.aborted)done();else signal?.addEventListener('abort',done,{once:true});});
}
export async function runLoop({source,worker,once=false,intervalMs=30000,signal,cursor,onCycle=()=>{},onUnavailable=()=>{},onItemError=()=>{}}){
 if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>3600000)throw Error('loop interval');
 let after=cursor?await cursor.read():0;
 const unavailable=async(phase,error)=>{
  await onUnavailable({phase,category:error.category,exitCode:error.exitCode});
  await wait(intervalMs,signal);
 };
 while(!signal?.aborted){
  let results;
  try { results=await runCycle({source,worker,after,limit:32,onItemError}); }
  catch(error){
   // Only a failed discovery is safe to retry here. Per-submission failures are isolated inside
   // runCycle; store-level failures still stop the service with their journal intact.
   if(once||!(error instanceof DiscoveryUnavailable))throw error instanceof DiscoveryUnavailable?error.reader:error;
   await unavailable('discovery',error.reader);continue;
  }
  await onCycle(results);if(once||signal?.aborted)break;
  let count;
  while(!signal?.aborted){
   try {count=await source.taskCount();break;}
   catch(error){if(!(error instanceof NativeReaderError))throw error;await unavailable('task_count',error);}
  }
  if(signal?.aborted)break;
  after=after+32>=count?0:after+32;
  await cursor?.write(after);
  await wait(intervalMs,signal);
 }
}
