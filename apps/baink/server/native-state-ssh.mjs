/** Fixed readonly remote verifier. No generic command, RPC method or retry API. */
import{spawn}from'node:child_process';import{randomBytes}from'node:crypto';
import{mkdir,lstat,unlink}from'node:fs/promises';import{dirname,join,isAbsolute}from'node:path';import{reviewSshTarget}from'./ssh-target.mjs';
const check=(v,c)=>{if(!v)throw Error('native_state_ssh_'+c);},exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>keys.includes(k));
export const NATIVE_STATE_PROFILE=Object.freeze({chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',verifierSha256:'136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860',maxAgeSeconds:120});
const KEY='/etc/baink-review/client_ed25519',HOSTS='/etc/baink-review/known_hosts',ZERO='0'.repeat(32);
export function validatePublicSelection(value){const text=JSON.stringify(value);check(typeof text==='string'&&Buffer.byteLength(text)<=65536,'selection_bound');const v=JSON.parse(text);check(exact(v,['member','keys','receipt']),'selection_fields');if(Object.hasOwn(v,'member'))check(typeof v.member==='string'&&/^uain1[a-f0-9]{40}$/.test(v.member),'member');if(Object.hasOwn(v,'keys'))check(Array.isArray(v.keys)&&v.keys.length<=32&&v.keys.every(k=>typeof k==='string'&&/^[A-Za-z0-9_./:-]{1,512}$/.test(k)),'keys');if(Object.hasOwn(v,'receipt')){const r=v.receipt;check(exact(r,['envelope','event_id'])&&Object.keys(r).length===2&&typeof r.event_id==='string'&&/^[1-9][0-9]{0,19}$/.test(r.event_id)&&BigInt(r.event_id)<=0xffffffffffffffffn,'receipt');const e=r.envelope,c=e?.command;check(exact(e,['command','public_key','signature'])&&Object.keys(e).length===3&&exact(c,['version','chain_id','member','sequence','expires_height','operation','payload','instance'])&&['version','chain_id','member','sequence','expires_height','operation','payload'].every(k=>Object.hasOwn(c,k))&&c.version===1&&c.chain_id===NATIVE_STATE_PROFILE.chainId&&/^uain1[a-f0-9]{40}$/.test(c.member??'')&&['sequence','expires_height'].every(k=>typeof c[k]==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(c[k]))&&typeof c.operation==='string'&&/^[a-z_]{1,64}$/.test(c.operation)&&c.payload&&Object.getPrototypeOf(c.payload)===Object.prototype&&/^[A-Za-z0-9_-]{43}$/.test(e.public_key??'')&&/^[A-Za-z0-9_-]{86}$/.test(e.signature??''),'receipt_envelope');}return text;}
function validateBatchMembers(members){check(Array.isArray(members)&&members.length>=1&&members.length<=30&&members.every(m=>typeof m==='string'&&/^uain1[a-f0-9]{40}$/.test(m))&&new Set(members).size===members.length,'batch_members');return JSON.stringify({members:[...members]});}
async function ancestors(path){for(let p=path;;p=dirname(p)){const s=await lstat(p);check(s.isDirectory()&&!s.isSymbolicLink()&&[0,process.getuid()].includes(s.uid)&&(!(s.mode&0o022)||(s.uid===0&&(s.mode&0o1000))),'directory_ancestor');if(dirname(p)===p)break;}}
async function credentials(){for(const[file,privateKey]of[[KEY,true],[HOSTS,false]]){await ancestors(dirname(file));const s=await lstat(file);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size>0&&s.size<65536&&[0,process.getuid()].includes(s.uid)&&!(s.mode&(privateKey?0o077:0o022)),'credential_permissions');}}
export function createNativeStateSSH({directory='/run/baink-native-state',spawnProcess=spawn,killProcess=(pid,signal)=>process.kill(pid,signal),checkCredentials=credentials,target:configuredTarget}={}){
 const target=()=>reviewSshTarget(configuredTarget??process.env.BAINK_REVIEW_SSH_TARGET);
 check(isAbsolute(directory),'directory');
 const socket=join(directory,'master-'+randomBytes(12).toString('hex')+'.sock'),active=new Set(),stopped=new WeakSet();
 let closing=false,closePromise=null,connecting=null,master=null,reconnectTimer=null;
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const stop=child=>{if(child?.pid&&!stopped.has(child)){stopped.add(child);try{killProcess(-child.pid,'SIGKILL');}catch{}}};
 async function socketState(){try{const s=await lstat(socket);check(s.isSocket()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077),'socket');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function filesystem(){await ancestors(dirname(directory));try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const s=await lstat(directory);check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'directory_permissions');await checkCredentials();await socketState();}
 const base=()=>['-F','/dev/null','-T','-i',KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+HOSTS,'-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-o','PermitLocalCommand=no','-o','RequestTTY=no','-o','ProxyJump=none','-o','ConnectTimeout=5','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-o','LogLevel=ERROR','-o','ControlPath='+socket];
 function scheduleReconnect(){if(closing||reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;prepare().catch(()=>{});},1000);reconnectTimer.unref?.();}
 async function startMaster(){
  await filesystem();check(!closing,'closed');if(await socketState())await unlink(socket);
  const child=spawnProcess('/usr/bin/ssh',[...base(),'-o','ProxyCommand=none','-o','ControlMaster=yes','-o','ControlPersist=no','-N',target()],{stdio:['ignore','ignore','ignore'],detached:true});
  let ended=false,spawnError=null,resolveDone;const done=new Promise(resolve=>resolveDone=resolve),entry={child,done,ready:false};master=entry;
  child.once('error',error=>{ended=true;spawnError=error;});
  child.once('close',()=>{ended=true;resolveDone();if(master===entry)master=null;if(entry.ready)scheduleReconnect();});
  const timeout=setTimeout(()=>stop(child),15000);
  try{
   const until=Date.now()+15000;
   while(!ended&&!closing&&Date.now()<until){
    if(await socketState()){check(master===entry,'master');entry.ready=true;return;}
    await delay(25);
   }
   throw Error(spawnError?'native_state_ssh_master_spawn_failed':'native_state_ssh_master_unavailable');
  }catch(error){stop(child);await done;throw error;}finally{clearTimeout(timeout);}
 }
 async function prepare(){
  check(!closing,'closed');
  if(master?.ready&&await socketState())return;
  if(connecting)return connecting;
  const job=(async()=>{if(master){stop(master.child);await master.done;}await startMaster();})();connecting=job;
  try{await job;}catch(error){if(error.message==='native_state_ssh_master_unavailable')scheduleReconnect();throw error;}finally{if(connecting===job)connecting=null;}
 }
 function waitAbort(promise,signal){signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(Error('native_state_ssh_aborted'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
 function command(args,input,signal){return new Promise((resolve,reject)=>{let child,done=false,size=0,failure=null;const chunks=[];const finish=(error,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};const abort=()=>stop(child);try{signal?.throwIfAborted();child=spawnProcess('/usr/bin/ssh',args,{stdio:['pipe','pipe','ignore'],detached:true});}catch{return finish(Error('native_state_ssh_unavailable'));}signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();child.stdout.on('data',b=>{size+=b.length;if(size>2*1024*1024){failure??=Error('native_state_ssh_output_bound');abort();}else if(!failure)chunks.push(b);});child.stdin.on('error',()=>{});child.once('error',()=>finish(Error('native_state_ssh_unavailable')));child.once('close',code=>{if(failure)return finish(failure);if(signal?.aborted)return finish(Error('native_state_ssh_aborted'));if(code!==0)return finish(Error('native_state_ssh_refused'));finish(null,Buffer.concat(chunks));});child.stdin.end(input);});}
 async function perform(action,input,{signal}={}){
  check(!closing,'closed');const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]),timer=setTimeout(()=>controller.abort(),8000);
  const pending=(async()=>{combined.throwIfAborted();await waitAbort(prepare(),combined);combined.throwIfAborted();check(!closing,'closed');await filesystem();check(master?.ready&&await socketState(),'master_unavailable');
   // A missing/dead multiplex master must fail, never open an untracked WAN fallback.
   return command([...base(),'-o','ProxyCommand=/bin/false','-o','ControlMaster=no',target(),'baink-private-review',action,ZERO],input,combined);
  })();const entry={controller,pending};active.add(entry);try{return await pending;}finally{clearTimeout(timer);active.delete(entry);}
 }
 return Object.freeze({profile:NATIVE_STATE_PROFILE,prepare,read(selection,options){return perform('public-state',validatePublicSelection(selection),options);},readBatch(members,options){return perform('public-state-batch',validateBatchMembers(members),options);},close(){if(closePromise)return closePromise;closing=true;clearTimeout(reconnectTimer);closePromise=(async()=>{for(const e of active)e.controller.abort();const own=master;if(own)stop(own.child);await Promise.allSettled([...active].map(e=>e.pending));if(connecting)await connecting.catch(()=>{});if(own)await own.done;if(await socketState())await unlink(socket);})();return closePromise;}});
}
