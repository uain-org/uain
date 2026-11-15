/** Explicit native namespace. Every read is verified against pinned genesis;
 * failures never fall back to the PostgreSQL pilot. Members sign locally. */
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export function nativeConfig(env:Record<string,string|undefined> = process.env) {
  const names = ['UAIN_NATIVE_STATE_BINARY','UAIN_NATIVE_STATE_SHA256','UAIN_NATIVE_GENESIS','UAIN_NATIVE_GENESIS_SHA256','UAIN_NATIVE_RPC'];
  if (!names.some(n => env[n])) return null;
  if (names.some(n => !env[n]) || !/^[a-f0-9]{64}$/.test(env.UAIN_NATIVE_STATE_SHA256??'') || !/^[a-f0-9]{64}$/.test(env.UAIN_NATIVE_GENESIS_SHA256??'')) throw Error('complete independent native pins required');
  const rpc = new URL(env.UAIN_NATIVE_RPC!);
  if (rpc.username || rpc.password || rpc.search || rpc.hash || rpc.pathname !== '/' || (rpc.protocol !== 'https:' && (rpc.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(rpc.hostname)))) throw Error('public HTTPS or isolated loopback native RPC required');
  return {binary:resolve(env.UAIN_NATIVE_STATE_BINARY!),binaryHash:env.UAIN_NATIVE_STATE_SHA256!,genesis:resolve(env.UAIN_NATIVE_GENESIS!),genesisHash:env.UAIN_NATIVE_GENESIS_SHA256!,rpc:rpc.origin};
}
/** Pinned verifier and genesis files whose SHA-256 matched, by on-disk identity. */
const verifiedArtifacts=new Map<string,string>();
let activeProofs=0;
const proofQueue:Array<{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;cleanup:()=>void}>=[];
async function proofPermit(signal?:AbortSignal){
 signal?.throwIfAborted();
 if(activeProofs<2){activeProofs++;return releaseProof}
 if(proofQueue.length>=16)throw Error('native proof process capacity exceeded');
 await new Promise<void>((resolve,reject)=>{
  const cancel=(error:Error)=>{const at=proofQueue.indexOf(entry);if(at>=0)proofQueue.splice(at,1);entry.cleanup();reject(error)},abort=()=>cancel(signal!.reason);
  const entry={resolve:()=>{entry.cleanup();resolve()},reject,timer:setTimeout(()=>cancel(Error('native proof process capacity wait expired')),10000),cleanup:()=>{clearTimeout(entry.timer);signal?.removeEventListener('abort',abort)}};
  proofQueue.push(entry);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
 try{signal?.throwIfAborted()}catch(error){releaseProof();throw error}return releaseProof;
}
function releaseProof(){activeProofs--;const next=proofQueue.shift();if(next){clearTimeout(next.timer);activeProofs++;next.resolve()}}
/** The proof reader's last stderr line, safe for a log: one line, control characters removed,
 * anything shaped like a credential (URL user info, key/token/secret/password values, the rest
 * of a line after "authorization" or "bearer", PEM blocks) replaced, and at most 300 characters. The reader is given public state keys,
 * pinned public files and a credential-free RPC origin, so this is a second guard, not the first. */
export function proofReaderReason(stderr:unknown){
 if(typeof stderr!=='string')return'';
 const line=stderr.slice(-2048).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,'').split(/[\r\n]+/).map(l=>l.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,' ').replace(/ {2,}/g,' ').trim()).filter(Boolean).pop()??'';
 const safe=line.replace(/-----BEGIN[^-]*-----.*$/i,'[redacted]').replace(/(\/\/)[^\/\s@]+@/g,'$1[redacted]@').replace(/\b(authorization|bearer)\b.*$/i,'$1 [redacted]').replace(/\b(password|passwd|secret|token|api[-_]?key|private[-_ ]?key|seed|mnemonic)\b(\s*[:=]?\s*)("[^"]*"|\S+)/gi,'$1$2[redacted]');
 return safe.length>300?safe.slice(0,299)+'…':safe;
}
/** At most 12 refusal lines a minute per replica; the next line says how many were left out. */
let refusalWindow=0,refusalLines=0,refusalsLeftOut=0;
function logProofRefusal(cause:string,selection:any,ms:number,stderr:string,now=Date.now()){
 if(now-refusalWindow>=60000){refusalWindow=now;refusalLines=0}
 if(refusalLines>=12){refusalsLeftOut++;return}
 refusalLines++;const left=refusalsLeftOut;refusalsLeftOut=0;
 const shape=selection?.receipt?'receipt':Array.isArray(selection?.keys)?selection.keys.length+' keys':selection?.member||selection?.instance?'member state':'no keys';
 console.error('Native proof reader refused ('+cause+', '+shape+', '+ms+' ms, '+activeProofs+' running, '+proofQueue.length+' waiting): '+(proofReaderReason(stderr)||'no reason given')+(left?' ['+left+' earlier refusal(s) not logged]':''));
}
export async function nativeState(selection:any,config:NonNullable<ReturnType<typeof nativeConfig>>,{signal}:{signal?:AbortSignal}={}){const release=await proofPermit(signal);try{return await nativeStateWork(selection,config,signal)}finally{release()}}
async function nativeStateWork(selection:any, config:NonNullable<ReturnType<typeof nativeConfig>>,signal?:AbortSignal) {
  signal?.throwIfAborted();
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(k => !['member','instance','keys','receipt'].includes(k))) throw Error('bounded public native selection required');
  const input = JSON.stringify(selection);
  if (Buffer.byteLength(input)>65536) throw Error('native selection exceeds bound');
  for (const [file,expected,max] of [[config.binary,config.binaryHash,256*1024*1024],[config.genesis,config.genesisHash,8*1024*1024]] as const) {
    const info = await stat(file);
    if (!info.isFile() || info.size>max) throw Error('native artifact differs from independent pin');
    // Hashing the 40 MB verifier on every proof cost about 165 ms of CPU per read (most of a
    // replica's warm-up). A file is re-hashed whenever its pin or on-disk identity changes:
    // any write moves ctime, and a replacement moves the inode.
    const identity=JSON.stringify([expected,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);
    if (verifiedArtifacts.get(file)!==identity) {
      verifiedArtifacts.delete(file);
      if (createHash('sha256').update(await readFile(file,{signal})).digest('hex')!==expected) throw Error('native artifact differs from independent pin');
      if (verifiedArtifacts.size>=16) verifiedArtifacts.clear();
      verifiedArtifacts.set(file,identity);
    }
  }
  const dir=await mkdtemp(join(tmpdir(),'uain-native-gateway-'));await chmod(dir,0o700);
  try {
    const output=join(dir,'state.json');
    await new Promise<void>((yes,no)=>{
      signal?.throwIfAborted();
      const child=spawn(config.binary,['--genesis',config.genesis,'--genesis-sha256',config.genesisHash,'--rpc',config.rpc,'--out',output,'--max-age','120s'],{stdio:['pipe','ignore','pipe'],signal,killSignal:'SIGKILL'});
      let error='',expired=false;const started=Date.now(),timer=setTimeout(()=>{expired=true;child.kill('SIGKILL')},65000);
      child.stderr.on('data',b=>error=(error+b).slice(-2048));
      // The caller still sees only the generic refusal; the reader's own last line goes to this
      // replica's log, so an intermittent refusal under load can be explained afterwards.
      const refused=(cause:string)=>{if(!signal?.aborted)logProofRefusal(cause,selection,Date.now()-started,error)};
      child.once('error',e=>{clearTimeout(timer);refused('could not start ('+String((e as any)?.code??e?.name??'error')+')');no(e)});
      child.once('close',(code,killed)=>{clearTimeout(timer);if(code===0)return yes();refused(expired?'stopped after 65 s':killed?'ended by '+killed:'exit '+code);no(Error('native proof verification refused'))});
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });
    const info=await stat(output);if (!info.isFile()||info.size>8*1024*1024||(info.mode&0o077)) throw Error('invalid native proof output');
    signal?.throwIfAborted();return JSON.parse(await readFile(output,{encoding:'utf8',signal}));
  } finally {await rm(dir,{recursive:true,force:true})}
}
/** A refusal caused by the caller's own request. Its message is safe to show
 * the member, unlike proof or RPC failures, which stay generic. */
export class NativeRequestError extends Error {}
/** The chain's CheckTx log, bounded and stripped of control characters: the
 * public reason a full node gives for refusing a command. */
export function chainRefusalReason(log:unknown){
  if(typeof log!=='string')return null;
  const clean=log.replace(/[\u0000-\u001f\u007f]+/g,' ').trim();
  return clean?clean.slice(0,500):null;
}
export function assertNativeEnvelope(envelope:any) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',')!=='command,public_key,signature' || !envelope.command || typeof envelope.command!=='object' || Array.isArray(envelope.command) || typeof envelope.public_key!=='string' || typeof envelope.signature!=='string') throw new NativeRequestError('locally signed native envelope required: exactly command, public_key and signature, and never a private key');
  const bytes=Buffer.from(JSON.stringify(envelope));if(bytes.length>65536)throw new NativeRequestError('native envelope exceeds the 65,536-byte bound');
  return bytes;
}
/** The public relay (`uain_native_submit`, `POST /api/native/command`) is closed
 * unless the operator lists the operations it may carry. Members never need it:
 * the no-install path is BAINK's `baink_member_request`, the kit signs through
 * BAINK. Callers in this process (tests, reset tooling) use nativeSubmit directly. */
