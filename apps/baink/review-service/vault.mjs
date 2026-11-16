import{ReviewError}from'./errors.mjs';
/** Owner-bound encrypted write-once blob store. No network or signing key generation.
 * Archive (12 November 2026, P1-2): with `archiveDirectory`, `archive()` moves the sealed
 * files of finished work out of the active directory, whose file and byte quota every put
 * checks. Each file is copied into the archive first (exact bytes, fsynced), and only then
 * removed from the active directory; nothing is ever deleted. `get` and `put` look in the
 * archive when the active directory has no file, so a value stays readable and write-once. */
import{createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID}from'node:crypto';import{constants}from'node:fs';import{open,lstat,readdir,mkdir,rm,rename,unlink}from'node:fs/promises';import{join,isAbsolute,basename}from'node:path';
const check=(v,c)=>{if(!v)throw new ReviewError('review_vault_'+c);},hash=b=>createHash('sha256').update(b).digest('hex');
export async function createSealedVault({directory,key,maxValueBytes=2*1024*1024,maxBytes=64*1024*1024,maxFiles=10000,lockWaitMs=2000,archiveDirectory=null,archiveMaxFiles=100000,archiveMaxBytes=1024**3}={}){
 check(isAbsolute(directory??'')&&Buffer.isBuffer(key)&&key.length===32,'configuration');const secret=Buffer.from(key);check([maxValueBytes,maxBytes,maxFiles].every(Number.isSafeInteger)&&maxValueBytes>0&&maxValueBytes<=2*1024*1024&&maxBytes>=maxValueBytes&&maxBytes<=1024**3&&maxFiles>0&&maxFiles<=10000,'configuration');
 check(archiveDirectory===null||isAbsolute(archiveDirectory)&&archiveDirectory!==directory&&[archiveMaxFiles,archiveMaxBytes].every(Number.isSafeInteger)&&archiveMaxFiles>0&&archiveMaxFiles<=1000000&&archiveMaxBytes>=maxValueBytes&&archiveMaxBytes<=16*1024**3,'configuration');
 async function root(path=directory){const s=await lstat(path);check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'directory');}
 await root();if(archiveDirectory)await root(archiveDirectory);const sync=async(path=directory)=>{const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}};
 const keyIdentity=hash(Buffer.concat([Buffer.from('BAINK/review-vault/key-id/v1\n'),secret]));const identityPath=join(directory,'.key-id');let identityFile;
 try{identityFile=await open(identityPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await identityFile.writeFile(keyIdentity+'\n');await identityFile.sync();await sync();}catch(e){if(e.code!=='EEXIST')throw e;const f=await open(identityPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const st=await f.stat();check(st.isFile()&&st.uid===process.getuid()&&st.nlink===1&&!(st.mode&0o077)&&st.size===65,'key_identity');check(await f.readFile('utf8')===keyIdentity+'\n','key_identity');}finally{await f.close();}}finally{await identityFile?.close();}
 function binding(id,owner){check(typeof id==='string'&&/^[a-f0-9]{32}(?::result)?$/.test(id)&&/^uain1[a-f0-9]{40}$/.test(owner??''),'binding');const aad=Buffer.from('BAINK/review-vault/v1\n'+JSON.stringify({id,owner}));return{aad,path:join(directory,hash(aad)+'.sealed')};}
 async function raw(path){let f;try{f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')throw new ReviewError('review_vault_missing');throw e;}try{const s=await f.stat();check(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077)&&s.size<=maxValueBytes*2+4096,'file');return await f.readFile();}finally{await f.close();}}
 async function read(path){return JSON.parse((await raw(path)).toString('utf8'));}
 const archived=path=>archiveDirectory?join(archiveDirectory,basename(path)):null;
 // The active file first, then its archived copy: a file leaves the active directory only
 // after its archive copy is durable, so a reader that misses one always finds the other.
 async function readAny(path){try{return await read(path);}catch(e){if(e.message!=='review_vault_missing'||!archiveDirectory)throw e;return read(archived(path));}}
 function decode(value,aad){check(value?.schema==='baink-review-sealed-v1'&&Object.keys(value).sort().join()==='ciphertext,nonce,schema,tag','format');const nonce=Buffer.from(value.nonce,'base64'),tag=Buffer.from(value.tag,'base64'),data=Buffer.from(value.ciphertext,'base64');check(nonce.length===12&&tag.length===16&&data.length<=maxValueBytes,'format');const c=createDecipheriv('aes-256-gcm',secret,nonce);c.setAAD(aad);c.setAuthTag(tag);return JSON.parse(Buffer.concat([c.update(data),c.final()]).toString('utf8'));}
 // Bounded wait for the cross-process write lock (HTTP submit and the background tick both write).
 // Contention is short-lived; only a lock held beyond the bound reports review_vault_busy (retryable).
 async function acquire(lock){const end=Date.now()+lockWaitMs;for(let delay=5;;delay=Math.min(delay*2,100)){try{await mkdir(lock,{mode:0o700});return;}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()+delay>end)throw new ReviewError('review_vault_busy');await new Promise(r=>setTimeout(r,delay));}}}
 async function putNow(id,value,{owner}){check(!closed,'closed');const b=binding(id,owner),json=JSON.stringify(value);check(typeof json==='string'&&Buffer.byteLength(json)<=maxValueBytes,'size');const plain=Buffer.from(json);await root();const lock=join(directory,'.lock');await acquire(lock);let temp;
 try{await sync();try{const old=decode(await readAny(b.path),b.aad);check(JSON.stringify(old)===json,'conflict');return;}catch(e){if(e.message!=='review_vault_missing')throw e;}
 let bytes=0,count=0;for(const name of await readdir(directory)){if(name==='.lock'||name==='.key-id')continue;check(/^[a-f0-9]{64}\.sealed$/.test(name),'unreviewed_recovery');const s=await lstat(join(directory,name));check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077),'file');bytes+=s.size;count++;}
 const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',secret,nonce);c.setAAD(b.aad);const data=Buffer.concat([c.update(plain),c.final()]);const wire=Buffer.from(JSON.stringify({schema:'baink-review-sealed-v1',nonce:nonce.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:data.toString('base64')}));check(count<maxFiles&&bytes+wire.length<=maxBytes,'quota');temp=b.path+'.'+randomUUID()+'.new';const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(wire);await f.sync();}finally{await f.close();}await rename(temp,b.path);temp=null;await sync();
 }finally{plain.fill(0);if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true});await sync();}}
 // Moves the sealed files of finished work into the archive directory. Per file: the exact
 // active bytes must decrypt under their own binding; an equal archive copy (left by a crash
 // between copy and removal) is reused, a different one is a conflict and the active file stays.
 async function archiveNow(items){check(!closed,'closed');check(archiveDirectory,'archive_unavailable');check(Array.isArray(items)&&items.length<=4096,'binding');const list=items.map(({id,owner}={})=>binding(id,owner));
  await root();await root(archiveDirectory);const lock=join(directory,'.lock');await acquire(lock);const out={moved:0,already:0,absent:0,conflicts:0};let temp,removed=false;
  try{let bytes=0,count=0;for(const name of await readdir(archiveDirectory)){check(/^[a-f0-9]{64}\.sealed$/.test(name),'unreviewed_recovery');const s=await lstat(join(archiveDirectory,name));check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077),'file');bytes+=s.size;count++;}
   for(const b of list){const target=archived(b.path);let data;try{data=await raw(b.path);}catch(e){if(e.message!=='review_vault_missing')throw e;try{await raw(target);out.already++;}catch(x){if(x.message!=='review_vault_missing')throw x;out.absent++;}continue;}
    decode(JSON.parse(data.toString('utf8')),b.aad);let copy=null;try{copy=await raw(target);}catch(e){if(e.message!=='review_vault_missing')throw e;}
    if(copy){if(!copy.equals(data)){out.conflicts++;continue;}}
    else{check(count<archiveMaxFiles&&bytes+data.length<=archiveMaxBytes,'archive_quota');temp=target+'.'+randomUUID()+'.new';const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(data);await f.sync();}finally{await f.close();}await rename(temp,target);temp=null;await sync(archiveDirectory);check((await raw(target)).equals(data),'archive_readback');count++;bytes+=data.length;}
    await unlink(b.path);removed=true;out[copy?'already':'moved']++;}
   return out;
  }finally{if(temp)await rm(temp,{force:true});if(removed)await sync().catch(()=>{});await rm(lock,{recursive:true});await sync();}}
 let queue=Promise.resolve();const serial=fn=>{const run=queue.then(fn,fn);queue=run.catch(()=>{});return run;};
 let closed=false;return Object.freeze({
 async get(id,{owner}={}){check(!closed,'closed');await root();const b=binding(id,owner);return decode(await readAny(b.path),b.aad);},
 put(id,value,{owner}={}){return serial(()=>putNow(id,value,{owner}));},
 /** Finished work only: [{id, owner}] → {moved, already, absent, conflicts}. Never deletes a value. */
 archive(items){return serial(()=>archiveNow(items));},
 archives:Boolean(archiveDirectory),
 close(){closed=true;secret.fill(0);}
 });
}
