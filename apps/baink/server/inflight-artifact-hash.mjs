/** Share only overlapping reads of the same pinned artifact identity.
 * Completed digests are never cached; callers keep independent abort signals. */
import{constants}from'node:fs';
import{open,stat,realpath}from'node:fs/promises';
import{createHash}from'node:crypto';
import{isAbsolute}from'node:path';
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
const identity=s=>[s.dev,s.ino,s.size,s.mode,s.mtimeNs,s.ctimeNs].join(':');
const aborted=signal=>signal.reason??new DOMException('Artifact read aborted','AbortError');
export function createInflightArtifactHasher({openFile=open,statFile=stat,realpathFile=realpath}={}){
 const pending=new Map();
 function wait(entry,signal){
  if(signal.aborted){if(!entry.done&&entry.waiters===0)entry.controller.abort();return Promise.reject(aborted(signal));}
  entry.waiters++;
  return new Promise((resolve,reject)=>{let done=false;const finish=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',cancel);entry.waiters--;if(!entry.done&&entry.waiters===0)entry.controller.abort();error?reject(error):resolve(value);};const cancel=()=>finish(aborted(signal));signal.addEventListener('abort',cancel,{once:true});entry.promise.then(value=>finish(null,value),error=>finish(error));if(signal.aborted)cancel();});
 }
 return async function hashArtifact(path,max,signal=new AbortController().signal){
  ensure(typeof path==='string'&&isAbsolute(path)&&Number.isSafeInteger(max)&&max>0,'Invalid pinned native artifact');signal.throwIfAborted();let descriptor;
  try{
   // Resolve existing intentional release links, then refuse a symlink swap at
   // the final opened path. Named-path and descriptor identities must agree.
   const resolved=await realpathFile(path);signal.throwIfAborted();descriptor=await openFile(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await descriptor.stat({bigint:true}),named=await statFile(path,{bigint:true});
   ensure(before.isFile()&&before.size<=BigInt(max)&&!(before.mode&0o022n),'Invalid pinned native artifact permissions or size');ensure(identity(before)===identity(named),'Pinned native artifact changed during open');signal.throwIfAborted();
   const checkedResult=async entry=>{const value=await wait(entry,signal);signal.throwIfAborted();const current=await statFile(path,{bigint:true});ensure(identity(current)===identity(before)&&await realpathFile(path)===resolved,'Pinned native artifact changed before caller completion');signal.throwIfAborted();return value;};
   const key=JSON.stringify([path,resolved,max,identity(before)]);let entry=pending.get(key);
   if(entry&&!entry.done&&!entry.controller.signal.aborted){await descriptor.close();descriptor=null;return await checkedResult(entry);}
   const owned=descriptor;descriptor=null;entry={waiters:0,done:false,controller:new AbortController(),promise:null};pending.set(key,entry);
   entry.promise=Promise.resolve().then(async()=>{try{
    entry.controller.signal.throwIfAborted();const hash=createHash('sha256');let bytes=0n;
    for await(const data of owned.createReadStream({autoClose:false,signal:entry.controller.signal})){bytes+=BigInt(data.length);ensure(bytes<=BigInt(max),'Pinned native artifact changed beyond size bound');hash.update(data);}
    const after=await owned.stat({bigint:true}),current=await statFile(path,{bigint:true}),currentPath=await realpathFile(path);entry.controller.signal.throwIfAborted();
    ensure(bytes===before.size&&identity(after)===identity(before)&&identity(current)===identity(before)&&currentPath===resolved,'Pinned native artifact changed during hashing');return hash.digest('hex');
   }finally{entry.done=true;if(pending.get(key)===entry)pending.delete(key);await owned.close();}});
   // If all callers cancel, the original read still drains/cleans its descriptor.
   entry.promise.catch(()=>{});return await checkedResult(entry);
  }finally{if(descriptor)await descriptor.close();}
 };
}
