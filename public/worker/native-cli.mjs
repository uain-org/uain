// Member-held native commands. No key or private parameters enter argv, an
// agent prompt, a gateway request, a transaction journal or diagnostic output.
import {createPrivateKey,createPublicKey,createHash,verify} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdtemp,link,rm,lstat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {readFederationState,composeFederationCommand,findFederationReceipt} from './federation-workflow.mjs';
import {memberAddress,signingBytes} from './signing.mjs';
import {researchEvidence} from './evidence-document.mjs';
import {ensureLocalWallet,walletBindingPayload,provisionReceivingWallets} from './external-wallets.mjs';

// This evidence is issued only by the production submit implementation after
// checking that it has not handed off a transaction and no durable send marker
// exists. A caller field/error message cannot manufacture this classification.
const submissionNotAttempted=new WeakMap();
async function recordSubmissionNotAttempted(error,journalFile){
 if(!(error instanceof Error)||typeof journalFile!=='string')return;
 try{await lstat(journalFile+'.sent');}catch(check){if(check.code==='ENOENT')submissionNotAttempted.set(error,resolve(journalFile));}
}
export function nativeSubmissionNotAttempted(error,journalFile){return error instanceof Error&&typeof journalFile==='string'&&submissionNotAttempted.get(error)===resolve(journalFile);}
export const NATIVE_HELP=`UAIN native commands (member key stays on this computer)

  uain-client native state     verify public state with independent pins
  uain-client native prepare   sign and durably retain a public command
  uain-client native submit    send that exact journal once; acceptance is pending
  uain-client native receipt   prove the successful finalized event
  uain-client native activate  wait up to 120s for independently proved activation
  uain-client native publish   publish the body committed by a finalized submit
  uain-client native wallets   provision and prove local ETH and SOL receiving wallets

Each action reads one bounded JSON object from stdin. Use an independently
obtained reader executable/genesis hash and the local member signingKeyFile.
prepare writes a new journal before any network submission. submit never signs
a replacement after a timeout. receipt scans from the saved event cursor and
returns scanned_through for the next bounded poll. See docs/chain/native-client.md.
Private exchange actions continue to use uain-client private.`;
const sha=value=>createHash('sha256').update(value).digest('hex');
async function privateJSON(path,max=128*1024){
 if(typeof path!=='string'||!path)throw Error('private local file required');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||info.size>max||(info.mode&0o077)!==0||process.getuid&&info.uid!==process.getuid())throw Error('private owned regular file required');return JSON.parse(await file.readFile('utf8'))}finally{await file.close()}
}
async function save(path,value){
 if(typeof path!=='string'||!path)throw Error('new native output path required');
 const parent=dirname(resolve(path)),temporary=await mkdtemp(join(parent,'.uain-native-'));
 try{const pending=join(temporary,'value'),file=await open(pending,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync()}finally{await file.close()}await link(pending,path)}finally{await rm(temporary,{recursive:true,force:true})}
 const directory=await open(parent,'r');try{await directory.sync()}finally{await directory.close()}
}
async function localKey(path){
 const key=await privateJSON(path,8192);
 if(key.algorithm!=='Ed25519'||typeof key.public_key!=='string'||typeof key.private_key!=='string')throw Error('local member identity key required');
 const secret=createPrivateKey({key:{kty:'OKP',crv:'Ed25519',x:key.public_key,d:key.private_key},format:'jwk'}),pub=createPublicKey(secret).export({format:'jwk'}).x;
 if(pub!==key.public_key||memberAddress(Buffer.from(pub,'base64url'))!==key.address)throw Error('local member identity binding differs');return{secret,member:key.address};
}
function journalReader(reader,journal){
 if(!reader||reader.executableSha256!==journal.verifier_sha256||reader.genesisSha256!==journal.genesis_sha256)throw Error('journal independent native pins differ');return reader;
}
async function journal(path){
 const value=await privateJSON(path),e=value.envelope;
 if(value.format!=='uain-native-command-v1'||!e||Object.keys(e).sort().join(',')!=='command,public_key,signature')throw Error('native command journal required');
 const pub=Buffer.from(e.public_key,'base64url'),sig=Buffer.from(e.signature,'base64url');
 if(pub.length!==32||pub.toString('base64url')!==e.public_key||sig.length!==64||sig.toString('base64url')!==e.signature||memberAddress(pub)!==e.command.member||!verify(null,signingBytes(e.command),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:e.public_key},format:'jwk'}),sig)||sha(Buffer.from(JSON.stringify(e))).toUpperCase()!==value.transaction_hash)throw Error('native command journal signature/bytes differ');
 if(!/^(0|[1-9][0-9]*)$/.test(value.after_event))throw Error('native journal event cursor invalid');
 if(value.body){const body=researchEvidence(value.body);if(e.command.operation!=='submit'||body.digest!==e.command.payload.evidence_digest)throw Error('native journal evidence differs')}
 return value;
}
function publicURL(value){const url=new URL(value);if(url.username||url.password||url.hash||url.search||(url.protocol!=='https:'&&(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname))))throw Error('public HTTPS or isolated loopback endpoint required');return url;}
async function post(url,input,max=128*1024,signal){
 signal?.throwIfAborted();
 const response=await fetch(publicURL(url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('native response exceeds bound');parts.push(value)}}finally{await reader.cancel()}
 const body=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!response.ok)throw Error('native endpoint refused');return body;
}
async function waitForActivation(input){
 const waitMs=input.waitMs??120000,pollMs=input.pollMs??2000;
 if(!Number.isInteger(waitMs)||waitMs<50||waitMs>120000||!Number.isInteger(pollMs)||pollMs<50||pollMs>10000)throw Error('bounded activation wait/poll required');
 const key=await localKey(input.signingKeyFile),publicKey=createPublicKey(key.secret).export({format:'jwk'}).x,deadline=performance.now()+waitMs;
 let verificationPending=false,licence='pending';
 while(performance.now()<deadline){
  let state;
  try{state=await readFederationState({...input.reader,request:{member:key.member},timeoutMs:Math.max(1,Math.min(10000,Math.floor(deadline-performance.now())))})}
  catch(error){if(!error.message.startsWith('finalized federation state refused:'))throw error;verificationPending=true}
  if(state){
   if(state.member?.id!==key.member||state.member.public_key!==publicKey)throw Error('activation requires the proved local member identity; finalize enrolment first');
   licence=state.member.licence;
   if(!['pending','active'].includes(licence))throw Error(`member licence ${licence} cannot be activated by this client`);
   if(licence==='active'&&performance.now()<deadline)return{member:key.member,active:true,licence,chain_id:state.chain_id,height:state.height};
   verificationPending=false;
  }
  const remaining=deadline-performance.now();if(remaining>0)await delay(Math.min(pollMs,remaining));
 }
 return{member:key.member,active:false,licence,status:'pending',timed_out:true,retryable:true,...(verificationPending?{verification_pending:true}:{}),next_action:'native activate with the same local key and independent reader; do not enrol again'};
}
export async function runNativeAction(action,input,{signal}={}){
 signal?.throwIfAborted();
 if(action==='help')return{help:NATIVE_HELP};
 if(action==='activate')return waitForActivation(input);
 if(action==='wallets'){
  const key=await localKey(input.signingKeyFile);
  return provisionReceivingWallets({...input,member:key.member,directory:input.directory??join(dirname(resolve(input.signingKeyFile)),'receiving-wallets',key.member)},{action:runNativeAction});
 }
 if(action==='wallet-status'){
  const saved=await journal(input.journalFile),reader=journalReader(input.reader,saved),key=await localKey(input.signingKeyFile),command=saved.envelope.command;
  if(command.member!==key.member||command.operation!=='external_wallet_bind'||command.payload.network!==input.network)throw Error('local receiving wallet journal differs');
  const record='external_wallet/'+key.member+'/'+input.network,state=await readFederationState({...reader,request:{member:key.member,keys:[record]}});
  if(state.chain_id!==command.chain_id||state.member?.id!==key.member||state.member.licence!=='active')throw Error('receiving wallet recovery context differs');
  // Only finalized expiry plus proved non-inclusion permits a fresh command.
  // Its old public journal and send marker remain retained forever.
  return{expired:BigInt(state.height)>BigInt(command.expires_height)&&state.records?.[record]===null,transaction_hash:saved.transaction_hash};
 }
 if(action==='prepare-wallet'){
  const key=await localKey(input.signingKeyFile),record='external_wallet/'+key.member+'/'+input.network,state=await readFederationState({...input.reader,request:{member:key.member,keys:[record]}});
  if(state.records?.[record]!==null)throw Error('existing external wallet is never replaced automatically');
  const payload=await walletBindingPayload({file:input.walletFile,member:key.member,network:input.network,state,expiresInBlocks:100});
  signal?.throwIfAborted();const envelope=composeFederationCommand({state,operation:'external_wallet_bind',payload,signingKey:key.secret,expiresInBlocks:100}),transaction_hash=sha(Buffer.from(JSON.stringify(envelope))).toUpperCase();
  await save(input.out,{format:'uain-native-command-v1',verifier_sha256:input.reader.executableSha256,genesis_sha256:input.reader.genesisSha256,after_event:state.event_count,transaction_hash,envelope});return{saved:true,transaction_hash,member:key.member,operation:'external_wallet_bind',sequence:envelope.command.sequence,finalized:false};
 }
 if(action==='state'){const state=await readFederationState({...input.reader,request:input.selection??{}});if(input.out)await save(input.out,state);return input.out?{saved:true,chain_id:state.chain_id,height:state.height,event_count:state.event_count}:state}
 if(action==='prepare'){
  const key=await localKey(input.signingKeyFile),request=input.operation==='enrol'?{keys:['member/'+key.member]}:{member:key.member,...(input.instance?{instance:input.instance}:{})},state=await readFederationState({...input.reader,request,signal}),payload=structuredClone(input.payload??{});
  let body;if(input.body){if(input.operation!=='submit')throw Error('evidence document requires submit');const document=researchEvidence(input.body);if(payload.evidence_digest&&payload.evidence_digest!==document.digest)throw Error('supplied research commitment differs');payload.evidence_digest=document.digest;body=document.body}
  signal?.throwIfAborted();const envelope=composeFederationCommand({state,operation:input.operation,payload,signingKey:key.secret,expiresInBlocks:input.expiresInBlocks??100}),transaction_hash=sha(Buffer.from(JSON.stringify(envelope))).toUpperCase();
  await save(input.out,{format:'uain-native-command-v1',verifier_sha256:input.reader.executableSha256,genesis_sha256:input.reader.genesisSha256,after_event:state.event_count,transaction_hash,envelope,...(body?{body}:{})});
  if(input.operation==='enrol'){
   const directory=join(dirname(resolve(input.signingKeyFile)),'receiving-wallets',key.member);
   for(const network of ['ethereum','solana'])await ensureLocalWallet({directory,member:key.member,network});
   // This private local sidecar is not part of the public transaction journal.
   await save(input.out+'.wallets.json',{transaction_hash,member:key.member,signingKeyFile:resolve(input.signingKeyFile),directory});
  }
  return{saved:true,transaction_hash,member:key.member,operation:input.operation,sequence:envelope.command.sequence,finalized:false};
 }
 if(action==='submit'){
  let saved,reader;
  try{
   saved=await journal(input.journalFile);reader=journalReader(input.reader,saved);
   const state=await readFederationState({...reader,request:{},signal});if(state.chain_id!==saved.envelope.command.chain_id)throw Error('journal belongs to another native chain');signal?.throwIfAborted();
  }catch(error){await recordSubmissionNotAttempted(error,input.journalFile);throw error;}
  // This exclusive durable marker precedes the only broadcast attempt. A
  // crash or timeout requires receipt discovery rather than another send.
  try{await save(input.journalFile+'.sent',{transaction_hash:saved.transaction_hash,status:'pending'})}catch(error){if(error.code==='EEXIST')return{transaction_hash:saved.transaction_hash,finalized:false,status:'unknown',receipt_required:true};await recordSubmissionNotAttempted(error,input.journalFile);throw error;}
  if(signal?.aborted){
   // We have not called the RPC transport. Remove only our newly-created
   // marker before issuing the trusted no-handoff evidence.
   await rm(input.journalFile+'.sent');const directory=await open(dirname(resolve(input.journalFile)),'r');try{await directory.sync();}finally{await directory.close();}
   const error=signal.reason instanceof Error?signal.reason:Error('Native submission cancelled before send');await recordSubmissionNotAttempted(error,input.journalFile);throw error;
  }
  try{signal?.throwIfAborted();const result=await post(reader.rpc,{jsonrpc:'2.0',id:'uain-native-client',method:'broadcast_tx_sync',params:{tx:Buffer.from(JSON.stringify(saved.envelope)).toString('base64')}},128*1024,signal);if(result.error||!Number.isInteger(result.result?.code)||result.result.hash?.toUpperCase()!==saved.transaction_hash)throw Error('native broadcast differs');return{transaction_hash:saved.transaction_hash,finalized:false,status:result.result.code===0?'accepted':'refused',code:result.result.code}}catch{return{transaction_hash:saved.transaction_hash,finalized:false,status:'unknown',receipt_required:true};}
 }
 if(action==='receipt'){
  const saved=await journal(input.journalFile),reader=journalReader(input.reader,saved),receipt=await findFederationReceipt({reader,envelope:saved.envelope,afterEvent:input.afterEvent??saved.after_event,maxEvents:input.maxEvents??128,signal});
  if(receipt.finalized&&saved.envelope.command.operation==='enrol'){
   let plan;try{plan=await privateJSON(input.journalFile+'.wallets.json')}catch(error){if(error.code!=='ENOENT')throw error}
   if(plan){
    if(plan.transaction_hash!==saved.transaction_hash||plan.member!==saved.envelope.command.member)throw Error('local receiving wallet enrolment differs');const key=await localKey(plan.signingKeyFile);if(key.member!==plan.member)throw Error('local receiving wallet member differs');
    receipt.activation=await waitForActivation({reader,signingKeyFile:plan.signingKeyFile,waitMs:input.waitMs,pollMs:input.pollMs});
    if(receipt.activation.active)receipt.receiving_wallets=await runNativeAction('wallets',{reader,signingKeyFile:plan.signingKeyFile,directory:plan.directory});
    else{const wallets={};for(const network of ['ethereum','solana']){const local=await ensureLocalWallet({directory:plan.directory,member:plan.member,network});wallets[network]={network,address:local.address,ownership_binding_pending:true}}receipt.receiving_wallets={finalized:false,licence_required:true,wallets}}
   }
  }
  if(input.out)await save(input.out,receipt);return receipt;
 }
 if(action==='publish'){
  const saved=await journal(input.journalFile),reader=journalReader(input.reader,saved);if(!saved.body)throw Error('native research body absent from journal');
  const proof=await readFederationState({...reader,request:{receipt:{envelope:saved.envelope,event_id:input.event_id}},signal});if(!proof.receipt?.finalized)throw Error('native research finality absent');
  const endpoint=publicURL(input.base);if(endpoint.pathname!=='/')throw Error('native publication origin required');
  const result=await post(new URL('/api/native/evidence',endpoint),{body:saved.body,envelope:saved.envelope,event_id:input.event_id},128*1024,signal);if(!result.published||result.epoch!==saved.genesis_sha256||result.id!==saved.envelope.command.payload.id||result.evidence_digest!==saved.envelope.command.payload.evidence_digest)throw Error('native publication acknowledgement differs');return result;
 }
 throw Error('unknown native action');
}
export async function nativeMain(args=process.argv.slice(2)){
 const action=args[0]??'help';if(action==='help'||action==='--help'){console.log(NATIVE_HELP);return}if(args.length!==1)throw Error('native parameters belong in stdin');
 const parts=[];let size=0;for await(const part of process.stdin){size+=part.length;if(size>256*1024)throw Error('bounded native input required');parts.push(part)}
 try{console.log(JSON.stringify(await runNativeAction(action,JSON.parse(Buffer.concat(parts).toString('utf8')))))}catch{throw Error('Native command refused; check local files, independent pins, sequence and finalized receipt.')}
}