export class NativeSubmitRefused extends Error {
  constructor(public code:string, message:string, public status:number, public retryAfter?:number) { super(message); }
}
const OPERATION=/^[a-z][a-z0-9_]{0,63}$/;
export function nativeSubmitPolicy(env:Record<string,string|undefined> = process.env) {
  const listed=(env.UAIN_NATIVE_SUBMIT_OPERATIONS??'').split(',').map(s=>s.trim()).filter(Boolean);
  const operations=new Set(listed.filter(s=>OPERATION.test(s)));
  const n=(v:string|undefined,d:number)=>{const x=Number(v);return Number.isInteger(x)&&x>0&&x<=10000?x:d};
  return {operations,perKeyPerMinute:n(env.UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE,6),perMinute:n(env.UAIN_NATIVE_SUBMIT_PER_MINUTE,60)};
}
/** The operations the public JSON-RPC origin (`POST /` on uain.global, `/api/native/rpc`)
 * carries by default: exactly what BAINK broadcasts there with every feature it runs in
 * production (`BAINK_NATIVE_RPC=https://uain.global`, checked 15 November 2026): enrolment and
 * instance creation (native-asset.mjs), native earning (native-financial-transport.mjs), central
 * earning (central-earning-transport.mjs MEMBER_OPERATIONS) and no-install send (coin_shield,
 * server-send-builder.mjs). BAINK's research pilot (open_project, open_task, submit, verify) is
 * off in production and left out: list it in UAIN_NATIVE_PUBLIC_RPC_OPERATIONS before enabling
 * it. native-rpc-public-policy.test.mjs checks this list against those BAINK files. */
