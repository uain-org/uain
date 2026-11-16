import {types} from 'node:util';
import {centralReadBatchCategory} from './central-read-batch.mjs';
import {NativeReaderError} from './native-asset.mjs';
import {centralUnlockedUnits} from './central-budget.mjs';
import { hasPendingNativeSend } from './native-sequence-fence.mjs';
import { estimateTaskDifficulty } from './task-difficulty.mjs';
import { validateReviewFeedback } from '../shared/central-review-feedback.mjs';
import { evidenceActivation, evidenceJourney } from './central-evidence.mjs';
import { centralTaskClaim, centralMemberClaim, centralTaskStatus } from './central-claim.mjs';
import { deriveContribution } from '../shared/contribution-view.mjs';
/** Prospective public central earning adapter. Native proofs alone establish
 * task obligations, receipts and income. Prepared/submitted work is never pay. */
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJSON} from './native-financial-command.mjs';
import {CENTRAL_POLICY,CENTRAL_PROJECT_UNITS,CENTRAL_LIFETIME_UNITS,centralPayload,centralEarningSigningBytes,verifyCentralEnvelope} from './central-earning-command.mjs';
const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,ADDRESS=/^uain1[a-f0-9]{40}$/,UINT=/^(0|[1-9][0-9]{0,19})$/;
const MAX=18446744073709551615n,CAP=108000000000000000000n,PROJECT=CENTRAL_PROJECT_UNITS;
const sha=x=>createHash('sha256').update(x).digest('hex'),obj=x=>x&&typeof x==='object'&&!Array.isArray(x),num=x=>typeof x==='string'&&UINT.test(x)&&BigInt(x)<=MAX,amount=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,20})$/.test(x)&&BigInt(x)<=CAP;
const centralErrors=new WeakSet(),proofCategories=new WeakMap(),reportedProofs=new WeakSet();
export class CentralEarningError extends Error{constructor(status,code){super(code);centralErrors.add(this);this.status=status;this.code=code;}}
const check=(ok,status=503,code='central_proof_unavailable')=>{if(!ok)throw new CentralEarningError(status,code);};
const exact=(x,keys)=>obj(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const released=i=>i.status==='expired-unused'||i.status==='expired';
const MEMBER_OPS=['central_submit','project_join','central_reassess','central_evidence_expire'],publicOp=op=>MEMBER_OPS.includes(op);
const EVIDENCE_OPS=['central_reassess','central_evidence_expire'];
const index=n=>String(n).padStart(20,'0');
/** Diagnostic metadata is internal and cannot supply or replace a proof. */
// Every refusal keeps its category (10 November 2026), so the HTTP layer can log why a
// submit or task read was refused, not only the traced status read.
function proofCheck(ok,category,trace){if(ok)return;const error=new CentralEarningError(503,'central_proof_unavailable');proofCategories.set(error,category);throw error;}
function proofCall(category,trace,call){try{return call();}catch(error){if(centralErrors.has(error)&&!proofCategories.has(error))proofCategories.set(error,category);throw error;}}
function proofObservation(trace,proof,state){
 if(!trace)return;
 const current={};if(num(proof?.height))current.height=proof.height;if(num(state?.event_count))current.eventCount=state.event_count;if(num(state?.member?.sequence))current.sequence=state.member.sequence;if(HASH.test(proof?.appHash??''))current.appHash=proof.appHash;trace.current=current;
}
function readerCategory(error){
 const batch=centralReadBatchCategory(error);if(batch)return 'batch_'+batch;
 if(error&&typeof error==='object'&&!types.isProxy(error)&&Object.getPrototypeOf(error)===NativeReaderError.prototype&&Object.getOwnPropertyDescriptor(error,'category')?.value==='rpc_connection_refused')return 'reader_connection_refused';
 return 'reader_refused';
}
function proofEvent(error,trace){
 const coherence={},head=trace.head??{},current=trace.current??{};
 for(const [field,suffix]of[['height','Height'],['eventCount','EventCount'],['sequence','Sequence']]){if(head[field]!==undefined)coherence['head'+suffix]=head[field];if(current[field]!==undefined)coherence['current'+suffix]=current[field];}
 for(const [field,key]of[['appHash','sameAppHash'],['eventCount','sameEventCount'],['sequence','sameSequence']])if(head[field]!==undefined&&current[field]!==undefined)coherence[key]=head[field]===current[field];
 return Object.freeze({schema:'uain-central-proof-refusal-v1',operation:'status',phase:trace.phase,category:proofCategories.get(error)??'proof_unclassified',coherence:Object.freeze(coherence)});
}
function reportProof(sink,error,trace){
 if(typeof sink!=='function'||!centralErrors.has(error)||Object.getOwnPropertyDescriptor(error,'status')?.value!==503||Object.getOwnPropertyDescriptor(error,'code')?.value!=='central_proof_unavailable')return;
 const event=proofEvent(error,trace);reportedProofs.add(error);try{Promise.resolve(sink(event)).catch(()=>{});}catch{}
}
/** Refusals where the chain or its proof reader could not answer (a paused node, a slow or busy reader), as opposed to a proof that answered but did not check out. */
const CHAIN_UNAVAILABLE=new Set(['reader_refused','reader_connection_refused','deadline','proof_stale','batch_deadline','batch_closed','batch_capacity']);
/** The category of a central_proof_unavailable refusal (never a proof value), whether the chain was unavailable, and whether it was already reported. */
export function centralProofRefusal(error){
 if(!centralErrors.has(error)||Object.getOwnPropertyDescriptor(error,'status')?.value!==503||Object.getOwnPropertyDescriptor(error,'code')?.value!=='central_proof_unavailable')return null;
 const category=proofCategories.get(error)??'proof_unclassified';
 return Object.freeze({category,chainUnavailable:CHAIN_UNAVAILABLE.has(category),reported:reportedProofs.has(error)});
}
export function createCentralEarningService({store,native,enabled=false,taskRequirements=null,taskAvailability=null,feedbackReader=null,onProofRefusal=null,monotonicNow=()=>performance.now()}){
 const canSend=()=>enabled===true&&native.configured===true&&typeof native.broadcastCentral==='function';
 function holder(user){const raw=typeof user?.publicKey==='string'?Buffer.from(user.publicKey,'base64'):Buffer.alloc(0);check(raw.length===32&&raw.toString('base64')===user.publicKey&&user.address==='uain1'+sha(raw).slice(0,40),401,'invalid_native_holder');return raw.toString('base64url');}
 function fresh(p,{historical=false,trace}={}){
  const age=Date.now()-Date.parse(p?.headerTime);
  proofCheck(native.configured===true&&HASH.test(native.pins?.epoch??'')&&HASH.test(native.pins?.verifierSha256??'')&&p?.authority==='native'&&p.chainId===native.pins.chainId&&p.epoch===native.pins.epoch&&p.genesisSha256===native.pins.epoch&&p.verifierSha256===native.pins.verifierSha256,'proof_identity',trace);
  proofCheck(num(p.height)&&BigInt(p.height)>0n&&HASH.test(p.appHash??'')&&Number.isInteger(p.maxAgeSeconds)&&p.maxAgeSeconds>=1&&p.maxAgeSeconds<=120&&Number.isFinite(age),'proof_structure',trace);
  proofCheck(age>=-60000,'proof_future',trace);proofCheck(historical||age<=p.maxAgeSeconds*1000,'proof_stale',trace);
 }
 async function context(user,keys=[],batched=false,trace,{absentMember=false}={}){
  const pub=holder(user),useBatch=batched&&typeof native.centralPublicState==='function',deadline=Date.now()+(useBatch?25000:(native.timeoutMs??8000)),readState=useBatch?native.centralPublicState.bind(native):native.publicState.bind(native);let head,latest;const records={};
  async function add(wanted){
   const missing=[...new Set(wanted)].filter(k=>!Object.hasOwn(records,k));
   for(let at=0;at<missing.length||!head;at+=32){
    const selected=missing.slice(at,at+32);proofCheck(Date.now()<deadline,'deadline',trace);let c;
    try{c=await readState({member:user.address,keys:selected},{timeoutMs:Math.max(1,deadline-Date.now())});}catch(error){proofCheck(false,readerCategory(error),trace);}
    const s=c?.state;proofObservation(trace,c?.proof,s);fresh(c?.proof,{trace});
    proofCheck(obj(s)&&s.chain_id===c.proof.chainId&&s.height===c.proof.height&&s.app_hash===c.proof.appHash&&num(s.event_count)&&obj(s.records),'state_proof_binding',trace);
    proofCheck(selected.every(k=>Object.hasOwn(s.records,k)),'record_missing',trace);
    const m=s.member;
    // A holder that never enrolled has no member record; only a read that asks for it may prove that absence.
    if(absentMember&&m==null&&!head){proofCheck(Object.hasOwn(s.records,'member/'+user.address)&&s.records['member/'+user.address]===null,'member_binding',trace);head=c;latest=c;Object.assign(records,s.records);continue;}
    // Later batches of a proved-absent holder stay absent and under the same root.
    if(absentMember&&m==null&&head?.state.member==null){proofCheck(c.proof.appHash===head.proof.appHash&&BigInt(c.proof.height)>=BigInt(latest.proof.height)&&s.event_count===head.state.event_count,'state_coherence',trace);latest=c;Object.assign(records,s.records);continue;}
    proofCheck(m?.id===user.address&&m.public_key===pub&&num(m.sequence)&&BigInt(m.sequence)<MAX,'member_binding',trace);
    if(head)proofCheck(c.proof.appHash===head.proof.appHash&&BigInt(c.proof.height)>=BigInt(latest.proof.height)&&s.event_count===head.state.event_count&&m.sequence===head.state.member.sequence,'state_coherence',trace);
    else{head=c;if(trace)trace.head={...trace.current};}
    latest=c;Object.assign(records,s.records);
   }
  }
  await add(keys);
  if(Object.hasOwn(records,'central_earning_activation')&&records.central_earning_activation!==null){const a=records.central_earning_activation;proofCheck(obj(a)&&ADDRESS.test(a.reviewer),'activation_record',trace);if(trace)trace.phase='reviewer';await add(['member/'+a.reviewer]);}
  return{get proof(){return latest.proof},get state(){return{...latest.state,records}},records,member:head.state.member,publicKey:pub,add,deadline};
 }
 function active(c,trace){const a=c.records.central_earning_activation;if(a===null)return null;proofCheck(obj(a)&&a.policy===CENTRAL_POLICY&&ADDRESS.test(a.reviewer)&&num(a.height)&&HASH.test(a.evidence_digest??''),'activation_record',trace);const reviewer=c.records['member/'+a.reviewer];proofCheck(reviewer?.id===a.reviewer&&['active','pending','revoked','withdrawn'].includes(reviewer.licence),'reviewer_record',trace);return BigInt(a.height)<=BigInt(c.proof.height)&&reviewer.licence==='active'?a:null;}
 function licensed(c){check(c.member.licence==='active',409,'central_licence_inactive');}
 function taskRecord(t,id){check(obj(t)&&t.id===id&&ID.test(t.project)&&typeof t.criteria==='string'&&Buffer.byteLength(t.criteria)<=4096&&sha(t.criteria)===t.acceptance_digest&&typeof t.title==='string'&&['hard','new','unresolved'].includes(t.eligibility)&&HASH.test(t.eligibility_digest??'')&&HASH.test(t.evidence_digest??'')&&amount(t.solver_amount)&&BigInt(t.solver_amount)>0n&&amount(t.reviewer_amount)&&BigInt(t.reviewer_amount)>0n&&BigInt(t.solver_amount)+BigInt(t.reviewer_amount)<=CENTRAL_LIFETIME_UNITS&&amount(t.reserved)&&amount(t.paid)&&['open','open_unfunded','under_review','accepted','contest_open','conditional_approved','conditional_expired','no_winner'].includes(t.state)&&typeof t.pending==='string'&&typeof t.winner==='string');return t;}
 function budgetRecord(b,project,proofHeight){check(obj(b)&&b.project===project&&b.policy===CENTRAL_POLICY&&b.allocation===centralUnlockedUnits(b.round)&&b.lifetime_ceiling===String(CENTRAL_LIFETIME_UNITS)&&centralUnlockedUnits(b.round)!==null&&num(b.height)&&BigInt(b.height)>0n&&BigInt(b.height)<=BigInt(proofHeight)&&HASH.test(b.evidence_digest??'')&&ADDRESS.test(b.manager)&&amount(b.reserved)&&amount(b.paid)&&BigInt(b.reserved)+BigInt(b.paid)<=BigInt(b.allocation));return{...b,available:String(BigInt(b.allocation)-BigInt(b.reserved)-BigInt(b.paid))};}
 async function selectedTask(c,user,id){check(typeof id==='string'&&ID.test(id),400,'invalid_central_task');await c.add(['central_task/'+id]);const raw=c.records['central_task/'+id];check(raw!==null,404,'central_task_missing');const t=taskRecord(raw,id);await c.add(['project/'+t.project,'central_project_budget/'+t.project,'participation/'+t.project+'/'+user.address+'/']);const p=c.records['project/'+t.project],b=budgetRecord(c.records['central_project_budget/'+t.project],t.project,c.proof.height);check(BigInt(b.height)<=BigInt(c.proof.height)&&BigInt(t.solver_amount)+BigInt(t.reviewer_amount)<=BigInt(b.allocation));check(p?.id===t.project&&ADDRESS.test(p.lead)&&typeof p.safety_halted==='boolean');const membership=c.records['participation/'+t.project+'/'+user.address+'/'];if(membership!==null)check(membership?.project===t.project&&membership.member===user.address&&!membership.instance);return{task:t,project:p,budget:b,joined:membership!==null};}
 function eligible(c,selection,user){licensed(c);const a=active(c);check(a,409,'central_inactive');const {task:t,project:p,joined}=selection;check(p.state==='active'&&!p.safety_halted,409,'central_project_inactive');check(joined,409,'central_project_join_required');check(user.address!==a.reviewer,409,'central_self_review_forbidden');check(t.state==='open'&&!t.pending&&!t.winner,409,'central_task_not_open');check(BigInt(t.reserved)===BigInt(t.solver_amount)+BigInt(t.reviewer_amount),409,'central_task_not_funded');}
 function earningsRecord(raw,member){if(raw===null)return{member,solver:'0',reviewer:'0',total:'0',awards:'0'};check(obj(raw)&&raw.member===member&&amount(raw.solver)&&amount(raw.reviewer)&&amount(raw.total)&&num(raw.awards)&&BigInt(raw.total)===BigInt(raw.solver)+BigInt(raw.reviewer));return raw;}
 function awardRecord(a,member,role,submission){check(obj(a)&&a.member===member&&a.role===role&&a.submission===submission&&ID.test(a.task)&&ID.test(a.project)&&amount(a.amount)&&BigInt(a.amount)>0n&&num(a.height)&&BigInt(a.height)>0n);return a;}
 function view(i){const out=structuredClone(i);out.finalized=i.status==='finalized';out.receiptRequired=Boolean(i.sendAttemptedAt)&&!out.finalized&&i.status!=='expired-unused';out.paid=false;if(out.result)out.result.paid=false;if(out.status==='broadcasting')out.status='unknown';if(out.finalized){try{verifiedEnvelope(i,i.envelope);check(sha(JSON.stringify(i.envelope)).toUpperCase()===i.transactionHash);const r=i.receipt;fresh(r?.proof,{historical:true});receiptShape(i,r);out.historicalReceipt=true;}catch{out.finalized=false;out.status='proof_unavailable';out.historicalReceipt=false;}}return out;}
 function owned(user,id){holder(user);const i=store.read().centralEarningIntents?.[id];check(i?.member===user.address,404,'central_intent_missing');return i;}
 function verifiedEnvelope(i,e){try{verifyCentralEnvelope(e,{chainId:native.pins.chainId,operations:MEMBER_OPS});check(e.public_key===i.publicKey&&e.command.member===i.member&&canonicalJSON(e.command)===canonicalJSON(i.command)&&centralEarningSigningBytes(e.command).toString('base64')===i.signingBytesBase64&&sha(centralEarningSigningBytes(e.command))===i.commandDigest,400,'central_envelope_mismatch');}catch(error){if(error instanceof CentralEarningError)throw error;check(false,400,'central_envelope_mismatch');}return e;}
 function receiptShape(i,r){const e=r?.event,subject=i.command.operation==='central_submit'?i.command.payload.id:EVIDENCE_OPS.includes(i.command.operation)?i.command.payload.submission:i.command.payload.project;check(r?.authority==='native'&&r.finalized===true&&r.chain_id===i.command.chain_id&&num(r.state_height)&&r.proof?.height===r.state_height&&r.proof?.appHash===r.app_hash&&e?.member===i.member&&e.operation===i.command.operation&&e.subject===subject&&e.command_digest===i.commandDigest&&!e.instance&&!e.origin&&num(e.id)&&BigInt(e.id)>0n&&num(e.height)&&BigInt(e.height)>0n&&BigInt(e.height)<=BigInt(r.state_height));}
 // Public task pages contain no holder-specific authority. Only overlapping
 // loads are shared; each caller still validates its authenticated public key.
 const taskPagePins=Object.freeze({...native.pins}),taskPageFlights=new Map(),taskPageCache=new Map();let taskPageWaiters=0,taskPageBytes=0;const taskPageTimeout=native.timeoutMs;
 const publicTaskFields=['id','project','title','criteria','acceptance_digest','eligibility','eligibility_digest','solver_amount','reviewer_amount','evidence_digest','state','pending','winner','reserved','paid'];
/** central-task-states-v1 fields, shown only when the task record carries them. */
const taskStateFields=['mode','payout','closes_at','select_by','max_entries','entries','condition','resolves_by','expires_at'];
 // Advisory difficulty (task-difficulty.mjs): additive, outside the native terms and signing bytes.
 const difficultyOf=task=>estimateTaskDifficulty(task,{requirements:taskRequirements?.forTask(task)??null});
 const operatorHold=task=>taskAvailability?.forTask(task)??null;
 const withAvailability=task=>{const availability=operatorHold(task);return availability?{...task,availability}:task;};
 const publicProofFields=['authority','chainId','height','appHash','headerTime','maxAgeSeconds','epoch','genesisSha256','verifierSha256'];
 function taskPageProof(p){fresh(p);check(native.timeoutMs===taskPageTimeout);check(['chainId','epoch','verifierSha256'].every(k=>native.pins?.[k]===taskPagePins[k]&&p?.[k]===taskPagePins[k]));}
 function dropTaskPage(key){const entry=taskPageCache.get(key);if(entry){taskPageBytes-=entry.bytes;taskPageCache.delete(key);}}
 function pruneTaskPages(){const now=monotonicNow();for(const[key,entry]of taskPageCache)if(now>=entry.until)dropTaskPage(key);}
 function cachedTaskPage(key){pruneTaskPages();const entry=taskPageCache.get(key);if(!entry)return null;try{taskPageProof(entry.value.proof);check(entry.reader===native.publicState);return structuredClone(entry.value);}catch(error){taskPageCache.clear();taskPageBytes=0;throw error;}}
 function retainTaskPage(key,value){pruneTaskPages();taskPageProof(value.proof);const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>2*1024*1024)return;dropTaskPage(key);while(taskPageCache.size>=16||taskPageBytes+bytes>2*1024*1024)dropTaskPage(taskPageCache.keys().next().value);taskPageCache.set(key,{value:structuredClone(value),bytes,until:monotonicNow()+5000,reader:native.publicState});taskPageBytes+=bytes;}
 async function publicTaskContext(keys,signal){
  const deadline=Date.now()+25000,records={};let head,latest;
  const live=()=>signal.throwIfAborted();
  async function add(wanted){const missing=[...new Set(wanted)].filter(k=>!Object.hasOwn(records,k));for(let at=0;at<missing.length||!head;at+=32){live();proofCheck(Date.now()<deadline,'deadline');const selected=missing.slice(at,at+32);let c;try{c=await native.publicState({keys:selected},{timeoutMs:Math.max(1,Math.min(8000,native.timeoutMs??8000,deadline-Date.now()))});}catch(error){live();proofCheck(false,readerCategory(error));}live();taskPageProof(c?.proof);const state=c?.state;check(obj(state)&&state.chain_id===c.proof.chainId&&state.height===c.proof.height&&state.app_hash===c.proof.appHash&&num(state.event_count)&&obj(state.records)&&selected.every(k=>Object.hasOwn(state.records,k)));if(head)check(c.proof.appHash===head.proof.appHash&&BigInt(c.proof.height)>=BigInt(latest.proof.height)&&state.event_count===head.state.event_count);else head=c;latest=c;for(const key of selected)records[key]=structuredClone(state.records[key]);}}
  await add(keys);
  return{get proof(){return latest.proof},records,add};
 }
 async function loadPublicTaskPage(cursor,limit,signal){
  const c=await publicTaskContext(['central_task_count'],signal),raw=c.records.central_task_count,count=raw===null?'0':raw;check(num(count));check(BigInt(cursor)<=BigInt(count),400,'invalid_central_cursor');const end=BigInt(cursor)+BigInt(limit)<BigInt(count)?BigInt(cursor)+BigInt(limit):BigInt(count),keys=[];
  for(let n=BigInt(cursor)+1n;n<=end;n++)keys.push('central_task_index/'+index(n));await c.add(keys);const refs=keys.map(k=>{const ref=c.records[k];check(obj(ref)&&ID.test(ref.id)&&ID.test(ref.project));return ref;});check(new Set(refs.map(r=>r.id)).size===refs.length);await c.add(refs.map(r=>'central_task/'+r.id));
  const tasks=refs.map(ref=>{const task=taskRecord(c.records['central_task/'+ref.id],ref.id);check(task.project===ref.project);return{...withAvailability(Object.fromEntries([...publicTaskFields,...taskStateFields.filter(k=>Object.hasOwn(task,k))].map(k=>[k,structuredClone(task[k])]))),difficulty:difficultyOf(task),...centralTaskClaim(task,operatorHold(task)),status_label:centralTaskStatus(task).status_label};});signal.throwIfAborted();taskPageProof(c.proof);
  return{authority:'native',verified:true,tasks,cursor,nextCursor:String(end),more:end<BigInt(count),total:count,limit,proof:Object.fromEntries(publicProofFields.map(k=>[k,c.proof[k]]))};
 }
 // Open-first listing (10 November 2026): newest-first order and an open-only
 // filter, so open tasks in unread middle pages are never hidden. Position p
 // counts from the oldest (order=index) or the newest (order=newest) task. An
 // open-only page scans at most TASK_SCAN positions and returns up to `limit`
 // open tasks; nextCursor is the next unscanned position. Tasks added while a
 // client pages newest-first shift positions up, so a task can repeat but is
 // never skipped.
 const TASK_SCAN=48;
 // Open for work = the shared claimable answer (central-claim.mjs): open, funded, nothing pending, no winner, not on hold.
 const openForWork=task=>task.state==='open'&&task.pending===''&&task.winner===''&&centralTaskClaim(task,operatorHold(task)).claimable===true;
 async function loadPublicTaskScan(cursor,limit,order,state,signal){
  const c=await publicTaskContext(['central_task_count'],signal),raw=c.records.central_task_count,count=raw===null?'0':raw;check(num(count));const total=BigInt(count),from=BigInt(cursor);check(from<=total,400,'invalid_central_cursor');
  const budget=BigInt(state==='open'?TASK_SCAN:limit),end=from+budget<total?from+budget:total,positions=[];for(let p=from;p<end;p++)positions.push(p);
  const keys=positions.map(p=>'central_task_index/'+index(order==='newest'?total-p:p+1n));await c.add(keys);const refs=keys.map(k=>{const ref=c.records[k];check(obj(ref)&&ID.test(ref.id)&&ID.test(ref.project));return ref;});check(new Set(refs.map(r=>r.id)).size===refs.length);await c.add(refs.map(r=>'central_task/'+r.id));
  const tasks=[];let next=end;
  for(let i=0;i<refs.length;i++){const ref=refs[i],task=taskRecord(c.records['central_task/'+ref.id],ref.id);check(task.project===ref.project);if(state==='open'&&!openForWork(task))continue;tasks.push({...withAvailability(Object.fromEntries(publicTaskFields.map(k=>[k,structuredClone(task[k])]))),difficulty:difficultyOf(task),...centralTaskClaim(task,operatorHold(task))});if(tasks.length===limit){next=positions[i]+1n;break;}}
  signal.throwIfAborted();taskPageProof(c.proof);const more=next<total;
  return{authority:'native',verified:true,order,state,tasks,cursor,nextCursor:String(next),more,total:count,scanned:String(next-from),limit,...(state==='open'&&from===0n&&!more?{openCount:String(tasks.length)}:{}),proof:Object.fromEntries(publicProofFields.map(k=>[k,c.proof[k]]))};
 }
 function waitPublicTaskPage(job,signal){
  signal?.throwIfAborted();check(taskPageWaiters<512);const waiter={};job.waiters.add(waiter);taskPageWaiters++;
  return new Promise((resolve,reject)=>{let done=false;const finish=(error,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',cancel);job.waiters.delete(waiter);taskPageWaiters--;if(!job.done&&job.waiters.size===0)job.controller.abort();error?reject(error):resolve(value);};const cancel=()=>finish(signal.reason??new DOMException('Public task page cancelled','AbortError'));signal?.addEventListener('abort',cancel,{once:true});job.promise.then(value=>{try{signal?.throwIfAborted();taskPageProof(value.proof);finish(null,structuredClone(value));}catch(error){finish(error);}},error=>finish(error));if(signal?.aborted)cancel();});
 }
const evidenceOperation=(operation,payload)=>EVIDENCE_OPS.includes(operation)||operation==='central_submit'&&Boolean(payload?.revises);
 // S6 checks shared by prepare and submit (10 November 2026): a revision, reassessment or expiry
 // acts on an under_review submission with a native evidence deadline, never on an open task.
 async function evidenceCheck(c,user,operation,payload){const target=operation==='central_submit'?payload.revises:payload.submission;await c.add(['central_evidence_activation','central_submission/'+target,...(operation==='central_submit'?['central_submission/'+payload.id]:[])]);check(evidenceActivation(c.records.central_evidence_activation)&&BigInt(c.proof.height)>=BigInt(c.records.central_evidence_activation.height),409,'central_evidence_window_inactive');const o=c.records['central_submission/'+target];check(obj(o)&&o.id===target&&o.state==='under_review'&&num(o.evidence_deadline??''),409,'central_evidence_request_absent');const open=BigInt(c.proof.height)<BigInt(o.evidence_deadline);
  if(operation==='central_evidence_expire')check(!open&&o.reassess!==true&&!o.revised_by,409,'central_evidence_window_open');
  else{check(o.author===user.address&&!o.author_instance,403,'central_submission_forbidden');check(open&&o.reassess!==true&&!o.revised_by&&!o.revises,409,'central_evidence_action_unavailable');}
  if(operation==='central_submit')check(o.task===payload.task&&c.records['central_submission/'+payload.id]===null,409,'central_submission_exists');}
 // Contribution view (P0-3, 12 November 2026): one derivation (shared/contribution-view.mjs) over
 // proved reads. Counting needs every award of the member, so the award index is walked oldest
 // first and the awards read are kept in memory: awards are written once and the index only
 // appends, so a cached prefix stays true and the next read fetches only new positions. The cache
 // is keyed by genesis and member, dropped when the chain's count is lower (a reset), and bounded
 // in members and in awards held. No table, job or process.
 const WALK_PAGE=31,WALK_PER_REQUEST=186,WALK_MAX=5000,WALK_MEMBERS=512,WALK_HELD=100000,SUBMISSIONS_READ=32;
 const awardWalks=new Map();let awardsHeld=0;
 const walkKey=address=>(native.pins?.epoch??'')+'/'+address;
 function dropWalk(key){const e=awardWalks.get(key);if(e){awardsHeld-=e.awards.length;awardWalks.delete(key);}}
 /** Immutable records (award index entries and awards), each read under its own fresh pinned proof. */
 async function provedRecords(keys,deadline,member){
  const out={};
  // 31 keys a read: the coalescer adds the member's own record to every selection.
  for(let at=0;at<keys.length;at+=31){
   const selected=keys.slice(at,at+31);proofCheck(Date.now()<deadline,'deadline');let c;
   // The bounded coalescer when present (as status uses), else the plain proved reader.
   try{c=typeof native.centralPublicState==='function'?await native.centralPublicState({member,keys:selected},{timeoutMs:Math.max(1,Math.min(25000,deadline-Date.now()))}):await native.publicState({keys:selected},{timeoutMs:Math.max(1,Math.min(8000,native.timeoutMs??8000,deadline-Date.now()))});}catch(error){proofCheck(false,readerCategory(error));}
   fresh(c?.proof);const s=c?.state;
   check(obj(s)&&s.chain_id===c.proof.chainId&&s.height===c.proof.height&&s.app_hash===c.proof.appHash&&obj(s.records)&&selected.every(k=>Object.hasOwn(s.records,k)));
   for(const k of selected)out[k]=structuredClone(s.records[k]);
  }
  return out;
 }
 async function walkAwards(address,count,deadline){
  const key=walkKey(address);let entry=awardWalks.get(key);
  if(entry&&BigInt(entry.awards.length)>count){dropWalk(key);entry=undefined;}
  if(!entry)entry={awards:[]};else awardWalks.delete(key);
  awardWalks.set(key,entry);
  const limit=count<BigInt(WALK_MAX)?count:BigInt(WALK_MAX);let budget=WALK_PER_REQUEST;
  try{
   while(BigInt(entry.awards.length)<limit&&budget>0){
    const from=BigInt(entry.awards.length)+1n,left=limit-from+1n,n=Number(left<BigInt(Math.min(WALK_PAGE,budget))?left:BigInt(Math.min(WALK_PAGE,budget)));
    const keys=[];for(let i=0n;i<BigInt(n);i++)keys.push('central_award_index/'+address+'/'+index(from+i));
    const refs=await provedRecords(keys,deadline,address).then(r=>keys.map(k=>{const ref=r[k];check(obj(ref)&&ID.test(ref.submission)&&['solver','reviewer'].includes(ref.role));return ref;}));
    const awardKeys=refs.map(r=>'central_award/'+r.role+'/'+r.submission),records=await provedRecords(awardKeys,deadline,address);
    const page=refs.map((r,i)=>{const a=awardRecord(records[awardKeys[i]],address,r.role,r.submission);return Object.fromEntries(['submission','task','project','member','role','amount','height'].map(k=>[k,a[k]]));});
    // Another read of the same member may have added this page meanwhile: keep positions exact.
    if(BigInt(entry.awards.length)+1n===from){entry.awards.push(...page);awardsHeld+=page.length;}
    budget-=n;
   }
  }finally{
   for(const k of awardWalks.keys()){if(awardWalks.size<=WALK_MEMBERS&&awardsHeld<=WALK_HELD)break;if(k!==key)dropWalk(k);}
  }
  return{awards:entry.awards.slice(0,Number(limit)),complete:BigInt(entry.awards.length)===count};
 }
 /** The member's own submissions BAINK relayed (newest first), with their proved records. */
 async function memberSubmissions(c,address){
  const ids=[...new Map(Object.values(store.read().centralEarningIntents??{}).filter(i=>i?.member===address&&i.command?.operation==='central_submit'&&typeof i.sendAttemptedAt==='string'&&!['refused','expired-unused','expired','prepared'].includes(i.status)&&ID.test(i.command.payload?.id??'')).sort((a,b)=>b.sendAttemptedAt.localeCompare(a.sendAttemptedAt)).map(i=>[i.command.payload.id,i.command.payload.task])).keys()];
  const picked=ids.slice(0,SUBMISSIONS_READ);if(picked.length)await c.add(picked.map(id=>'central_submission/'+id));
  const records=picked.map(id=>c.records['central_submission/'+id]).filter((s,i)=>obj(s)&&s.id===picked[i]&&s.author===address&&!s.author_instance&&ID.test(s.task??'')).map(s=>({id:s.id,task:s.task,state:s.state,...(s.evidence_deadline!==undefined?{evidence_deadline:s.evidence_deadline}:{}),...(s.reassess===true?{reassess:true}:{})}));
  return{records,complete:ids.length<=SUBMISSIONS_READ};
 }
 async function contributionWith(c,address,memberRecord,earnings,balanceUnits,deadline){
  const walk=await walkAwards(address,BigInt(earnings.awards),deadline),subs=await memberSubmissions(c,address);
  // The awards read never add up to more than the proved earnings record (each award counted once).
  const unique=[...new Map(walk.awards.map(a=>[a.role+'/'+a.submission,a])).values()];
  for(const role of['solver','reviewer'])check(unique.filter(a=>a.role===role).reduce((n,a)=>n+BigInt(a.amount),0n)<=BigInt(earnings[role]));
  return deriveContribution({member:address,enrolled:memberRecord!=null,karma:memberRecord?.karma??null,strikes:memberRecord?.strikes??0,licence:memberRecord?.licence??null,earnings,awards:walk.awards,awardsComplete:walk.complete,submissions:subs.records,submissionsComplete:subs.complete,balanceUnits,proofHeight:c.proof.height});
 }
 function balanceFor(c,memberRecord,address){
  const supply=c.records.coin_supply,balance=c.records['coin_balance/'+address],coin=c.records.coin_activation;
  check(obj(supply)&&['minted','reserved','transparent','shielded'].every(k=>amount(supply[k]))&&BigInt(supply.transparent)+BigInt(supply.shielded)===BigInt(supply.minted));
  check(coin===null||obj(coin)&&coin.policy==='verified-bounties-108t-micro-v1'&&num(coin.height));
  if(memberRecord?.licence!=='active'||!coin||BigInt(coin.height)>BigInt(c.proof.height))return null;
  check(balance===null||amount(balance));const units=balance??'0';check(BigInt(units)<=BigInt(supply.transparent));return units;
 }
 // Public reads by address (everything on the platform is public, K-38): a short-lived answer
 // per member, one read in flight per member, and a bounded number of reads at once.
 const publicViews=new Map(),publicFlights=new Map();const PUBLIC_VIEW_MS=10000,PUBLIC_VIEWS=256,PUBLIC_FLIGHTS=8;
 async function loadPublicContribution(address,signal){
  const deadline=Date.now()+25000,keys=['member/'+address,'central_earnings/'+address,'coin_balance/'+address,'coin_supply','coin_activation'];
  const c=await publicTaskContext(keys,signal),m=c.records['member/'+address];
  if(m!==null)check(obj(m)&&m.id===address&&typeof m.licence==='string');
  const earnings=earningsRecord(c.records['central_earnings/'+address],address);
  const view=await contributionWith(c,address,m,earnings,balanceFor(c,m,address),deadline);
  taskPageProof(c.proof);return view;
 }
 const service={get enabled(){return canSend();},
 /** A member's contribution view by address, for anyone (no key). null when native is not configured. */
 async contribution(address,options={}){
  check(typeof address==='string'&&ADDRESS.test(address),400,'invalid_address');if(native.configured!==true)return null;
  const now=monotonicNow(),held=publicViews.get(address);if(held&&now<held.until)return structuredClone(held.view);
  let flight=publicFlights.get(address);
  if(!flight){check(publicFlights.size<PUBLIC_FLIGHTS,503,'contribution_busy');flight=loadPublicContribution(address,new AbortController().signal).then(view=>{publicViews.delete(address);while(publicViews.size>=PUBLIC_VIEWS)publicViews.delete(publicViews.keys().next().value);publicViews.set(address,{view,until:monotonicNow()+PUBLIC_VIEW_MS});return view;}).finally(()=>publicFlights.delete(address));publicFlights.set(address,flight);}
  options.signal?.throwIfAborted();return structuredClone(await flight);
 },
 async submission(user,id,options={}){
  check(typeof id==='string'&&ID.test(id)&&obj(options)&&Object.keys(options).every(k=>k==='executionId')&&(!Object.hasOwn(options,'executionId')||typeof options.executionId==='string'&&ID.test(options.executionId)),400,'invalid_central_submission');
  const submissionKey='central_submission/'+id,c=await context(user,[submissionKey],true),s=c.records[submissionKey];
  const base={authority:'native',verified:true,member:user.address,provenAbsent:[],feedback:{available:false,reason:'native-review-record-has-no-feedback-text'}};
  if(s===null)return{...base,outcome:'not-recorded',submission:null,task:null,solverAward:null,reviewerAward:null,review:{status:'submission-not-recorded',record:null},provenAbsent:[submissionKey],proof:c.proof};
  check(s?.author===user.address&&!s.author_instance,403,'central_submission_forbidden');
  check(s.id===id&&ID.test(s.task??'')&&['under_review','accepted','rejected','superseded','expired'].includes(s.state)&&num(s.height)&&BigInt(s.height)>0n&&BigInt(s.height)<=BigInt(c.proof.height)&&typeof s.evidence==='string'&&s.evidence.isWellFormed()&&Buffer.byteLength(s.evidence)>0&&Buffer.byteLength(s.evidence)<=16384&&HASH.test(s.evidence_digest??'')&&sha(s.evidence)===s.evidence_digest);
  const taskKey='central_task/'+s.task,solverKey='central_award/solver/'+id,reviewerKey='central_award/reviewer/'+id;
  let selectedExecutionId=options.executionId??null,reviewKey=selectedExecutionId?'central_review/'+id+'/'+sha(selectedExecutionId):null;
  await c.add([taskKey,solverKey,reviewerKey,...(reviewKey?[reviewKey]:[])]);
  const t=taskRecord(c.records[taskKey],s.task),solver=c.records[solverKey],reviewer=c.records[reviewerKey];
  const boundAward=(a,role,member)=>{awardRecord(a,member,role,id);check(a.task===t.id&&a.project===t.project&&a.amount===(role==='solver'?t.solver_amount:t.reviewer_amount)&&BigInt(a.height)>=BigInt(s.height)&&BigInt(a.height)<=BigInt(c.proof.height));return a;};
  if(s.state==='under_review')check(solver===null&&reviewer===null&&t.state==='under_review'&&t.pending===id&&!t.winner);
  // S6: a superseded original or an expired request never carries an award and is never pending.
  else if(s.state==='superseded'||s.state==='expired')check(solver===null&&reviewer===null&&t.pending!==id&&t.winner!==id);
  else{
   check(obj(reviewer)&&ADDRESS.test(reviewer.member??'')&&reviewer.member!==s.author);boundAward(reviewer,'reviewer',reviewer.member);
   if(s.state==='accepted'){boundAward(solver,'solver',s.author);check(solver.height===reviewer.height&&t.state==='accepted'&&t.winner===id&&t.pending==='');}
   else check(solver===null&&t.winner!==id&&t.pending!==id);
  }
  let feedbackPacket=null,feedbackReadAttempted=false;
  const readFeedback=async()=>{
   feedbackReadAttempted=true;base.feedback={available:false,reason:'review-feedback-unavailable'};let timer;
   try{return await Promise.race([feedbackReader(Object.freeze({submission:id,executionId:selectedExecutionId})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('feedback_read_timeout')),Math.max(1,Math.min(8000,c.deadline-Date.now())));})]);}
   finally{clearTimeout(timer);}
  };
  if(!reviewKey&&typeof feedbackReader==='function'){
   try{feedbackPacket=await readFeedback();if(feedbackPacket?.submission!==id||typeof feedbackPacket.executionId!=='string'||!ID.test(feedbackPacket.executionId))feedbackPacket=null;}catch{feedbackPacket=null;}
   if(feedbackPacket){selectedExecutionId=feedbackPacket.executionId;reviewKey='central_review/'+id+'/'+sha(selectedExecutionId);await c.add([reviewKey]);}
  }
  const review={status:reviewKey?'not-found':'locator-required',record:null};
  if(reviewKey&&c.records[reviewKey]!==null){
   const r=c.records[reviewKey];check(obj(r)&&r.submission===id&&r.execution_id===selectedExecutionId&&r.criteria_digest===t.acceptance_digest&&r.evidence_digest===s.evidence_digest&&HASH.test(r.verification_digest??'')&&ADDRESS.test(r.reviewer??'')&&r.reviewer!==s.author&&num(r.height)&&BigInt(r.height)>=BigInt(s.height)&&BigInt(r.height)<=BigInt(c.proof.height));
   check(r.verdict==='needs_evidence'?(['under_review','superseded','expired'].includes(s.state)||BigInt(r.height)<=BigInt(reviewer.height)):s.state!=='under_review'&&r.verdict===(s.state==='accepted'?'accept':'reject')&&r.reviewer===reviewer.member&&r.height===reviewer.height);
   review.status='proved';review.record=Object.fromEntries(['submission','execution_id','criteria_digest','evidence_digest','verification_digest','reviewer','height','verdict'].map(k=>[k,r[k]]));
  }
  if(review.record&&typeof feedbackReader==='function'){
   try{
    if(!feedbackReadAttempted)feedbackPacket=await readFeedback();
    const verified=await validateReviewFeedback(feedbackPacket,{submission:id,executionId:selectedExecutionId,author:s.author,task:t.id,project:t.project,review:review.record,chainId:native.pins.chainId,genesisSha256:native.pins.epoch,verifierSha256:native.pins.verifierSha256});
    base.feedback={available:true,authority:'native-committed-decision',scope:'retained-review',packet:verified};
   }catch{base.feedback={available:false,reason:'review-feedback-unavailable'};}
  }
  const evidenceKeys=['central_evidence_activation','central_project_budget/'+t.project];await c.add(evidenceKeys);
  let evidence=null;try{const budget=c.records['central_project_budget/'+t.project];evidence=evidenceJourney({s,t,review,findings:base.feedback?.available?base.feedback.packet?.decision?.findings??null:null,activation:evidenceActivation(c.records.central_evidence_activation),proof:c.proof,help:{reviewer:review.record?.reviewer,manager:obj(budget)?budget.manager:null}});}catch{evidence={kind:'unavailable'};}
  fresh(c.proof);
  return{...base,evidence,outcome:s.state==='under_review'&&review.record?.verdict==='needs_evidence'?'needs_evidence':s.state,
   submission:Object.fromEntries(['id','task','author','state','height','evidence_digest','revises','revised_by','evidence_request_height','evidence_deadline','reassess','expired_height'].filter(k=>k in s||['id','task','author','state','height','evidence_digest'].includes(k)).map(k=>[k,s[k]])),
   task:Object.fromEntries(['id','project','acceptance_digest'].map(k=>[k,t[k]])),solverAward:solver?Object.fromEntries(['submission','task','project','member','role','amount','height'].map(k=>[k,solver[k]])):null,reviewerAward:reviewer?Object.fromEntries(['submission','task','project','member','role','amount','height'].map(k=>[k,reviewer[k]])):null,review,
   provenAbsent:[solverKey,reviewerKey,...(reviewKey?[reviewKey]:[])].filter(k=>c.records[k]===null),proof:c.proof};
 },
 async status(user){
  const trace={phase:'initial-state'};
  try{
   // A holder that never enrolled has no member record. Prove that absence and say "not enrolled",
   // instead of failing the member check and reporting "the network could not prove its state"
   // (fresh-join test, 13 November 2026: a new member saw central_proof_unavailable for ever).
   const c=await context(user,['member/'+user.address,'central_earning_activation','central_earnings/'+user.address,'coin_balance/'+user.address,'coin_supply','coin_activation'],true,trace,{absentMember:true});
   if(c.member==null){fresh(c.proof,{trace});return{authority:'native',verified:true,enabled:canSend(),enrolled:false,member:user.address,licence:null,note:'Not a UAIN member yet. Enrol first; status then shows your membership and earnings.',earnings:earningsRecord(null,user.address),awards:[],balanceUnits:null,proof:c.proof};}
   const activation=active(c,trace);
   trace.phase='award-index';const earnings=proofCall('earnings_record',trace,()=>earningsRecord(c.records['central_earnings/'+user.address],user.address)),awards=[];
   const count=BigInt(earnings.awards),start=count>12n?count-12n:0n,keys=[];for(let n=start+1n;n<=count;n++)keys.push('central_award_index/'+user.address+'/'+index(n));await c.add(keys);
   const refs=keys.map(k=>{const ref=c.records[k];proofCheck(obj(ref)&&ID.test(ref.submission)&&['solver','reviewer'].includes(ref.role),'award_index',trace);return ref;});
   trace.phase='awards';await c.add(refs.map(r=>'central_award/'+r.role+'/'+r.submission));
   for(const r of refs){const a=proofCall('award_record',trace,()=>awardRecord(c.records['central_award/'+r.role+'/'+r.submission],user.address,r.role,r.submission));proofCheck(BigInt(a.height)<=BigInt(c.proof.height)&&BigInt(a.amount)<=BigInt(earnings[a.role]),'award_record',trace);awards.push(a);}
   proofCheck(new Set(refs.map(r=>r.role+'/'+r.submission)).size===refs.length,'award_index',trace);
   for(const role of ['solver','reviewer']){const sum=awards.filter(a=>a.role===role).reduce((n,a)=>n+BigInt(a.amount),0n);proofCheck(sum<=BigInt(earnings[role])&&(count>12n||sum===BigInt(earnings[role])),'award_totals',trace);}
   trace.phase='asset';let balanceUnits=null;const supply=c.records.coin_supply,balance=c.records['coin_balance/'+user.address];
   proofCheck(obj(supply)&&['minted','reserved','transparent','shielded'].every(k=>amount(supply[k]))&&BigInt(supply.minted)+BigInt(supply.reserved)<=CAP&&BigInt(supply.transparent)+BigInt(supply.shielded)===BigInt(supply.minted),'coin_supply',trace);
   const coin=c.records.coin_activation;proofCheck(coin===null||obj(coin)&&coin.policy==='verified-bounties-108t-micro-v1'&&num(coin.height)&&HASH.test(coin.evidence_digest??''),'coin_activation',trace);
   if(c.member.licence==='active'&&coin&&BigInt(coin.height)<=BigInt(c.proof.height)){proofCheck(balance===null||amount(balance),'balance',trace);balanceUnits=balance??'0';proofCheck(BigInt(balanceUnits)<=BigInt(supply.transparent),'balance',trace);}
   // The contribution view rides along; when it cannot be read, status still answers and says so.
   let contribution;try{contribution=await contributionWith(c,user.address,c.member,earnings,balanceUnits,Date.now()+20000);}catch{contribution={available:false,reason:'contribution_unavailable',note:'Your contribution list could not be read just now; your points and earnings below are unaffected. Ask again in a minute.'};}
   return{authority:'native',verified:true,enabled:canSend(),active:!!activation,activation,member:user.address,licence:c.member.licence,contribution,earnings,awards,awardsScope:{limit:12,complete:count<=12n,total:earnings.awards,...(count>12n?{more:'GET /api/native/central/awards?cursor='+String(start)}:{})},balanceUnits,balanceScope:'transparent',earningsScope:'ever-earned-central-awards',assetId:'uain-native-coin',symbol:'AI$',decimals:6,proof:c.proof};
  }catch(error){reportProof(onProofRefusal,error,trace);throw error;}
 },
 /** Every award of this member, newest first, in cursor pages (status shows only the latest 12).
  * cursor is the highest award-index position to read (inclusive; default: the newest), limit 1..50;
  * nextCursor continues below this page.
  * Each page is read under one proof root and bound to the proved earnings record. */
 async awards(user,body={}){
  check(obj(body)&&Object.keys(body).every(k=>['cursor','limit'].includes(k)),400,'invalid_award_cursor');const limit=body.limit??50;check(Number.isInteger(limit)&&limit>=1&&limit<=50&&(body.cursor===undefined||num(body.cursor)),400,'invalid_award_cursor');
  const c=await context(user,['central_earnings/'+user.address,'member/'+user.address],true,undefined,{absentMember:true});
  if(c.member==null){fresh(c.proof);return{authority:'native',verified:true,member:user.address,enrolled:false,order:'newest-first',awards:[],cursor:'0',nextCursor:null,more:false,total:'0',limit,earnings:earningsRecord(null,user.address),note:'Not a UAIN member yet, so there are no awards. Enrol first.',proof:c.proof};}
  const earnings=earningsRecord(c.records['central_earnings/'+user.address],user.address),count=BigInt(earnings.awards),cursor=body.cursor===undefined?count:BigInt(body.cursor);check(cursor<=count,400,'invalid_award_cursor');
  const floor=cursor>BigInt(limit)?cursor-BigInt(limit):0n,keys=[];for(let n=cursor;n>floor;n--)keys.push('central_award_index/'+user.address+'/'+index(n));await c.add(keys);
  const refs=keys.map(k=>{const ref=c.records[k];check(obj(ref)&&ID.test(ref.submission)&&['solver','reviewer'].includes(ref.role));return ref;});check(new Set(refs.map(r=>r.role+'/'+r.submission)).size===refs.length);
  await c.add(refs.map(r=>'central_award/'+r.role+'/'+r.submission));
  const awards=refs.map((r,i)=>{const a=awardRecord(c.records['central_award/'+r.role+'/'+r.submission],user.address,r.role,r.submission);check(BigInt(a.height)<=BigInt(c.proof.height)&&BigInt(a.amount)<=BigInt(earnings[a.role]));return{position:String(cursor-BigInt(i)),...Object.fromEntries(['submission','task','project','member','role','amount','height'].map(k=>[k,a[k]]))};});
  for(const role of ['solver','reviewer'])check(awards.filter(a=>a.role===role).reduce((n,a)=>n+BigInt(a.amount),0n)<=BigInt(earnings[role]));
  fresh(c.proof);
  return{authority:'native',verified:true,member:user.address,order:'newest-first',awards,cursor:String(cursor),nextCursor:floor>0n?String(floor):null,more:floor>0n,total:earnings.awards,limit,earnings,proof:c.proof};
 },
 // For review-queue.mjs, a server-side reader with no member. Submission records are public on the ledger;
 // the keys are built by server code from BAINK's own store, never from a request.
 async publicRecords(keys,options={}){check(Array.isArray(keys)&&keys.length>=1&&keys.length<=96&&keys.every(k=>typeof k==='string'&&/^central_submission\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(k)),400,'invalid_central_keys');if(native.configured!==true)return null;const c=await publicTaskContext(keys,options.signal??new AbortController().signal);taskPageProof(c.proof);return{records:Object.fromEntries(keys.map(k=>[k,c.records[k]??null])),height:c.proof.height};},
 /** Submissions BAINK relayed, newest first: id, task and when it was sent. Reads BAINK's own store only. */
 recordedSubmissions(limit=96){return Object.values(store.read().centralEarningIntents??{}).filter(i=>i?.command?.operation==='central_submit'&&typeof i.sendAttemptedAt==='string'&&!['refused','expired-unused','expired','prepared'].includes(i.status)&&ID.test(i.command.payload?.id??'')).sort((a,b)=>b.sendAttemptedAt.localeCompare(a.sendAttemptedAt)).slice(0,limit).map(i=>({id:i.command.payload.id,task:i.command.payload.task,at:i.sendAttemptedAt}));},
 async tasks(user,body={},options={}){
  // options.public is set only by server code (public-tasks.mjs): the same cached page, with no member.
  if(options.public!==true)holder(user);options.signal?.throwIfAborted();check(obj(body)&&Object.keys(body).every(k=>['cursor','limit','order','state'].includes(k)),400,'invalid_central_cursor');const cursor=body.cursor??'0',limit=body.limit??12,order=body.order??'index',state=body.state??'all';check(num(cursor)&&Number.isInteger(limit)&&limit>=1&&limit<=(options.public===true?48:12),400,'invalid_central_cursor');check(['index','newest'].includes(order)&&['all','open'].includes(state),400,'invalid_central_listing');const plainPage=order==='index'&&state==='all',key=plainPage?JSON.stringify({cursor,limit}):JSON.stringify({cursor,limit,order,state}),cached=cachedTaskPage(key);if(cached)return cached;let job=taskPageFlights.get(key);
  check(taskPageWaiters<512);if(job)check(!job.controller.signal.aborted);else{check(taskPageFlights.size<16);job={controller:new AbortController(),waiters:new Set(),done:false,promise:null};taskPageFlights.set(key,job);job.promise=Promise.resolve().then(()=>plainPage?loadPublicTaskPage(cursor,limit,job.controller.signal):loadPublicTaskScan(cursor,limit,order,state,job.controller.signal)).then(value=>{job.controller.signal.throwIfAborted();retainTaskPage(key,value);return value;},error=>{dropTaskPage(key);throw error;}).finally(()=>{job.done=true;if(taskPageFlights.get(key)===job)taskPageFlights.delete(key);});job.promise.catch(()=>{});}return waitPublicTaskPage(job,options.signal);
 },
 // One proved public task record for an unauthenticated reader (the survey-part template).
 // No holder authority; null when native is not configured or the task is proved absent.
 async publicTask(id,options={}){check(typeof id==='string'&&ID.test(id)&&obj(options),400,'invalid_central_task');if(native.configured!==true)return null;const key='central_task/'+id,c=await publicTaskContext([key],options.signal??new AbortController().signal);if(c.records[key]===null)return null;const task=taskRecord(c.records[key],id);taskPageProof(c.proof);return{authority:'native',verified:true,task:structuredClone(task),proof:Object.fromEntries(publicProofFields.map(k=>[k,c.proof[k]]))};},
 async task(user,id){const c=await context(user,['central_earning_activation'],true),selection=await selectedTask(c,user,id),requirements=taskRequirements?.forTask(selection.task)??{available:false,reason:"not_published"};return{authority:'native',verified:true,active:!!active(c),...selection,task:withAvailability(selection.task),...(operatorHold(selection.task)?{availability:operatorHold(selection.task)}:{}),requirements,difficulty:estimateTaskDifficulty(selection.task,{requirements}),status_label:centralTaskStatus(selection.task).status_label,...centralMemberClaim(selection.task,{availability:operatorHold(selection.task),licence:c.member.licence,joined:selection.joined,selfReviewer:active(c)?.reviewer===user.address,projectActive:selection.project.state==='active'&&!selection.project.safety_halted,reviewActive:!!active(c)}),proof:c.proof};},
 list(user,{limit,id}={}){holder(user);const all=Object.values(store.read().centralEarningIntents??{}).filter(i=>i.member===user.address).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      // No option: every step (the kit reads them all). limit: the newest that many. id: that one step, or none.
      if(limit===undefined&&id===undefined)return{intents:all.map(view)};
      const rows=id!==undefined?all.filter(i=>i.id===id):all.slice(0,limit);
      return{intents:rows.map(view),total:all.length,more:id===undefined&&all.length>rows.length};},
 async prepare(user,body){holder(user);check(exact(body,['operation','payload'])&&publicOp(body.operation),400,'invalid_central_operation');let payload;try{payload=centralPayload(body.operation,body.payload);}catch{check(false,400,'invalid_central_payload');}const identity=canonicalJSON({operation:body.operation,payload}),old=Object.values(store.read().centralEarningIntents??{}).find(i=>i.member===user.address&&i.identity===identity&&!released(i));holder(user);if(old?.sendAttemptedAt)return{created:false,intent:view(old)};const c=await context(user,['central_earning_activation']);licensed(c);check(active(c),409,'central_inactive');if(evidenceOperation(body.operation,payload))await evidenceCheck(c,user,body.operation,payload);
  else if(body.operation==='central_submit'){const selected=await selectedTask(c,user,payload.task);check(!operatorHold(selected.task),409,'central_task_specification_unusable');eligible(c,selected,user);await c.add(['central_submission/'+payload.id]);check(c.records['central_submission/'+payload.id]===null,409,'central_submission_exists');}else{await c.add(['project/'+payload.project,'central_project_budget/'+payload.project,'participation/'+payload.project+'/'+user.address+'/']);const p=c.records['project/'+payload.project];budgetRecord(c.records['central_project_budget/'+payload.project],payload.project,c.proof.height);check(p?.id===payload.project&&p.state==='active'&&p.safety_halted===false,409,'central_project_inactive');check(c.records['participation/'+payload.project+'/'+user.address+'/']===null,409,'central_already_joined');}
  const reuse=old&&(old.sendAttemptedAt||old.command.sequence===c.member.sequence&&BigInt(old.command.expires_height)>BigInt(c.proof.height));const command=(reuse?old.command:null)??{version:1,chain_id:c.proof.chainId,member:user.address,sequence:c.member.sequence,expires_height:String(BigInt(c.proof.height)+100n),operation:body.operation,payload};check(command.sequence===c.member.sequence&&BigInt(command.expires_height)>BigInt(c.proof.height),409,'central_intent_changed');const bytes=centralEarningSigningBytes(command),now=new Date().toISOString();const saved=await store.transact(s=>{fresh(c.proof);check(Date.now()<c.deadline);s.centralEarningIntents??={};const prior=Object.values(s.centralEarningIntents).filter(i=>i.member===user.address),same=prior.find(i=>i.identity===identity&&!released(i));if(same&&(same.sendAttemptedAt||canonicalJSON(same.command)===canonicalJSON(command))){if(!same.sendAttemptedAt)same.proof=c.proof;return{created:false,intent:same};}if(same)same.status='expired';for(const i of prior.filter(i=>i.status!=='finalized'&&!released(i)))check(!i.sendAttemptedAt&&BigInt(i.command.expires_height)<BigInt(c.proof.height),409,'central_intent_pending');check(prior.length<256&&Object.keys(s.centralEarningIntents).length<10000,429,'central_intent_capacity');const intent={id:randomUUID(),member:user.address,publicKey:c.publicKey,identity,status:'prepared',command,signingBytesBase64:bytes.toString('base64'),commandDigest:sha(bytes),proof:c.proof,afterEvent:c.state.event_count,scanCursor:c.state.event_count,sendAttemptedAt:null,envelope:null,transactionHash:null,createdAt:now,updatedAt:now};s.centralEarningIntents[intent.id]=intent;return{created:true,intent};});return{created:saved.created,intent:view(saved.intent)};},
 async submit(user,id,body){check(canSend(),503,'central_earning_disabled');check(exact(body,['envelope']),400,'invalid_central_envelope');const i=owned(user,id),envelope=structuredClone(body.envelope);verifiedEnvelope(i,envelope);if(i.sendAttemptedAt){check(canonicalJSON(i.envelope)===canonicalJSON(envelope),409,'central_envelope_conflict');return{attempted:false,intent:view(i)};}const c=await context(user,['central_earning_activation']);licensed(c);check(active(c)&&c.member.sequence===i.command.sequence&&BigInt(c.proof.height)<BigInt(i.command.expires_height)&&BigInt(c.proof.height)>=BigInt(i.proof.height),409,'central_intent_changed');if(evidenceOperation(i.command.operation,i.command.payload))await evidenceCheck(c,user,i.command.operation,i.command.payload);else if(i.command.operation==='central_submit'){eligible(c,await selectedTask(c,user,i.command.payload.task),user);await c.add(['central_submission/'+i.command.payload.id]);check(c.records['central_submission/'+i.command.payload.id]===null,409,'central_submission_exists');}else{await c.add(['project/'+i.command.payload.project,'central_project_budget/'+i.command.payload.project,'participation/'+i.command.payload.project+'/'+user.address+'/']);const p=c.records['project/'+i.command.payload.project];budgetRecord(c.records['central_project_budget/'+i.command.payload.project],i.command.payload.project,c.proof.height);check(p?.id===i.command.payload.project&&p.state==='active'&&p.safety_halted===false&&c.records['participation/'+i.command.payload.project+'/'+user.address+'/']===null,409,'central_project_inactive');}const marker=await store.transact(s=>{const current=s.centralEarningIntents[id];check(current?.member===user.address,404,'central_intent_missing');if(current.sendAttemptedAt)return{send:false,intent:current};check(!hasPendingNativeSend(s,user.address),409,'native_sequence_pending');fresh(c.proof);check(Date.now()<c.deadline);current.envelope=envelope;current.transactionHash=sha(JSON.stringify(envelope)).toUpperCase();current.sendAttemptedAt=new Date().toISOString();current.status='broadcasting';return{send:true,intent:current};});if(!marker.send)return{attempted:false,intent:view(marker.intent)};let outcome={status:'unknown',broadcastCode:null};try{const r=await native.broadcastCentral(envelope,{timeoutMs:Math.max(1,c.deadline-Date.now())});if(r.transactionHash===marker.intent.transactionHash&&Number.isInteger(r.code)&&r.code>=0&&r.accepted===(r.code===0))outcome={status:r.accepted?'accepted':'refused',broadcastCode:r.code};}catch{}const saved=await store.transact(s=>{const current=s.centralEarningIntents[id];if(current.status==='broadcasting')Object.assign(current,outcome);current.updatedAt=new Date().toISOString();return current;});return{attempted:true,intent:view(saved)};},
 async reconcile(user,id,body){check(exact(body,[])||exact(body,['eventId'])&&num(body.eventId)&&BigInt(body.eventId)>0n,400,'invalid_central_event');const i=owned(user,id);check(i.sendAttemptedAt&&i.envelope,409,'central_not_submitted');verifiedEnvelope(i,i.envelope);if(i.status==='finalized'||i.status==='expired-unused')return{intent:view(i)};const c=await context(user,[]);let eventId=body.eventId;
  if(eventId===undefined){const count=BigInt(c.state.event_count),cursor=i.scanCursor??i.afterEvent;check(num(cursor)&&BigInt(cursor)<=count);const start=BigInt(cursor),end=start+32n<count?start+32n:count,keys=[];for(let n=start+1n;n<=end;n++)keys.push('event/'+index(n));await c.add(keys);const subject=i.command.operation==='central_submit'?i.command.payload.id:EVIDENCE_OPS.includes(i.command.operation)?i.command.payload.submission:i.command.payload.project;for(const k of keys){const e=c.records[k];check(obj(e)&&num(e.id)&&index(e.id)===k.slice(6)&&HASH.test(e.command_digest??'')&&typeof e.operation==='string');if(e.command_digest!==i.commandDigest)continue;check(e.member===user.address&&e.operation===i.command.operation&&e.subject===subject&&!e.instance&&!e.origin);eventId=e.id;break;}if(eventId===undefined){
   // Proved expiry: past expires_height the original bytes can never be included; an unchanged sequence and absent subject record prove they were not. Never re-broadcast.
   const recordKey=i.command.operation==='central_submit'?'central_submission/'+i.command.payload.id:EVIDENCE_OPS.includes(i.command.operation)?'central_submission/'+i.command.payload.submission:'participation/'+i.command.payload.project+'/'+user.address+'/';let recovery=null;if(BigInt(c.proof.height)>BigInt(i.command.expires_height)&&c.member.sequence===i.command.sequence){await c.add([recordKey]);const notApplied=EVIDENCE_OPS.includes(i.command.operation)?obj(c.records[recordKey])&&(i.command.operation==='central_reassess'?c.records[recordKey].reassess!==true:c.records[recordKey].state!=='expired'):c.records[recordKey]===null;if(c.member.sequence===i.command.sequence&&notApplied)recovery={schema:'baink-central-earning-recovery-v1',verified:true,status:'expired-unused',paid:false,commandDigest:i.commandDigest,sequence:i.command.sequence,expiresHeight:i.command.expires_height,recordKey,recordPresent:c.records[recordKey]!==null,proof:c.proof};}
   const saved=await store.transact(s=>{const current=s.centralEarningIntents[id];if(current.status==='finalized'||current.status==='expired-unused')return current;fresh(c.proof);check(Date.now()<c.deadline);if(BigInt(current.scanCursor??current.afterEvent)<end)current.scanCursor=String(end);current.moreEvents=end<count;if(recovery){check(current.commandDigest===i.commandDigest&&current.transactionHash===i.transactionHash&&current.sendAttemptedAt===i.sendAttemptedAt&&canonicalJSON(current.envelope)===canonicalJSON(i.envelope),409,'central_envelope_conflict');current.status='expired-unused';current.recovery=recovery;current.moreEvents=false;current.updatedAt=new Date().toISOString();}return current;});return{intent:view(saved)};}}
  proofCheck(Date.now()<c.deadline,'deadline');let reply;try{reply=await native.publicState({member:user.address,keys:[],receipt:{envelope:i.envelope,event_id:eventId}},{timeoutMs:Math.max(1,c.deadline-Date.now())});}catch(error){proofCheck(false,readerCategory(error));}fresh(reply?.proof);const r={...reply?.state?.receipt,proof:reply?.proof};receiptShape(i,r);check(r.event.id===eventId&&reply.state.chain_id===r.chain_id&&reply.state.height===r.state_height&&reply.state.app_hash===r.app_hash&&reply.state.member?.id===user.address&&reply.state.member.public_key===i.publicKey&&num(reply.state.member.sequence)&&BigInt(reply.state.member.sequence)>BigInt(i.command.sequence));
  const key=i.command.operation==='central_submit'?'central_submission/'+i.command.payload.id:EVIDENCE_OPS.includes(i.command.operation)?'central_submission/'+i.command.payload.submission:'participation/'+i.command.payload.project+'/'+user.address+'/';await c.add([key]);check(BigInt(c.proof.height)>=BigInt(r.state_height));const record=c.records[key];if(i.command.operation==='central_submit'){const p=i.command.payload;check(record?.id===p.id&&record.task===p.task&&record.author===user.address&&!record.author_instance&&record.evidence===p.evidence&&record.evidence_digest===p.evidence_digest&&record.height===r.event.height&&(record.revises??'')===(p.revises??''));}else if(i.command.operation==='central_reassess')check(record?.id===i.command.payload.submission&&record.reassess===true);else if(i.command.operation==='central_evidence_expire')check(record?.id===i.command.payload.submission&&record.state==='expired');else check(record?.project===i.command.payload.project&&record.member===user.address&&!record.instance);const saved=await store.transact(s=>{const current=s.centralEarningIntents[id];if(current.status==='finalized')return current;fresh(c.proof);check(Date.now()<c.deadline);current.status='finalized';current.scanCursor=eventId;current.moreEvents=false;current.receipt=r;current.result={verified:true,status:{central_submit:'submitted',central_reassess:'reassessment_requested',central_evidence_expire:'expired'}[i.command.operation]??'joined',paid:false,recordKey:key,proof:c.proof};current.updatedAt=new Date().toISOString();return current;});native.invalidateAccount?.(user.address);return{intent:view(saved)};}
 };return Object.freeze(service);
}
