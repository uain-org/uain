import{ReviewError}from'../review-service/errors.mjs';
/** Private single-writer metadata; encrypted payloads live in the separate vault.
 * Linux flock is attached to an open file description, not a PID or pathname.
 * Never unlink writer.lock: replacing its inode could admit two writers. */
import{mkdir,open,lstat,readFile,rename,unlink}from'node:fs/promises';
import{constants}from'node:fs';import{spawn}from'node:child_process';
import{join}from'node:path';import{randomUUID}from'node:crypto';import{createGroupCommitStore}from'./store.mjs';
const MAX_METADATA=16*1024*1024;
function validate(value){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Buffer.byteLength(JSON.stringify(value))>MAX_METADATA)throw new ReviewError('review_store_capacity');}
async function acquire(handle){
 if(process.platform!=='linux')throw new ReviewError('review_store_lock_unavailable');
 // stdio[3] duplicates this SAME open file description into flock. Its child
 // exits after acquiring, while our retained descriptor keeps the kernel lock.
 await new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','ignore',handle.fd]});
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new ReviewError('review_store_lock_unavailable'));},5000);
  child.once('error',()=>{clearTimeout(timer);reject(new ReviewError('review_store_lock_unavailable'));});
  child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error(code===1?'review_store_busy':'review_store_lock_unavailable'));});
 });
}
export async function openReviewStore(directory){
 if(process.platform!=='linux')throw new ReviewError('review_store_lock_unavailable');
 await mkdir(directory,{mode:0o700,recursive:true});const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw new ReviewError('review_store_permissions');
 const lockPath=join(directory,'writer.lock');let lock;
 try{
  lock=await open(lockPath,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  const descriptor=await lock.stat();
  // A nonempty legacy PID/exclusive-create lock needs explicit offline migration;
  // never guess whether its older writer is alive, and never delete its file.
  if(!descriptor.isFile()||descriptor.uid!==process.getuid()||(descriptor.mode&0o077)||descriptor.nlink!==1||descriptor.size!==0)throw new ReviewError('review_store_lock_refused');
  await acquire(lock);const path=await lstat(lockPath);
  if(path.isSymbolicLink()||path.ino!==descriptor.ino||path.dev!==descriptor.dev||path.nlink!==1)throw new ReviewError('review_store_lock_refused');
  let initial={};const file=join(directory,'metadata.json');
  try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||s.size>MAX_METADATA)throw new ReviewError('review_store_refused');initial=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  validate(initial);
  const store=createGroupCommitStore({initialState:initial,maxBatch:8,maxQueued:32,validate,persist:async value=>{
   const temp=join(directory,'.metadata-'+randomUUID());let f;
   try{f=await open(temp,'wx',0o600);await f.writeFile(JSON.stringify(value));await f.sync();await f.close();f=null;await rename(temp,file);const d=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await d.sync();}finally{await d.close();}}
   finally{await f?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }});
  let closing=null;return{...store,async close(){if(!closing)closing=(async()=>{try{await store.close();}finally{await lock.close();}})();return closing;}};
 }catch(error){await lock?.close();throw error;}
}