export const NATIVE_PUBLIC_RPC_OPERATIONS=Object.freeze(['enrol','instance_create','coin_quote','coin_reserve','coin_claim','project_join','central_submit','central_reassess','central_evidence_expire','coin_shield']);
/** The relay's policy for the public JSON-RPC origin's broadcasts (audit F-1, 15 November 2026):
 * the same parsing, rate settings and rate windows, so one key's budget covers both doors.
 * Only the list differs: UAIN_NATIVE_PUBLIC_RPC_OPERATIONS replaces the default, and a blank
 * value closes public broadcasting. */
export function nativePublicRpcPolicy(env:Record<string,string|undefined> = process.env) {
  return nativeSubmitPolicy({UAIN_NATIVE_SUBMIT_OPERATIONS:env.UAIN_NATIVE_PUBLIC_RPC_OPERATIONS??NATIVE_PUBLIC_RPC_OPERATIONS.join(','),
    UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE:env.UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE,UAIN_NATIVE_SUBMIT_PER_MINUTE:env.UAIN_NATIVE_SUBMIT_PER_MINUTE});
}
const WINDOW_MS=60000,MAX_TRACKED_KEYS=10000;
const submitWindows=new Map<string,number[]>();let globalWindow:number[]=[];
export function resetNativeSubmitWindows(){submitWindows.clear();globalWindow=[]}
export function admitNativeSubmit(envelope:any, policy:ReturnType<typeof nativeSubmitPolicy>, now=Date.now()) {
  assertNativeEnvelope(envelope);
  if(!policy.operations.size)throw new NativeSubmitRefused('native_submit_disabled','This relay is closed. Members never need it: join and submit with baink_member_request on baink.money/mcp (nothing installed) or the kit. Nothing was sent.',403);
  const operation=envelope.command.operation;
  if(typeof operation!=='string'||!policy.operations.has(operation))throw new NativeSubmitRefused('native_operation_not_allowed','This relay does not carry that operation. Nothing was sent.',403);
  const cutoff=now-WINDOW_MS;globalWindow=globalWindow.filter(t=>t>cutoff);
  const key=envelope.public_key,mine=(submitWindows.get(key)??[]).filter(t=>t>cutoff);
  const wait=(list:number[])=>Math.max(1,Math.ceil((list[0]+WINDOW_MS-now)/1000));
  if(mine.length>=policy.perKeyPerMinute)throw new NativeSubmitRefused('rate_limited','Too many signed steps from this key. Nothing was sent.',429,wait(mine));
  if(globalWindow.length>=policy.perMinute)throw new NativeSubmitRefused('rate_limited','The relay is at capacity. Nothing was sent.',429,wait(globalWindow));
  if(!submitWindows.has(key)&&submitWindows.size>=MAX_TRACKED_KEYS){for(const[k,v]of submitWindows)if(!v.some(t=>t>cutoff))submitWindows.delete(k);if(submitWindows.size>=MAX_TRACKED_KEYS)throw new NativeSubmitRefused('rate_limited','The relay is at capacity. Nothing was sent.',429,60)}
  mine.push(now);submitWindows.set(key,mine);globalWindow.push(now);
}
export async function nativeSubmit(envelope:any, config:NonNullable<ReturnType<typeof nativeConfig>>, transport = fetch) {
  const bytes=assertNativeEnvelope(envelope);
  const response=await transport(config.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'uain-native-submit',method:'broadcast_tx_sync',params:{tx:bytes.toString('base64')}}),signal:AbortSignal.timeout(10000)});
  if (!response.ok)throw Error('native RPC unavailable');
  const text=await response.text();if(Buffer.byteLength(text)>65536)throw Error('native RPC response exceeds bound');
  const answer=JSON.parse(text);if(answer.error||!answer.result||!Number.isInteger(answer.result.code)||typeof answer.result.hash!=='string'||!/^[a-fA-F0-9]{64}$/.test(answer.result.hash))throw Error('invalid native RPC submission result');
  // CheckTx acceptance is not finality. Caller must independently retrieve a
  // committed transaction/proven state before reporting success to the member.
  const accepted=answer.result.code===0;
  // A refused command was never applied, so its reason is the chain's own
  // CheckTx log. Returning it lets the member fix the step instead of guessing.
  return {authority:'native',finalized:false,accepted,code:answer.result.code,transaction_hash:answer.result.hash,
    ...(accepted?{}:{reason:chainRefusalReason(answer.result.log)??'The chain refused this command without a stated reason (code '+answer.result.code+').',
      next:'Nothing was applied. Fix what the reason names, then compose and sign a new step locally; do not resend this envelope.'})};
}
export async function handleNative(req:any,res:any,url:URL,send:any,audit:any,readBody:any,env=process.env) {
  if(!['/api/native/state','/api/native/command','/api/native/receipt'].includes(url.pathname))return false;
  if(req.method!=='POST'){send(res,405,{error:'method_not_allowed'});return true}
  let config;try{config=nativeConfig(env)}catch{send(res,503,{error:'native_configuration_invalid'});return true}
  if(!config){send(res,503,{error:'native_authority_not_configured'});return true}
  const body=await readBody(req,res,audit);if(!body)return true;
  try{if(url.pathname.endsWith('/command'))admitNativeSubmit(body,nativeSubmitPolicy(env));const result=url.pathname.endsWith('/command')?await nativeSubmit(body,config):await nativeState(url.pathname.endsWith('/receipt')?{receipt:body}:body,config);audit(200,'native');send(res,200,result)}catch(error){if(error instanceof NativeSubmitRefused){audit(error.status,'native submit refused: '+error.code);if(error.retryAfter)res?.setHeader?.('retry-after',String(error.retryAfter));send(res,error.status,{error:error.code,message:error.message,...(error.retryAfter?{retryAfter:error.retryAfter}:{})});return true}if(error instanceof NativeRequestError){audit(400,'native request refused');send(res,400,{error:'native_request_invalid',message:error.message});return true}audit(503,'native proof/RPC refused');send(res,503,{error:'native_authority_unavailable'})}
  return true;
}
