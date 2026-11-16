#!/usr/bin/env node
/** UAIN house agent: one same-operator controlled member (disclosed, not outside
 * adoption) that reads open funded central tasks, joins a named project and
 * submits reviewed evidence. Generalizes the controlled central buyer:
 * - project/task/submission IDs come only from arguments and are validated;
 * - every mutating step uses the frozen driver's durable `once` claims;
 * - no ID rotation, no automatic resend, fail closed on any uncertainty;
 * - success needs an exact finalized native receipt, and stays `paid:false`.
 * Never prints keys, evidence text, nonces or auth headers. `inspect` sends no HTTP. */
import {createHash,createPrivateKey,createPublicKey,randomBytes,sign} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath,readdir} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export const PINS=Object.freeze({chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',verifierSha256:'136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'});
export const ORIGIN='https://baink.money';
export const DEFAULT_RUN='/holder/controlled-service/run';
export const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/; // same rule as the server and web signer
export const MAX_EVIDENCE_BYTES=16384;
export const MODES=Object.freeze(['inspect','tasks','submission-status','recovery-check','join','submit','receipt-join','receipt-submit']);
const CODE='/holder/controlled-service-code';
const DRIVER_SHA='1e8bae286b85de30d7aaa63a7ae84ba3f7387eeb08fd7e7b5b45472443f8fe87';
const RUNTIME_UID=501,RUNTIME_GID=20;
const PREPARE='/api/native/central/prepare';
const MEMBER=/^uain1[0-9a-f]{40}$/,HASH=/^[a-f0-9]{64}$/,INTENT=/^[a-f0-9-]{36}$/;

const insist=(ok,message='House agent action refused')=>{if(!ok)throw Error(message);};
const sha=x=>createHash('sha256').update(x).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(x);

export function validId(value,label='ID'){insist(typeof value==='string'&&ID.test(value),`Invalid ${label} ID`);return value;}

export function checkEvidence(evidence){
 insist(typeof evidence==='string'&&evidence.isWellFormed()&&evidence.trim().length>0&&Buffer.byteLength(evidence,'utf8')<=MAX_EVIDENCE_BYTES,'Exact nonempty UTF-8 evidence of at most 16384 bytes required');
 return evidence;
}

export function payloadFor(kind,{project,task,submission,evidence}={}){
 if(kind==='join')return{project:validId(project,'project')};
 insist(kind==='submit','Unknown central action');
 validId(task,'task');validId(submission,'submission');checkEvidence(evidence);
 return{id:submission,task,evidence,evidence_digest:sha(Buffer.from(evidence,'utf8'))};
}

/** Journal labels are keyed by project (join) or task (submit) only. A rerun
 * with another submission ID or other evidence for the same task therefore
 * hits the retained claim and is refused: one submission per task, no rotation. */
export function journalPrefix(kind,payload){
 return kind==='join'?'house-join-'+sha('project\0'+payload.project).slice(0,32):'house-submit-'+sha('task\0'+payload.task).slice(0,32);
}

function reviewed(intent,operation,payload,member){
 insist(intent&&INTENT.test(intent.id)&&intent.member===member&&intent.command?.member===member&&intent.command.chain_id===PINS.chainId&&intent.command.operation===operation&&same(intent.command.payload,payload)&&HASH.test(intent.commandDigest)&&sha(Buffer.from(intent.signingBytesBase64,'base64'))===intent.commandDigest,'Prepared intent differs from the reviewed action');
}

function finalized(i,envelope,operation,payload,member){
 reviewed(i,operation,payload,member);
 const join=operation==='project_join',r=i.receipt,e=r?.event,p=r?.proof;
 const subject=join?payload.project:payload.id,key=join?`participation/${payload.project}/${member}/`:`central_submission/${payload.id}`;
 insist(i.status==='finalized'&&i.finalized===true&&i.historicalReceipt===true&&i.transactionHash===sha(JSON.stringify(envelope)).toUpperCase()
  &&r?.authority==='native'&&r.finalized===true&&r.chain_id===PINS.chainId&&uint(r.state_height)&&BigInt(r.state_height)>0n
  &&p?.authority==='native'&&p.chainId===PINS.chainId&&p.epoch===PINS.genesisSha256&&p.genesisSha256===PINS.genesisSha256&&p.verifierSha256===PINS.verifierSha256&&p.height===r.state_height&&p.appHash===r.app_hash&&HASH.test(p.appHash)
  &&e?.member===member&&e.operation===operation&&e.subject===subject&&e.command_digest===i.commandDigest&&!e.instance&&!e.origin
  &&uint(e.id)&&BigInt(e.id)>0n&&uint(e.height)&&BigInt(e.height)>0n&&BigInt(e.height)<=BigInt(r.state_height)
  &&i.result?.verified===true&&i.result.paid===false&&i.result.status===(join?'joined':'submitted')&&i.result.recordKey===key,'Exact authoritative finalized receipt required');
 return{controlledBySameOperator:true,outsideAdoption:false,operation,member,
  ...(join?{project:payload.project}:{task:payload.task,submissionId:payload.id,evidenceDigest:payload.evidence_digest}),
  intentId:i.id,finalized:true,paid:false,receipt:r};
}

/** Mutating modes. `deps` is a test seam; the CLI builds the real adapters. */
export async function execute(mode,options,deps){
 insist(options?.executeProduction===true,'Explicit --execute-production required');
 insist(['join','submit','receipt-join','receipt-submit'].includes(mode),'Unknown mutating mode');
 insist(typeof options.member==='string'&&MEMBER.test(options.member),'Member address required');
 const receiptOnly=mode.startsWith('receipt-'),kind=receiptOnly?mode.slice(8):mode,operation=kind==='join'?'project_join':'central_submit';
 const payload=payloadFor(kind,options),prefix=journalPrefix(kind,payload),journal=options.journal,member=options.member;
 const prepareClaim={path:PREPARE,method:'POST',body:{operation,payload}};
 const prepared=receiptOnly?await deps.load(prefix+'-prepare',prepareClaim)
  :await deps.once(journal,prefix+'-prepare',prepareClaim,()=>deps.http(PREPARE,{method:'POST',body:prepareClaim.body}));
 const intent=prepared?.intent;reviewed(intent,operation,payload,member);
 const signingClaim={intentId:intent.id,commandDigest:intent.commandDigest,operation,payload};
 const envelope=receiptOnly?await deps.load(prefix+'-envelope',signingClaim)
  :await deps.once(journal,prefix+'-envelope',signingClaim,()=>deps.sign(intent,{expectedOperation:operation,expectedPayload:payload}));
 deps.verifyEnvelope(envelope);insist(same(envelope.command,intent.command),'Envelope differs from the retained prepared command');
 if(!receiptOnly){
  const path=`/api/native/central/intents/${intent.id}/submit`;
  const sent=await deps.once(journal,prefix+'-submit',{path,method:'POST',body:{envelope}},()=>deps.http(path,{method:'POST',body:{envelope}}));
  reviewed(sent?.intent,operation,payload,member);
  if(sent.intent.status==='finalized')return finalized(sent.intent,envelope,operation,payload,member);
  insist(sent.intent.status==='accepted','Submit uncertain or refused; STOP and reconcile the exact retained intent, never resubmit');
 }
 // Receipt lookups only: each reconcile POST has its own durable slot; never re-sign or rebroadcast.
 // At most 8 fresh polls per invocation (2 s apart) and 32 slots in total.
 const path=`/api/native/central/intents/${intent.id}/reconcile`;let fresh=0;
 for(let n=0;n<32;n++){
  const reply=await deps.once(journal,`${prefix}-receipt-${String(n).padStart(2,'0')}`,{path,method:'POST',body:{}},async()=>{if(fresh>0)await deps.wait(2000);fresh++;return deps.http(path,{method:'POST',body:{}});});
  reviewed(reply?.intent,operation,payload,member);
  if(reply.intent.status==='finalized')return finalized(reply.intent,envelope,operation,payload,member);
  insist(['accepted','unknown'].includes(reply.intent.status),'Receipt state refused; STOP');
  if(fresh>=8)break;
 }
 return{controlledBySameOperator:true,outsideAdoption:false,operation,member,intentId:intent.id,finalized:false,paid:false,receiptPending:true,
  nextAction:`receipt-${kind} with the same arguments; never resubmit or rotate IDs`};
}

export const openFunded=t=>t?.availability?.available!==false&&t?.state==='open'&&!t.pending&&!t.winner&&uint(t.reserved)&&uint(t.solver_amount)&&uint(t.reviewer_amount)&&BigInt(t.reserved)===BigInt(t.solver_amount)+BigInt(t.reviewer_amount);
export const SURVEY_TASK=/^T-OPP-[0-9]{5}-1-prior-art-survey(?:-r[2-9]-p[1-9][0-9]?)?$/;
/** A public template is context only, bound to the native-verified criteria; it grants no authority. */
export function boundSurveyTemplate(task,template){
 insist(SURVEY_TASK.test(task?.id??'')&&template?.taskId===task.id&&template.project===task.project&&
  template.criteriaDigest===task.acceptance_digest&&HASH.test(task.acceptance_digest??'')&&typeof task.criteria==='string'&&sha(task.criteria)===task.acceptance_digest&&
  typeof template.mainKpi==='string'&&template.mainKpi.length>=1&&task.criteria.includes(`Main KPI: "${template.mainKpi}".`)&&
  task.criteria.includes('No novelty claim is made or rewarded;')&&template.minIncluded===8&&template.minKinds===2&&
  Array.isArray(template.required)&&template.required.length<=40&&template.required.every(r=>r&&['doi','arxiv','github','pubmed','nct','wikidata'].includes(r.kind)&&typeof r.id==='string'&&r.id.length<=256&&typeof r.title==='string'&&r.title.length<=1000),
  'Unbound survey template');
 return template;
}
const PUBLIC_TASK=['id','project','title','criteria','acceptance_digest','eligibility','eligibility_digest','solver_amount','reviewer_amount'];

/** Read-only: member status plus open, funded tasks with per-task eligibility. */
export async function listTasks(get,member,{maxPages=20,maxDetails=24}={}){
 const status=await get('/api/native/central/status');
 insist(status?.authority==='native'&&status.verified===true&&status.member===member,'Unverified central status');
 const open=[];let cursor='0',pages=0,more=true;
 while(more&&pages<maxPages){
  const page=await get(`/api/native/central/tasks?cursor=${cursor}&limit=12`);pages++;
  insist(page?.authority==='native'&&page.verified===true&&Array.isArray(page.tasks)&&page.tasks.length<=12&&uint(page.nextCursor)&&BigInt(page.nextCursor)>=BigInt(cursor),'Unverified task page');
  for(const t of page.tasks){validId(t?.id,'task');validId(t.project,'project');if(openFunded(t))open.push(t);}
  more=page.more===true&&page.nextCursor!==cursor;cursor=page.nextCursor;
 }
 const tasks=[];
 for(const t of open.slice(0,maxDetails)){
  const d=await get('/api/native/central/tasks/'+t.id);
  insist(d?.authority==='native'&&d.verified===true&&d.task?.id===t.id&&d.task.project===t.project&&typeof d.joined==='boolean','Unverified task detail');
  if(d.availability?.available===false||d.task.availability?.available===false)continue;
  const eligibleForSubmit=d.active===true&&d.project?.state==='active'&&d.project.safety_halted===false&&openFunded(d.task)&&status.activation?.reviewer!==member;
  const surveyTemplate=SURVEY_TASK.test(t.id)?boundSurveyTemplate(d.task,await get('/api/native/central/survey-template/'+t.id)):null;
  tasks.push({...Object.fromEntries(PUBLIC_TASK.map(k=>[k,d.task[k]])),...(surveyTemplate?{surveyTemplate}:{}),projectState:d.project?.state??null,joined:d.joined,eligibleForSubmit});
 }
 return{controlledBySameOperator:true,outsideAdoption:false,member,active:status.active===true,enabled:status.enabled===true,licence:status.licence??null,
  earnings:status.earnings??null,balanceUnits:status.balanceUnits??null,tasks,truncated:more||open.length>maxDetails};
}

/** Native inclusion/absence is verified by the pinned server reader; bind its
 * returned proof metadata here, never treat HTTP404 or an empty object as absence. */
export function freshNativeProof(p,now=Date.now()){
 const age=now-Date.parse(p?.headerTime);
 insist(p?.authority==='native'&&p.chainId===PINS.chainId&&p.genesisSha256===PINS.genesisSha256&&p.epoch===PINS.genesisSha256&&p.verifierSha256===PINS.verifierSha256&&uint(p.height)&&BigInt(p.height)>0n&&HASH.test(p.appHash??'')&&Number.isInteger(p.maxAgeSeconds)&&p.maxAgeSeconds>=1&&p.maxAgeSeconds<=120&&Number.isFinite(age)&&age>=-30000&&age<=p.maxAgeSeconds*1000,'Fresh pinned native proof required');
}
export async function adapterSourceDigest(){
 const path=fileURLToPath(import.meta.url);insist(await realpath(path)===path);const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await fd.stat();insist(s.isFile()&&s.nlink===1&&!(s.mode&0o022)&&s.size<=1048576);return sha(await fd.readFile());}finally{await fd.close();}
}
export async function submissionStatus(get,member,id,{now=Date.now}={}){
 validId(id,'submission');insist(MEMBER.test(member));const d=await get('/api/native/central/submissions/'+id);
 insist(d?.authority==='native'&&d.verified===true&&d.member===member,'Own native submission proof required');freshNativeProof(d.proof,now());
 if(d.outcome==='not-recorded')insist(d.submission===null&&Array.isArray(d.provenAbsent)&&d.provenAbsent.includes('central_submission/'+id),'Exact proved submission absence required');
 else insist(['under_review','needs_evidence','accepted','rejected','superseded','expired'].includes(d.outcome)&&d.submission?.id===id&&d.submission.author===member&&ID.test(d.submission.task??''),'Own submission binding differs');
 return d;
}
/** This authenticated index endpoint is unpaginated and returns ALL own intents.
 * Unknown keys, pagination, malformed records and oversized HTTP bodies refuse. */
export async function recoveryCheck(get,member,options,{now=Date.now,journalCheck}={}){
 const {project,task,submission}=options;for(const id of [project,task,submission])validId(id);insist(MEMBER.test(member)&&typeof journalCheck==='function');
 const status=await get('/api/native/central/status');insist(status?.authority==='native'&&status.verified===true&&status.member===member&&status.active===true&&status.enabled===true&&MEMBER.test(status.activation?.reviewer??'')&&status.activation.reviewer!==member,'Active same-owner eligibility required');
 const absent=await submissionStatus(get,member,submission,{now});insist(absent.outcome==='not-recorded','Existing native submission refuses recovery');
 const index=await get('/api/native/central/intents');insist(index&&Object.keys(index).join(',')==='intents'&&Array.isArray(index.intents)&&index.intents.length<=256,'Complete own intent index required');
 for(const i of index.intents){insist(i&&INTENT.test(i.id??'')&&i.member===member&&i.command?.member===member&&['project_join','central_submit'].includes(i.command.operation)&&i.command.payload&&typeof i.command.payload==='object','Malformed own intent index');const p=i.command.payload;insist(i.command.chain_id===PINS.chainId&&['prepared','broadcasting','accepted','unknown','refused','finalized','proof_unavailable'].includes(i.status),'Malformed own intent state');if(i.command.operation==='project_join')validId(p.project);else{validId(p.task);validId(p.id);}insist(!(i.command.operation==='project_join'&&p.project===project)&&!(i.command.operation==='central_submit'&&(p.task===task||p.id===submission)),'Related retained native intent refuses recovery');}
 const d=await get('/api/native/central/tasks/'+task);
 insist(d?.authority==='native'&&d.verified===true&&d.active===true&&d.task?.id===task&&d.task.project===project&&d.project?.id===project&&d.project.state==='active'&&d.project.safety_halted===false&&typeof d.joined==='boolean'&&openFunded(d.task)&&d.availability?.available!==false&&typeof d.task.criteria==='string'&&sha(d.task.criteria)===d.task.acceptance_digest,'Fresh open funded exact task required');
 const journal=await journalCheck(project,task);insist(journal?.complete===true&&journal.relatedEntries===0,'Complete unused native journal required');
 for(const p of [status.proof,absent.proof,d.proof])freshNativeProof(p,now());insist(BigInt(d.proof.height)>=BigInt(absent.proof.height),'Task observation precedes absence');
 return{schema:'uain-house-recovery-check-v1',member,task:d.task,project:d.project,joined:d.joined,submissionId:submission,submissionAbsent:true,intentIndexComplete:true,intentCount:index.intents.length,journal,proof:d.proof,absenceProof:absent.proof,checkedAt:new Date(now()).toISOString()};
}
const journalObject=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const journalKeys=(v,keys)=>journalObject(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const journalText=v=>typeof v==='string'&&v.isWellFormed()&&v.length>0&&Buffer.byteLength(v)<=20000;
function centralJournalPayload(operation,payload){
 insist(['project_join','central_submit'].includes(operation),'Unknown central journal operation');
 const wanted=operation==='project_join'?payloadFor('join',payload):payloadFor('submit',{task:payload?.task,submission:payload?.id,evidence:payload?.evidence});
 insist(journalKeys(payload,Object.keys(wanted))&&Object.keys(wanted).every(k=>wanted[k]===payload[k]),'Unknown central journal payload');
}
function journalEnvelope(e,operations){
 insist(journalKeys(e,['command','public_key','signature'])&&journalText(e.public_key)&&journalText(e.signature)&&journalObject(e.command)&&e.command.chain_id===PINS.chainId&&MEMBER.test(e.command.member??'')&&operations.includes(e.command.operation)&&journalObject(e.command.payload)&&Object.keys(e.command.payload).length>0,'Unknown journal envelope');
 if(['project_join','central_submit'].includes(e.command.operation))centralJournalPayload(e.command.operation,e.command.payload);
}
function walletJournalIntent(v){
 insist(journalKeys(v,['id','operation','amount','agreement','reviewer','owner','recipient'])&&INTENT.test(v.id??'')&&['coin_shield','private_payment'].includes(v.operation)&&uint(v.amount)&&journalKeys(v.agreement,['text','salt'])&&journalText(v.agreement.text)&&HASH.test(v.agreement.salt??'')&&journalObject(v.owner)&&MEMBER.test(v.owner.member??'')&&journalText(v.owner.publicKey)&&MEMBER.test(v.reviewer??'')&&(v.recipient===null||journalObject(v.recipient)&&MEMBER.test(v.recipient.member??'')&&journalText(v.recipient.publicKey)),'Unknown holder intent metadata');
}
function classifyJournalRequest(v){
 insist(journalObject(v),'Unknown journal request');const keys=Object.keys(v).sort().join(',');
 if(keys==='commandDigest,intentId,operation,payload'){insist(HASH.test(v.commandDigest??'')&&INTENT.test(v.intentId??''),'Unknown signing claim');centralJournalPayload(v.operation,v.payload);return{kind:'signature',request:v};}
 if(keys==='body,method,path'){
  insist(v.method==='POST'&&typeof v.path==='string'&&v.path.length<=256&&journalObject(v.body),'Unknown journal HTTP request');
  const id='[a-f0-9-]{36}',normalized=v.path.replace(new RegExp('/'+id+'(?=/|$)','g'),'/:id');
  const rules={
   '/api/account':[{displayName:'text'},'account'],
   '/api/native/enrol/prepare':[{clientRequestId:'text',name:'text',operator:'text',family:'text'},'intent'],
   '/api/native/enrol/:id/submit':[{envelope:'enrol-envelope'},'intent'],
   '/api/native/central/prepare':[{operation:'text',payload:'object'},'intent'],
   '/api/native/central/intents/:id/submit':[{envelope:'central-envelope'},'intent'],
   '/api/native/central/intents/:id/reconcile':[{},'intent'],
   '/api/trade/offers':[{clientRequestId:'text',title:'text',description:'text',price:'text',publish:'boolean'},'offer'],
   '/api/trade/offers/:id/enquiries':[{clientRequestId:'text',expectedRevision:'integer',message:'text'},'enquiry'],
   '/api/trade/enquiries/:id/terms':[{clientRequestId:'text',terms:'terms'},'draft'],
   '/api/trade/terms/:id/send':[{clientRequestId:'text',confirmNonbinding:'boolean',expectedRevision:'integer'},'proposal'],
   '/api/trade/terms/:id/payment-request':[{clientRequestId:'text',snapshotDigest:'hash',confirmPaymentRequest:'boolean'},'request'],
   '/api/messages/conversations':[{clientRequestId:'text',to:'member'},'conversation'],
   '/api/messages/conversations/:id/messages':[{body:'text',clientRequestId:'text'},'message'],
   '/api/requests/:id/pay':[{expectedTradeDigest:'hash',confirmTradeReview:'boolean'},'intent'],
   '/api/native/payments/:id/agree':[{purposeCommitment:'hash',signature:'text'},'intent'],
   '/api/native/payments/:id/recover':[{envelope:'wallet-envelope',reviewerBinding:'object'},'intent'],
   '/api/native/payments/:id/confirm':[{effects:'hash',chainId:'chain',requestDigest:'hash',locallyInspected:'boolean',signature:'text'},'intent']
  },rule=rules[normalized];insist(rule&&journalKeys(v.body,Object.keys(rule[0])),'Unclassified journal HTTP route/body');
  for(const [key,type]of Object.entries(rule[0])){const value=v.body[key];if(type==='text')insist(journalText(value));else if(type==='hash')insist(HASH.test(value??''));else if(type==='chain')insist(value===PINS.chainId);else if(type==='member')insist(MEMBER.test(value??''));else if(type==='boolean')insist(typeof value==='boolean');else if(type==='integer')insist(Number.isSafeInteger(value)&&value>=0);else if(type==='object')insist(journalObject(value)&&Object.keys(value).length>0);else if(type==='terms')insist(journalKeys(value,['scope','deliverables','timeline','acceptanceCriteria','price'])&&Object.values(value).every(journalText));else journalEnvelope(value,type==='central-envelope'?['project_join','central_submit']:type==='enrol-envelope'?['enrol']:['coin_shield','private_payment']);}
  if(normalized==='/api/native/central/prepare')centralJournalPayload(v.body.operation,v.body.payload);
  return{kind:'http',primary:rule[1],path:normalized,request:v};
 }
 if(keys==='intent,source'||keys==='intent,output'){
  walletJournalIntent(v.intent);if(keys==='intent,source')insist(v.source===null||journalKeys(v.source,['kind','id','position'])&&journalText(v.source.kind)&&journalText(v.source.id)&&(typeof v.source.position==='string'&&uint(v.source.position)||Number.isSafeInteger(v.source.position)&&v.source.position>=0),'Unknown holder proof source');
  else{insist(journalKeys(v.output,['effects','envelope'])&&journalText(v.output.effects),'Unknown holder proof output');journalEnvelope(v.output.envelope,['coin_shield','private_payment']);}return{kind:'holder',request:v};
 }
 if(keys==='envelope,paymentId'){insist(INTENT.test(v.paymentId??''));journalEnvelope(v.envelope,['private_payment']);return{kind:'holder',request:v};}
 if(keys==='keys'){insist(Array.isArray(v.keys)&&v.keys.length>=1&&v.keys.length<=128&&v.keys.every(k=>journalText(k)&&k.length<=512));return{kind:'native-read',request:v};}
 if(keys==='conversationId,reportDigest'){insist(INTENT.test(v.conversationId??'')&&HASH.test(v.reportDigest??''));return{kind:'delivery',request:v};}
 if(keys==='amountUnits,payer'||keys==='paymentId,tradeDigest'||keys==='amountUnits,payer,paymentId,purposeSchema,requestDigest,tradeDigest'){
  if(Object.hasOwn(v,'amountUnits'))insist(uint(v.amountUnits)&&MEMBER.test(v.payer??''));if(Object.hasOwn(v,'paymentId'))insist(INTENT.test(v.paymentId??'')&&HASH.test(v.tradeDigest??''));if(Object.hasOwn(v,'purposeSchema'))insist(journalText(v.purposeSchema)&&HASH.test(v.requestDigest??''));return{kind:'holder-intent',request:v};
 }
 throw Error('Unclassified journal request');
}
function classifyJournalResponse(value,context,{canonical,verifyCentralEnvelope}){
 insist(journalObject(value)&&Object.keys(value).length>0,'Unclassifiable journal response');
 if(context.kind==='signature'){insist(journalKeys(value,['command','public_key','signature'])&&typeof verifyCentralEnvelope==='function','Native journal signature verifier required');verifyCentralEnvelope(value,{chainId:PINS.chainId,operations:['project_join','central_submit']});insist(value.command.operation===context.request.operation&&canonical(value.command.payload)===canonical(context.request.payload),'Journal envelope differs from signing claim');return;}
 if(context.kind==='holder-intent'){walletJournalIntent(value);return;}
 if(context.kind==='holder'){insist(journalKeys(value,['operation'])&&journalObject(value.operation)&&INTENT.test(value.operation.id??''),'Unknown holder operation response');return;}
 if(context.kind==='delivery'){insist(journalKeys(value,['conversationId','recipientReadback','reportDigest'])&&value.conversationId===context.request.conversationId&&value.reportDigest===context.request.reportDigest&&value.recipientReadback===true,'Unknown delivery readback');return;}
 if(context.kind==='native-read'){insist(journalKeys(value,['app_hash','chain_id','event_count','header_time','height','queries','records','signed_header'])&&value.chain_id===PINS.chainId&&uint(value.height)&&HASH.test(value.app_hash??'')&&journalObject(value.records)&&Array.isArray(value.queries)&&journalObject(value.signed_header),'Unknown native read response');return;}
 insist(context.kind==='http'&&journalObject(value[context.primary])&&Object.keys(value[context.primary]).length>0&&Object.keys(value).every(k=>[context.primary,'created','attempted','settled','workflow','nativeStatus'].includes(k)),'Unknown journal HTTP response');
 for(const key of ['created','attempted','settled'])if(Object.hasOwn(value,key))insist(typeof value[key]==='boolean');
 if(context.path.startsWith('/api/native/central/')){const i=value.intent;insist(INTENT.test(i.id??'')&&MEMBER.test(i.member??'')&&HASH.test(i.commandDigest??'')&&journalObject(i.command)&&i.command.chain_id===PINS.chainId&&i.command.member===i.member,'Unknown central intent response');centralJournalPayload(i.command.operation,i.command.payload);if(context.path==='/api/native/central/prepare')insist(i.command.operation===context.request.body.operation&&canonical(i.command.payload)===canonical(context.request.body.payload),'Prepared journal command differs');if(context.path.endsWith('/submit'))insist(canonical(i.command)===canonical(context.request.body.envelope.command),'Submitted journal command differs');}
}

export async function recoveryJournal(journal,project,task,{uid=RUNTIME_UID,gid=RUNTIME_GID,canonical,verifyCentralEnvelope}={}){
 insist(typeof canonical==='function','Existing journal canonical verifier required');const records=new Map();
 const prefixes=[journalPrefix('join',{project}),journalPrefix('submit',{task})];let entries=0,relatedEntries=0,totalBytes=0;const observed=new Map(),auditReferences=[];
 const related=text=>[project,task,...prefixes].some(v=>text.includes(v));
 async function metadata(path,name,s){
  // Opaque archives/backups and unknown files never establish absence. Read
  // only the frozen once JSON record kinds and explicit recovery audit metadata.
  const match=/^[a-z0-9_-]{1,90}\.(request|receipt)\.json$/.exec(name);insist(match||name==='AUDIT.json','Unsupported journal metadata');
  insist(s.size<=1048576&&(totalBytes+=s.size)<=8388608,'Journal metadata bytes exceeded');const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let value,bytesDigest;
  try{const current=await fd.stat();insist(current.ino===s.ino&&current.dev===s.dev&&current.uid===uid&&current.gid===gid&&current.nlink===1&&(current.mode&0o777)===0o600&&current.size===s.size,'Journal metadata changed');const bytes=Buffer.alloc(s.size+1);let count=0;while(count<bytes.length){const r=await fd.read(bytes,count,bytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}insist(count===s.size,'Journal metadata changed');bytesDigest=sha(bytes.subarray(0,count));try{value=JSON.parse(bytes.subarray(0,count).toString('utf8'));}catch{throw Error('Invalid journal metadata JSON');}}finally{await fd.close();}
  insist(value&&typeof value==='object'&&!Array.isArray(value),'Unknown journal metadata');
  if(match){const kind=match[1]==='request'?'request':'response';insist(Object.keys(value).sort().join(',')===[kind,'fingerprint'].sort().join(',')&&HASH.test(value.fingerprint??'')&&value[kind]&&typeof value[kind]==='object'&&!Array.isArray(value[kind]),'Unknown frozen journal shape');if(kind==='request'){const context=classifyJournalRequest(value.request);insist(sha(canonical(value.request))===value.fingerprint,'Journal request fingerprint differs');records.set(path,{...value,context});}else records.set(path,value);}
  else{const keys=Object.keys(value).sort().join(',');insist(value.schema==='uain-controlled-journal-recovery-v1'&&['at,by,files,reason,schema','archived,at,by,reason,retained,schema'].includes(keys)&&typeof value.at==='string'&&typeof value.by==='string'&&typeof value.reason==='string','Unknown recovery audit shape');if(value.files){insist(typeof value.files==='object'&&!Array.isArray(value.files)&&Object.entries(value.files).length<=1000&&Object.entries(value.files).every(([k,v])=>/^[a-z0-9_-]{1,90}\.(request|receipt)\.json$/.test(k)&&HASH.test(v)),'Unknown recovery audit references');for(const [name,digest]of Object.entries(value.files))auditReferences.push({path:join(dirname(path),name),digest});}else insist(Array.isArray(value.archived)&&Array.isArray(value.retained)&&value.archived.length+value.retained.length<=1000&&[...value.archived,...value.retained].every(v=>typeof v==='string'&&/^[a-z0-9_-]{1,90}(?:\.(request|receipt)\.json)?$/.test(v)),'Unknown recovery audit references');}
  observed.set(path,bytesDigest);return related(JSON.stringify(value));
 }
 async function walk(dir,depth){insist(depth<=8,'Journal depth exceeded');const ds=await lstat(dir);insist(ds.isDirectory()&&!ds.isSymbolicLink()&&ds.uid===uid&&ds.gid===gid&&(ds.mode&0o777)===0o700&&await realpath(dir)===dir,'Private journal directory required');for(const name of await readdir(dir)){insist(++entries<=10000,'Journal bound exceeded');const p=join(dir,name),s=await lstat(p);insist(!s.isSymbolicLink()&&s.uid===uid&&s.gid===gid&&!(s.mode&0o077)&&await realpath(p)===p,'Unsafe journal metadata');const named=prefixes.some(v=>name.startsWith(v));if(s.isDirectory()){if(named)relatedEntries++;await walk(p,depth+1);}else{insist(s.isFile()&&s.nlink===1,'Unknown journal entry');const contains=await metadata(p,name,s);if(named||contains)relatedEntries++;}}}
 await walk(journal,0);for(const [path,record]of records){if(!path.endsWith('.receipt.json'))continue;const request=records.get(path.replace(/\.receipt\.json$/,'.request.json'));insist(request?.context&&record.fingerprint===request.fingerprint,'Unpaired journal receipt');classifyJournalResponse(record.response,request.context,{canonical,verifyCentralEnvelope});}insist(auditReferences.every(r=>observed.get(r.path)===r.digest),'Incomplete or changed recovery archive references');return{complete:true,relatedEntries,entries};
}

const VALUE_FLAGS=['--run','--project','--task','--submission','--evidence'];
const NEEDS={inspect:[],tasks:[],'submission-status':['--submission'],'recovery-check':['--project','--task','--submission'],join:['--project'],'receipt-join':['--project'],submit:['--task','--submission','--evidence'],'receipt-submit':['--task','--submission','--evidence']};
/** Strict arguments: no unknown or repeated flags, IDs validated, nothing inferred. */
export function parseArgs(argv){
 const [mode,...rest]=argv;insist(MODES.includes(mode),'Choose inspect, tasks, submission-status, recovery-check, join, submit, receipt-join or receipt-submit');
 const flags={};
 for(let i=0;i<rest.length;i++){
  const f=rest[i];insist(!Object.hasOwn(flags,f),'Repeated argument');
  if(f==='--execute-production'){flags[f]=true;continue;}
  insist(VALUE_FLAGS.includes(f)&&typeof rest[i+1]==='string'&&!rest[i+1].startsWith('-'),'Unknown or incomplete argument');flags[f]=rest[++i];
 }
 const allowed=new Set([...NEEDS[mode],...(mode==='inspect'?[]:['--run']),...(['inspect','tasks','submission-status','recovery-check'].includes(mode)?[]:['--execute-production'])]);
 insist(Object.keys(flags).every(f=>allowed.has(f)),'Argument not allowed for this mode');
 insist(NEEDS[mode].every(f=>Object.hasOwn(flags,f)),'Required argument missing');
 if(!['inspect','tasks','submission-status','recovery-check'].includes(mode))insist(flags['--execute-production']===true,'Explicit --execute-production required');
 const run=flags['--run']??DEFAULT_RUN;insist(isAbsolute(run)&&resolve(run)===run,'Absolute normalized --run required');
 if(flags['--project'])validId(flags['--project'],'project');
 if(flags['--task'])validId(flags['--task'],'task');
 if(flags['--submission'])validId(flags['--submission'],'submission');
 if(flags['--evidence'])insist(isAbsolute(flags['--evidence'])&&resolve(flags['--evidence'])===flags['--evidence'],'Absolute normalized --evidence required');
 return{mode,run,project:flags['--project'],task:flags['--task'],submission:flags['--submission'],evidencePath:flags['--evidence'],executeProduction:flags['--execute-production']===true};
}

async function ownedDir(path){const s=await lstat(path);insist(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===RUNTIME_UID&&s.gid===RUNTIME_GID&&(s.mode&0o777)===0o700&&await realpath(path)===path,'Runtime owner-only directory required');}
async function privateRead(path,limit=1048576){
 insist(resolve(path)===path&&await realpath(path)===path,'Exact runtime path required');
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await h.stat(),named=await lstat(path);insist(s.isFile()&&s.uid===RUNTIME_UID&&s.gid===RUNTIME_GID&&(s.mode&0o777)===0o600&&s.nlink===1&&s.ino===named.ino&&s.dev===named.dev&&s.size<=limit,'Runtime owner-only 600 regular file required');return await h.readFile();}
 finally{await h.close();}
}
async function bounded(response){
 insist(response.body&&Number(response.headers.get('content-length')??0)<=1048576,'Bounded response required');
 const parts=[];let size=0;for await(const b of response.body){size+=b.length;insist(size<=1048576,'Bounded response required');parts.push(b);}
 const value=JSON.parse(Buffer.concat(parts).toString());insist(response.ok,`HTTP ${response.status}: request refused; no automatic retry`);return value;
}
const POST_PATH=p=>p===PREPARE||/^\/api\/native\/central\/intents\/[a-f0-9-]{36}\/(submit|reconcile)$/.test(p);
const GET_PATH=p=>p==='/api/native/central/intents'||/^\/api\/native\/central\/submissions\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(p)||/^\/api\/native\/central\/survey-template\/T-OPP-[0-9]{5}-1-prior-art-survey(?:-r[2-9]-p[1-9][0-9]?)?$/.test(p)||p==='/api/native/central/status'||/^\/api\/native\/central\/tasks\?cursor=(0|[1-9][0-9]{0,19})&limit=12$/.test(p)||(p.startsWith('/api/native/central/tasks/')&&ID.test(p.slice(26)));

export async function cli(argv){
 const a=parseArgs(argv);
 if(a.mode==='inspect')return{preparedOnly:true,productionWrites:0,controlledBySameOperator:true,outsideAdoption:false,defaultRun:DEFAULT_RUN,modes:MODES,
  requires:'enabled central feature, approved Fund Manager plan, a real open funded task, and genuinely new independently checked evidence; explicit --execute-production for writes'};
 insist(process.getuid()===RUNTIME_UID&&process.getgid()===RUNTIME_GID,'Run as the holder runtime user 501:20');
 for(const p of [dirname(a.run),a.run,join(a.run,'payer'),join(a.run,'journal')])await ownedDir(p);
 const driverPath=join(CODE,'ops/qualification/baink-earned-service-transaction.mjs');
 const fd=await open(driverPath,constants.O_RDONLY|constants.O_NOFOLLOW);let driverBytes;
 try{const s=await fd.stat();insist(s.isFile()&&s.nlink===1&&!(s.mode&0o022)&&s.size<=1048576&&await realpath(driverPath)===driverPath);driverBytes=await fd.readFile();}finally{await fd.close();}
 insist(sha(driverBytes)===DRIVER_SHA,'Frozen driver hash differs');
 const driver=await import(pathToFileURL(driverPath));
 const {canonical}=await import(pathToFileURL(join(CODE,'apps/baink/web/identity.js')));
 const {verifyCentralEnvelope}=await import(pathToFileURL(join(CODE,'apps/baink/server/central-earning-command.mjs')));
 const config=driver.validateConfiguration(JSON.parse((await privateRead(join(a.run,'configuration.json'))).toString()));insist(config.origin===ORIGIN,'Exact origin required');
 const key=createPrivateKey({key:await privateRead(join(a.run,'payer/identity.pk8'),4096),format:'der',type:'pkcs8'});
 const raw=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32),member='uain1'+sha(raw).slice(0,40);
 const identities=JSON.parse((await privateRead(join(a.run,'public-identities.json'))).toString());
 insist(identities.payer?.member===member&&identities.payer.publicKey===raw.toString('base64url'),'Controlled agent identity differs');
 const request=async(path,{method,body})=>{
  insist(method==='GET'?GET_PATH(path):method==='POST'&&POST_PATH(path),'Path not allowed');
  const timestamp=String(Date.now()),nonce=randomBytes(24).toString('base64url');
  const signature=sign(null,Buffer.from(canonical({audience:ORIGIN,method,path,body,nonce,timestamp})),key).toString('base64');
  return bounded(await fetch(ORIGIN+path,{method,headers:{Origin:ORIGIN,'Content-Type':'application/json',Accept:'application/json','X-BAINK-Public-Key':raw.toString('base64'),'X-BAINK-Timestamp':timestamp,'X-BAINK-Nonce':nonce,'X-BAINK-Signature':signature},
   ...(method==='GET'?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(65000)}));
 };
 if(a.mode==='tasks')return listTasks(path=>request(path,{method:'GET',body:{}}),member);
 if(a.mode==='submission-status')return submissionStatus(path=>request(path,{method:'GET',body:{}}),member,a.submission);
 if(a.mode==='recovery-check'){const report=await recoveryCheck(path=>request(path,{method:'GET',body:{}}),member,a,{journalCheck:(project,task)=>recoveryJournal(join(a.run,'journal'),project,task,{canonical,verifyCentralEnvelope})});return{...report,adapterSourceSha256:await adapterSourceDigest()};}
 let evidence;
 if(a.evidencePath){const bytes=await privateRead(a.evidencePath,MAX_EVIDENCE_BYTES);evidence=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);insist(Buffer.from(evidence,'utf8').equals(bytes),'Evidence UTF-8 roundtrip differs');}
 const journal=join(a.run,'journal');
 const load=async(name,expected)=>{
  insist(/^house-(join|submit)-[a-f0-9]{32}-(prepare|envelope)$/.test(name),'Unknown journal');
  const claim=JSON.parse((await privateRead(join(journal,name+'.request.json'))).toString()),receipt=JSON.parse((await privateRead(join(journal,name+'.receipt.json'))).toString());
  insist(claim.fingerprint===sha(canonical(claim.request))&&receipt.fingerprint===claim.fingerprint&&canonical(claim.request)===canonical(expected),'Retained journal binding differs');
  return receipt.response;
 };
 return execute(a.mode,{executeProduction:a.executeProduction,member,project:a.project,task:a.task,submission:a.submission,evidence,journal},{
  once:driver.once,load,http:(path,{method,body})=>request(path,{method,body}),
  sign:(intent,review)=>driver.signCentralFromRuntime(a.run,intent,review),
  verifyEnvelope:e=>verifyCentralEnvelope(e,{chainId:PINS.chainId,operations:['project_join','central_submit']}),
  wait:ms=>new Promise(r=>setTimeout(r,ms))});
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await cli(process.argv.slice(2))));}
 catch(error){
  // Only fixed refusal text: errors may never carry keys, evidence or headers.
  const known=/^(Invalid (project|task|submission|ID) ID|Exact nonempty UTF-8 evidence.*|Explicit --execute-production required|Choose .*|Unknown or incomplete argument|Repeated argument|Argument not allowed for this mode|Required argument missing|Uncertain operation.*|Journal request changed|HTTP \d{3}: request refused; no automatic retry)$/.test(error?.message??'');
  console.error(JSON.stringify({refused:true,reason:known?error.message:'stopped',message:'House agent stopped; inspect owner-only journals and reconcile the exact retained intent. No retry or ID rotation.'}));
  process.exitCode=1;
 }
}
