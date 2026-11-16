// Public federation workflows. Only a pinned verifier can mint an in-process
// signing context; copied gateway/indexer JSON cannot authorize a command.
import {createHash,createPublicKey} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {memberAddress,signedEnvelope,signingBytes} from './signing.mjs';
const verified=new WeakMap();
const hex32=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
async function hashFile(path,max){const info=await stat(path);if(!info.isFile()||info.size>max)throw Error('invalid pinned native artifact');const hash=createHash('sha256');for await(const data of createReadStream(path))hash.update(data);return hash.digest('hex');}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export async function readFederationState({executable,executableSha256,genesis,genesisSha256,rpc,request,maxAgeSeconds=120,timeoutMs=65000,signal}){
 if(!hex32(executableSha256)||!hex32(genesisSha256)||!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>600)throw Error('independent native executable/genesis pins and bounded freshness required');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>65000)throw Error('bounded native reader timeout required');
 signal?.throwIfAborted();
 const binary=resolve(executable),genesisPath=resolve(genesis);
 if(await hashFile(binary,256*1024*1024)!==executableSha256||await hashFile(genesisPath,8*1024*1024)!==genesisSha256)throw Error('native verifier/genesis differs from independent pin');
 const input=JSON.stringify(request);if(Buffer.byteLength(input)>65536)throw Error('bounded public selection required');
 const directory=await mkdtemp(join(tmpdir(),'uain-public-state-'));await chmod(directory,0o700);
 try{
  const output=join(directory,'state.json');
  await new Promise((resolve,reject)=>{
   const child=spawn(binary,['--genesis',genesisPath,'--genesis-sha256',genesisSha256,'--rpc',rpc,'--out',output,'--max-age',`${maxAgeSeconds}s`],{stdio:['pipe','ignore','pipe'],signal,killSignal:'SIGKILL'});
   let diagnostic='',settled=false;const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
   child.stderr.on('data',b=>diagnostic=(diagnostic+b).slice(-4096));
   child.once('error',e=>{clearTimeout(timer);settled=true;reject(e);});
   child.once('close',code=>{clearTimeout(timer);if(!settled)code===0?resolve():reject(Error(`finalized federation state refused: ${diagnostic.trim()}`));});
   child.stdin.on('error',()=>{});child.stdin.end(input);
  });
  signal?.throwIfAborted();const info=await stat(output);if(!info.isFile()||info.size>8*1024*1024||(info.mode&0o077)!==0)throw Error('invalid native snapshot output');
  const state=freeze(JSON.parse(await readFile(output,'utf8')));
  verified.set(state,{maxAgeSeconds,member:request.member??null,instance:request.instance??null,keys:request.keys??[]});return state;
 }finally{await rm(directory,{recursive:true,force:true});}
}
export function composeFederationCommand({state,operation,payload,signingKey,expiresInBlocks=100}){
 const trust=verified.get(state);if(!trust)throw Error('a snapshot from the pinned finalized reader is required');
 const age=Date.now()-new Date(state.header_time).getTime();if(!Number.isFinite(age)||age< -60000||age>trust.maxAgeSeconds*1000)throw Error('finalized signing context expired');
 if(!Number.isInteger(expiresInBlocks)||expiresInBlocks<1||expiresInBlocks>720||typeof operation!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(operation))throw Error('bounded command operation/expiry required');
 if(['private_payment','coin_shield','coin_exit'].includes(operation))throw Error('private operations require the existing private-state/review workflow');
 const key=createPublicKey(signingKey),raw=key.export({type:'spki',format:'der'}).subarray(-32),member=memberAddress(raw);
 if(operation==='enrol'){
  if(trust.member||trust.instance||!trust.keys.includes('member/'+member)||state.records?.['member/'+member]!==null)throw Error('enrolment requires proven absence of this local member');
  const migration=state.records?.legacy_import;if(migration&&migration.status!=='ready')throw Error('legacy account import is not reconciled');
  const envelope=signedEnvelope({version:1,chain_id:state.chain_id,member,sequence:'0',expires_height:String(BigInt(state.height)+BigInt(expiresInBlocks)),operation,payload:structuredClone(payload)},raw,signingKey);
  if(Buffer.byteLength(JSON.stringify(envelope))>65536)throw Error('native envelope exceeds bound');return envelope;
 }
 if(!state.member||state.member.id!==member||trust.member!==member||state.member.public_key!==raw.toString('base64url')||state.member.licence!=='active')throw Error('local key must own the proven active native member');
 if(state.instance&&(state.instance.member!==member||state.instance.id!==trust.instance||state.instance.state!=='active')||trust.instance&&!state.instance)throw Error('proven active instance ownership required');
 const migration=state.records?.legacy_import;
 if(migration&&migration.status!=='ready'&&!operation.startsWith('legacy_'))throw Error('legacy account import is not reconciled');
 const command={version:1,chain_id:state.chain_id,member,sequence:state.member.sequence,expires_height:String(BigInt(state.height)+BigInt(expiresInBlocks)),operation,payload:structuredClone(payload)};
 if(trust.instance)command.instance=trust.instance;
 const envelope=signedEnvelope(command,raw,signingKey);
 if(Buffer.byteLength(JSON.stringify(envelope))>65536)throw Error('native envelope exceeds bound');return envelope;
}

// Bounded cursor scanning uses authenticated event records, never a transaction
// indexer's success flag. The caller persists scanned_through for the next poll.
export async function findFederationReceipt({reader,envelope,afterEvent,maxEvents=128,signal}){
 if(typeof afterEvent!=='string'||!/^(0|[1-9][0-9]*)$/.test(afterEvent)||!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>256)throw Error('bounded finalized event cursor required');
 const digest=createHash('sha256').update(signingBytes(envelope.command)).digest('hex');
 const latest=await readFederationState({...reader,request:{},signal});
 if(latest.chain_id!==envelope.command.chain_id)throw Error('receipt reader belongs to another chain');
 let cursor=BigInt(afterEvent);const count=BigInt(latest.event_count),end=cursor+BigInt(maxEvents)<count?cursor+BigInt(maxEvents):count;
 if(cursor>count)throw Error('receipt cursor exceeds finalized chain');
 while(cursor<end){const ids=[];for(let i=cursor+1n;i<=end&&ids.length<32;i++)ids.push(i);const keys=ids.map(i=>'event/'+String(i).padStart(20,'0'));
  const state=await readFederationState({...reader,request:{keys},signal});
  for(let i=0;i<ids.length;i++){
   const event=state.records[keys[i]];if(!event||event.id!==String(ids[i]))throw Error('finalized event cursor has a missing record');
   cursor=ids[i];if(event.command_digest!==digest)continue;
   const final=await readFederationState({...reader,request:{receipt:{envelope,event_id:String(cursor)}},signal});
   if(!final.receipt?.finalized||final.receipt.event.command_digest!==digest)throw Error('finalized command receipt refused');
   return{...final.receipt,scanned_through:String(cursor),proof:final};
  }
 }
 return{authority:'native',finalized:false,scanned_through:String(cursor),more:cursor<count};
}
