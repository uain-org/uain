import{ReviewError}from'./errors.mjs';
/** Source-only, non-networked gateway prototype. Caller identity MUST be supplied
 * by the existing verified signed-HTTP handler, never parsed from a request body.
 * The vault MUST be a separately permissioned encrypted durable store. The adapter
 * is operator-configured fixed custody/model code; no client attest/tool API. */
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJSON,memberAddress} from '../server/native-financial-command.mjs';
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};
export const reviewGatewayReceiptBytes=payload=>Buffer.from('BAINK/public-review-gateway-receipt/v1\n'+canonicalJSON(payload));
const HASH=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9_-]{8,100}$/;
const exact=(v,ks)=>v!==null&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const check=(ok,code)=>{if(!ok)throw new ReviewError('review_gateway_'+code);};
const digest=value=>createHash('sha256').update(canonicalJSON(value)).digest('hex');
const transitions={create:['new','created'],certificate:['created','certified'],ingest:['certified','ingested'],review:['ingested','reviewed'],relay:['reviewed','relayed'],reconcile:['relayed','reconciled']};
/** Archive (12 November 2026, P1-2): with an `archive` store, maxJobs (and maxJobs*8 operations)
 * bound the ACTIVE file only. Once it holds `archiveJobs` jobs, the oldest finished jobs (phase
 * reconciled, refused, owned-approved or abandoned, nothing pending, every operation completed or
 * cancelled) move out: their records are copied to the archive first, then their adapter jobs and
 * sealed files move to the adapter's archive and the vault archive, and only then are they removed
 * from the active file. Nothing is deleted. A repeated request id still returns its original
 * receipt, a locator lookup, status, artifact or recovery read still finds the job, and an archived
 * job never takes a new operation, so no work is ever sent twice. Without an archive the old bound stays. */
const FINAL=['reconciled','refused','owned-approved','abandoned'];
export function createReviewGateway({store,vault,native,adapter,pins,signReceipt,clock=Date.now,maxQueued=16,maxJobs=1000,maxOwnerActive=2,maxReviewsDaily=24,maxDeferrals=8,maxReconciliations=3,canExecute=()=>true,onError,archive=null,archiveJobs=Math.min(256,maxJobs)}){
 pins=deepFreeze(structuredClone(pins));
 check(pins&&HASH.test(pins.genesisSha256)&&HASH.test(pins.verifierSha256)&&typeof pins.chainId==='string'&&Buffer.from(pins.reviewerPublicKey,'base64url').length===32,'pins');
 check(Number.isInteger(maxQueued)&&maxQueued>0&&maxQueued<=64&&Number.isInteger(maxJobs)&&maxJobs>0&&maxJobs<=10000&&Number.isInteger(maxOwnerActive)&&maxOwnerActive>0&&maxOwnerActive<=8&&Number.isInteger(maxReviewsDaily)&&maxReviewsDaily>0&&maxReviewsDaily<=1000,'limits');
 check(typeof canExecute==='function','executor');let executing=false,activeOperation=null;const recoveries=new Map();
 check(archive===null||typeof archive?.read==='function'&&typeof archive.transact==='function'&&Number.isInteger(archiveJobs)&&archiveJobs>=2&&archiveJobs<=maxJobs,'limits');
 // In-memory index of the archive, built once from its durable state; this gateway is its only writer.
 let index=null;const requestKey=(owner,id)=>owner+'\n'+id;
 function archived(){if(!archive)return null;if(index)return index;const a=archive.read(),next={requests:new Map(),contexts:new Map(),ops:new Map()};for(const o of Object.values(a.operations??{}))indexOp(next,o);for(const j of Object.values(a.jobs??{}))indexJob(next,j);return index=next;}
 function indexOp(i,o){i.requests.set(requestKey(o.owner,o.clientRequestId),o.id);if(!i.ops.has(o.jobId))i.ops.set(o.jobId,[]);if(!i.ops.get(o.jobId).includes(o.id))i.ops.get(o.jobId).push(o.id);}
 function indexJob(i,j){const k=requestKey(j.owner,j.contextDigest);if(!i.contexts.has(k))i.contexts.set(k,[]);if(!i.contexts.get(k).includes(j.id))i.contexts.get(k).push(j.id);}
 const archivedJob=id=>archive?archive.read().jobs?.[id]??null:null;
 const archivedOps=id=>{const ids=archive?archived().ops.get(id)??[]:[];if(!ids.length)return[];const all=archive.read().operations??{};return ids.map(k=>all[k]).filter(Boolean);};
 const archivedRequest=(owner,clientRequestId)=>{const id=archive?archived().requests.get(requestKey(owner,clientRequestId)):undefined;return id?archive.read().operations?.[id]??null:null;};
 const finishedAt=(job,ops)=>Math.max(job.abandonedAt??0,...ops.map(o=>o.completedAt??o.cancelledAt??o.recoveredAt??o.createdAt??0));
 let compacting=null;
 function compact(){if(!archive)return Promise.resolve(0);if(compacting)return compacting;compacting=(async()=>{
  const db=store.read(),jobs=Object.values(db.jobs??{}),byJob=new Map();for(const o of Object.values(db.operations??{})){if(!byJob.has(o.jobId))byJob.set(o.jobId,[]);byJob.get(o.jobId).push(o);}
  const opCount=Object.keys(db.operations??{}).length;if(jobs.length<archiveJobs&&opCount<archiveJobs*6)return 0;
  const busy=new Set([activeOperation,...[...recoveries.keys()]]);
  const done=jobs.filter(j=>{const ops=byJob.get(j.id)??[];return FINAL.includes(j.phase)&&j.pending===null&&!recoveries.has(j.id)&&ops.every(o=>['completed','cancelled'].includes(o.status)&&!busy.has(o.id));}).sort((a,b)=>finishedAt(a,byJob.get(a.id)??[])-finishedAt(b,byJob.get(b.id)??[])||(a.id<b.id?-1:1)).slice(0,Math.max(0,jobs.length-Math.floor(archiveJobs/2)));
  if(!done.length)return 0;
  const moved=new Set(),same=(x,y)=>canonicalJSON(x)===canonicalJSON(y);
  try{await archive.transact(a=>{a.jobs??={};a.operations??={};for(const j of done){const ops=byJob.get(j.id)??[];if(a.jobs[j.id]&&!same(a.jobs[j.id],j)||ops.some(o=>a.operations[o.id]&&!same(a.operations[o.id],o)))continue;a.jobs[j.id]??=j;for(const o of ops)a.operations[o.id]??=o;moved.add(j.id);}});
   if(index)for(const j of done)if(moved.has(j.id)){for(const o of byJob.get(j.id)??[])indexOp(index,o);indexJob(index,j);}}catch(e){index=null;throw e;}
  const list=done.filter(j=>moved.has(j.id));if(!list.length)return 0;
  if(typeof adapter.archive==='function')await adapter.archive(list.map(j=>({jobId:j.id,owner:j.owner,publicKey:j.publicKey,contextDigest:j.contextDigest})));
  if(vault.archives===true)await vault.archive(list.flatMap(j=>(byJob.get(j.id)??[]).flatMap(o=>[{id:o.id,owner:j.owner},{id:o.id+':result',owner:j.owner}])));
  return store.transact(d=>{let n=0;for(const j of list){const cur=d.jobs?.[j.id],ops=Object.values(d.operations??{}).filter(o=>o.jobId===j.id),before=byJob.get(j.id)??[];if(!cur||!same(cur,j)||ops.length!==before.length||!ops.every(o=>before.some(b=>b.id===o.id&&same(b,o))))continue;delete d.jobs[j.id];for(const o of ops)delete d.operations[o.id];n++;}return n;});
 })().finally(()=>{compacting=null;});return compacting;}
 function identity(user){const key=user?.publicKey,raw=typeof key==='string'?Buffer.from(key,'base64url'):Buffer.alloc(0);check(raw.length===32&&raw.toString('base64url')===key&&memberAddress(raw)===user.address,'identity');return Object.freeze({address:user.address,publicKey:key});}
 async function licensed(user,requireActive=true){
  const {state,proof}=await native.publicState({member:user.address});const age=clock()-Date.parse(proof?.headerTime);
  check(proof?.authority==='native'&&proof.chainId===pins.chainId&&proof.epoch===pins.genesisSha256&&proof.verifierSha256===pins.verifierSha256&&Number.isFinite(age)&&age>=-60000&&Number.isInteger(proof.maxAgeSeconds)&&proof.maxAgeSeconds>=1&&proof.maxAgeSeconds<=120&&age<proof.maxAgeSeconds*1000&&HASH.test(proof.appHash??'')&&state?.app_hash===proof.appHash&&/^[1-9][0-9]{0,18}$/.test(proof.height??'')&&state?.chain_id===pins.chainId&&state.height===proof.height,'proof');
  check(state.member?.id===user.address&&state.member.public_key===user.publicKey&&(!requireActive||state.member.licence==='active'),'licence');return {state,proof};
 }
 function bodyFor(action,body,state){
  if(action==='create'){
   check(exact(body,['context']),'body');const c=body.context;
   check(exact(c,['version','chain','expires','licenceRevision','effects','purpose','reviewer'])&&c.version===1&&c.chain===pins.chainId&&c.reviewer===Buffer.from(pins.reviewerPublicKey,'base64url').toString('hex')&&HASH.test(c.effects)&&HASH.test(c.purpose)&&/^(0|[1-9][0-9]{0,19})$/.test(c.licenceRevision??'')&&BigInt(c.licenceRevision)<=18446744073709551615n&&/^[1-9][0-9]{0,18}$/.test(c.expires??'')&&BigInt(c.expires)>BigInt(state.height)&&BigInt(c.expires)<=BigInt(state.height)+1000n,'context');
  }else if(action==='ingest')check(exact(body,['envelope','agreedInvoice','purposeEvidence'])&&body.envelope&&typeof body.envelope==='object','body');
  else if(action==='relay')check(exact(body,['result','reviewerBinding'])&&body.result&&typeof body.result==='object'&&body.reviewerBinding&&typeof body.reviewerBinding==='object','body');
  else check(body===null,'body');
 }
 async function receipt(job,op=null){return signReceipt({schema:'baink-review-gateway-receipt-v1',chainId:pins.chainId,genesisSha256:pins.genesisSha256,verifierSha256:pins.verifierSha256,reviewerPublicKey:pins.reviewerPublicKey,contextDigest:job.contextDigest,jobId:job.id,owner:job.owner,phase:job.phase,operationId:op?.id??null,action:op?.action??null,status:op?.status??null,requestDigest:op?.requestDigest??null,resultDigest:op?.resultDigest??null,paid:false,nativeSettlementVerified:false,issuedAt:new Date(clock()).toISOString()});}
 function owned(user,id){const job=store.read().jobs?.[id]??archivedJob(id);check(job?.owner===user.address&&job.publicKey===user.publicKey,'missing');return job;}
 const opsOf=(db,id)=>{const live=Object.values(db.operations??{}).filter(o=>o.jobId===id);return(live.length||db.jobs?.[id])?live:archivedOps(id);};
 return {
  async submit(authenticatedIdentity,request){
   const user=identity(authenticatedIdentity);request=deepFreeze(structuredClone(request));check(exact(request,['clientRequestId','action','jobId','body']),'request');
   check(ID.test(request.clientRequestId)&&Object.hasOwn(transitions,request.action),'action');
   const wire=canonicalJSON(request);check(Buffer.byteLength(wire)<=2*1024*1024,'size');const requestDigest=digest(request);
   const existing=Object.values(store.read().operations??{}).find(o=>o.owner===user.address&&o.clientRequestId===request.clientRequestId)??archivedRequest(user.address,request.clientRequestId);
   if(existing){check(existing.requestDigest===requestDigest,'idempotency_conflict');return receipt(owned(user,existing.jobId),existing);}
   const {state}=await licensed(user,request.action!=='reconcile');bodyFor(request.action,request.body,state);
   const action=request.action;check(action==='create'?request.jobId===null:/^[a-f0-9]{32}$/.test(request.jobId??''),'job');
   const jobId=action==='create'?randomUUID().replaceAll('-',''):request.jobId, opId=randomUUID().replaceAll('-','');
   if(action!=='create')owned(user,jobId);
   if(action==='create'&&archive&&Object.keys(store.read().jobs??{}).length>=archiveJobs)await compact().catch(e=>onError?.(e));
   // Reserve bounded capacity before accepting any sealed blob. A staging record
   // cannot execute; a crash during sealing stays blocked for operator recovery.
   const reserved=await store.transact(db=>{
    db.jobs??={};db.operations??={};const ops=Object.values(db.operations),jobs=Object.values(db.jobs);
    const same=ops.find(o=>o.owner===user.address&&o.clientRequestId===request.clientRequestId)??archivedRequest(user.address,request.clientRequestId);
    if(same){check(same.requestDigest===requestDigest,'idempotency_conflict');return {job:db.jobs[same.jobId]??archivedJob(same.jobId),op:same};}
    check(ops.filter(o=>['staging','queued','running'].includes(o.status)).length<maxQueued&&ops.length<maxJobs*8,'capacity');
    let job=db.jobs[jobId];
    // A finished, archived job takes no new operation.
    if(!job&&action!=='create'){const old=archivedJob(jobId);check(old?.owner===user.address&&old.publicKey===user.publicKey,'missing');check(false,'phase');}
    if(action==='create'){
     check(jobs.length<maxJobs&&jobs.filter(j=>j.owner===user.address&&!['reconciled','refused','owned-approved','abandoned'].includes(j.phase)).length<maxOwnerActive,'capacity');
     job={id:jobId,owner:user.address,publicKey:user.publicKey,phase:'new',pending:null,contextDigest:digest(request.body.context),expires:request.body.context.expires};db.jobs[jobId]=job;
    }
    check(job?.owner===user.address&&job.publicKey===user.publicKey,'missing');check(job.pending===null,'pending');check(job.phase===transitions[action][0],'phase');
    const day=new Date(clock()).toISOString().slice(0,10);
    if(action==='review')check(ops.filter(o=>o.action==='review'&&o.day===day).length<maxReviewsDaily,'review_budget');
    const op={id:opId,jobId,owner:user.address,clientRequestId:request.clientRequestId,action,requestDigest,status:'staging',day,createdAt:clock(),resultDigest:null};db.operations[op.id]=op;job.pending=op.id;return {job,op};
   });
   if(reserved.op.id!==opId)return receipt(reserved.job,reserved.op);
   // Sealing happens before any external call. If the vault stays unavailable past its bounded
   // wait, the reservation is withdrawn completely, so the member can retry the SAME request id.
   try{await vault.put(opId,structuredClone(request.body),{owner:user.address});}catch(error){await store.transact(db=>{const op=db.operations[opId],job=db.jobs[jobId];if(op?.status!=='staging')return;delete db.operations[opId];if(job?.pending===opId){job.pending=null;if(action==='create'&&job.phase==='new')delete db.jobs[jobId];}});throw new ReviewError(error?.code==='review_vault_busy'?'review_vault_busy':'review_gateway_vault_unavailable');}
   const ready=await store.transact(db=>{check(db.operations[opId].status==='staging','phase');db.operations[opId].status='queued';return {job:db.jobs[jobId],op:db.operations[opId]};});return receipt(ready.job,ready.op);
  },
  // A locator read always signs the ORIGINAL create operation, never the latest
  // phase's request digest. It cannot reserve work or open any sealed artifact.
  async lookup(authenticatedIdentity,query){
   const user=identity(authenticatedIdentity);check(exact(query,['contextDigest','createRequestDigest'])&&[query.contextDigest,query.createRequestDigest].every(v=>typeof v==='string'&&HASH.test(v)),'missing');
   const db=store.read(),active=Object.entries(db.jobs??{}),operations=Object.entries(db.operations??{});
   check(active.length<=maxJobs&&operations.length<=maxJobs*8,'missing');
   const old=archive?(archived().contexts.get(requestKey(user.address,query.contextDigest))??[]).filter(id=>!db.jobs?.[id]).map(id=>[id,archivedJob(id)]):[];
   for(const[id]of old)operations.push(...archivedOps(id).map(o=>[o.id,o]));
   const jobs=[...active,...old];
   const matches=jobs.filter(([,j])=>j?.owner===user.address&&j.publicKey===user.publicKey&&j.contextDigest===query.contextDigest);
   check(matches.length===1,'missing');const [id,job]=matches[0];
   check(/^[a-f0-9]{32}$/.test(id)&&job.id===id&&['new','created','certified','ingested','reviewed','relayed','reconciled','refused','owned-approved','abandoned','uncertain'].includes(job.phase)&&(job.pending===null||typeof job.pending==='string'&&/^[a-f0-9]{32}$/.test(job.pending))&&typeof job.expires==='string'&&/^[1-9][0-9]{0,18}$/.test(job.expires),'missing');
   const creates=operations.filter(([,o])=>o?.jobId===id&&o.action==='create');check(creates.length===1,'missing');const [opId,op]=creates[0];
   check(/^[a-f0-9]{32}$/.test(opId)&&op.id===opId&&op.owner===user.address&&typeof op.clientRequestId==='string'&&ID.test(op.clientRequestId)&&op.requestDigest===query.createRequestDigest&&(op.resultDigest===null||typeof op.resultDigest==='string'&&HASH.test(op.resultDigest))&&(op.status!=='completed'||HASH.test(op.resultDigest??''))&&['staging','queued','running','uncertain','completed','cancelled'].includes(op.status),'missing');
   return receipt(job,op);
  },
  async status(authenticatedIdentity,id){const user=identity(authenticatedIdentity),job=owned(user,id),db=store.read();return receipt(job,job.pending?db.operations[job.pending]:opsOf(db,id).at(-1)??null);},
  async artifact(authenticatedIdentity,id,action){
   const user=identity(authenticatedIdentity),job=owned(user,id);check(['certificate','review','relay'].includes(action),'artifact_unavailable');
   const op=opsOf(store.read(),id).find(o=>o.action===action&&o.status==='completed');check(op,'artifact_not_ready');
   const output=await vault.get(op.id+':result',{owner:user.address});check(output&&digest(output)===op.resultDigest&&(action==='review'?['reviewed','owned-approved'].includes(output.status):output.status===({certificate:'certified',relay:'relayed'}[action])),'artifact_binding');
   const keys={certificate:['certificate'],review:['approval','reviewerBinding'],relay:['envelope']}[action];check(exact(output.data,keys),'artifact_projection');
   const payload={schema:'baink-review-gateway-artifact-v1',chainId:pins.chainId,genesisSha256:pins.genesisSha256,verifierSha256:pins.verifierSha256,reviewerPublicKey:pins.reviewerPublicKey,contextDigest:job.contextDigest,jobId:id,owner:user.address,operationId:op.id,action,requestDigest:op.requestDigest,resultDigest:op.resultDigest,artifactDigest:digest(output.data),paid:false,nativeSettlementVerified:false,issuedAt:new Date(clock()).toISOString()};
   return {artifact:structuredClone(output.data),receipt:await signReceipt(payload)};
  },
  async recover(authenticatedIdentity,id){
   const user=identity(authenticatedIdentity),job=owned(user,id),db=store.read(),ops=opsOf(db,id);
   const original=job.pending?db.operations[job.pending]:ops.find(o=>o.action==='relay'&&o.status==='completed')??ops.find(o=>o.action==='review'&&o.status==='completed');
   check(['review','relay'].includes(original?.action),'recovery_unavailable');
   if(original.status==='completed')return receipt(job,original);
   check(['running','uncertain'].includes(original.status)&&activeOperation!==original.id,'recovery_busy');
   const recoverMethod=original.action==='relay'?'recoverRelay':'recoverReview';check(typeof adapter[recoverMethod]==='function','recovery_unavailable');
   if(recoveries.has(id))return recoveries.get(id);
   const work=(async()=>{
    const marker=await store.transact(state=>{const j=state.jobs[id],op=state.operations[original.id];check(j?.owner===user.address&&j.publicKey===user.publicKey&&j.pending===op?.id&&op.action===original.action&&op.requestDigest===original.requestDigest&&['running','uncertain'].includes(op.status),'recovery_binding');op.recoveryAttempts??=[];check(op.recoveryAttempts.length<32,'recovery_capacity');const attempt=op.recoveryAttempts.length;op.recoveryAttempts.push({at:clock(),status:'started'});return{job:j,op,attempt};});
    const body=await vault.get(marker.op.id,{owner:user.address});check((original.action!=='review'||body===null)&&digest({clientRequestId:marker.op.clientRequestId,action:original.action,jobId:id,body})===marker.op.requestDigest,'vault_binding');
    const scope={jobId:id,owner:user.address,publicKey:user.publicKey,contextDigest:marker.job.contextDigest};const output=await adapter[recoverMethod](deepFreeze(original.action==='relay'?{...scope,action:'relay',body,requestDigest:marker.op.requestDigest,pins:structuredClone(pins)}:scope));
    check(exact(output,['status','data'])&&(original.action==='relay'?['unknown','relayed']:['unknown','reviewed','owned-approved','refused']).includes(output.status),'recovery_output');
    if(output.status!=='unknown'){check(Buffer.byteLength(canonicalJSON(output))<=2*1024*1024,'size');await vault.put(marker.op.id+':result',output,{owner:user.address});}
    const result=await store.transact(state=>{const j=state.jobs[id],op=state.operations[marker.op.id];check(j?.owner===user.address&&j.publicKey===user.publicKey&&op.requestDigest===marker.op.requestDigest,'recovery_binding');if(op.status==='completed'){if(output.status!=='unknown')check(op.resultDigest===digest(output),'result_binding');return{job:j,op};}check(j.pending===op.id&&['running','uncertain'].includes(op.status),'recovery_binding');op.recoveryAttempts[marker.attempt].status=output.status==='unknown'?'unknown':'completed';if(output.status!=='unknown'){op.status='completed';op.resultDigest=digest(output);op.recoveredAt=clock();j.phase=output.status;j.pending=null;}return{job:j,op};});
    return receipt(result.job,result.op);
   })();recoveries.set(id,work);try{return await work;}finally{recoveries.delete(id);}
  },
  async abandon(authenticatedIdentity,id){
   const user=identity(authenticatedIdentity),known=owned(user,id);
   if(!store.read().jobs?.[id]){check(known.phase==='abandoned','abandon_unavailable');return receipt(known,archivedOps(id).at(-1)??null);}
   const result=await store.transact(state=>{const job=state.jobs[id];check(job?.owner===user.address&&job.publicKey===user.publicKey,'missing');const op=job.pending?state.operations[job.pending]:Object.values(state.operations??{}).filter(o=>o.jobId===id).at(-1)??null;if(job.phase==='abandoned')return{job,op};check(['new','created','certified','ingested'].includes(job.phase)&&(!job.pending||op?.status==='queued'),'abandon_unavailable');if(job.pending){op.status='cancelled';op.cancelledAt=clock();}job.phase='abandoned';job.pending=null;job.abandonedAt=clock();return{job,op};});return receipt(result.job,result.op);
  },
  /**
   * Bounded reconciliation of stalled operations, safe to call from the background tick.
   * - 'running' with no adapter-start marker, left by an earlier process: nothing external happened; requeue.
   * - 'running' or 'uncertain' whose adapter journal shows the step never started, or completed
   *   (execute then returns the cached sealed result): requeue at most maxReconciliations times.
   * - 'reconcile' steps are read-only and are always requeued within the bound.
   * Anything whose adapter journal says 'started' stays uncertain for review/relay recovery or an operator.
   */
  async reconcileStalled({limit=4}={}){
   if(executing)return [];check(Number.isInteger(limit)&&limit>0&&limit<=32,'limits');
   const db=store.read(),candidates=Object.values(db.operations??{}).filter(o=>(o.status==='uncertain'||o.status==='running'&&o.id!==activeOperation)&&!recoveries.has(o.jobId)&&(o.reconciliations??0)<maxReconciliations).slice(0,limit);
   const out=[];
   for(const c of candidates){
    if(executing)break;
    let safe=c.status==='running'&&!c.adapterStartedAt||c.action==='reconcile';
    if(!safe&&typeof adapter.journal==='function'){const state=adapter.journal({jobId:c.jobId,action:c.action});safe=state===null||state==='completed';}
    if(!safe)continue;
    const moved=await store.transact(state=>{const op=state.operations[c.id],job=state.jobs[c.jobId];if(executing||recoveries.has(c.jobId)||!op||op.status!==c.status||job?.pending!==op.id)return null;op.reconciliations=(op.reconciliations??0)+1;op.status='queued';op.reconciledFrom=c.status;delete op.adapterStartedAt;delete op.startedAt;if(job.phase==='uncertain')job.phase=transitions[op.action][0];return {job,op};});
    if(moved)out.push(moved.op.id);
   }
   return out;
  },
  /** Background compaction (see the archive note above); a no-op below `archiveJobs` active jobs. */
  compact,
  async runOne(){
   if(executing)return null;executing=true;
   try{
    const marker=await store.transact(db=>{const executionDay=new Date(clock()).toISOString().slice(0,10),operations=Object.values(db.operations??{}),reviewBudgetAvailable=operations.filter(v=>v.action==='review'&&v.executionDay===executionDay).length<maxReviewsDaily;const now=clock(),op=operations.find(o=>o.status==='queued'&&!(o.notBefore>now)&&(o.action!=='review'||reviewBudgetAvailable)&&canExecute(o.action));if(!op)return null;check(db.jobs[op.jobId]?.pending===op.id,'phase');op.executionDay=executionDay;op.status='running';op.startedAt=clock();return op;});
    if(!marker)return null;activeOperation=marker.id;
    // No retry of running/uncertain operations, including after process restart.
    // A crash between this persisted marker and adapter execution is deliberately
    // conservative: operator/native reconciliation is required before progress.
    let output,ok=false,stage='precondition',failure=null;
    try{
     const job=store.read().jobs[marker.jobId],user=identity({address:job.owner,publicKey:job.publicKey});
     let current;try{current=await licensed(user,marker.action!=='reconcile');}catch(error){throw error instanceof ReviewError?error:new ReviewError('review_gateway_native_unavailable');}
     if(marker.action!=='reconcile')check(BigInt(current.state.height)<BigInt(job.expires),'context_expired');
     const body=await vault.get(marker.id,{owner:user.address});check(digest({clientRequestId:marker.clientRequestId,action:marker.action,jobId:marker.action==='create'?null:marker.jobId,body})===marker.requestDigest,'vault_binding');
     const binding=deepFreeze({action:marker.action,jobId:marker.jobId,body,owner:user.address,publicKey:user.publicKey,requestDigest:marker.requestDigest,contextDigest:job.contextDigest,pins:structuredClone(pins)});
     // Durable marker: from here on the external adapter may have acted, so failures are uncertain.
     await store.transact(db=>{const op=db.operations[marker.id];check(op?.status==='running','phase');op.adapterStartedAt=clock();});stage='adapter';
     output=marker.action==='reconcile'?await adapter.reconcileReadOnly(binding):await adapter.execute(binding);
     const allowed={create:['created'],certificate:['certified'],ingest:['ingested'],review:['reviewed','refused','owned-approved'],relay:['relayed'],reconcile:['recorded','expired-unused','unknown']};check(exact(output,['status','data'])&&allowed[marker.action].includes(output.status)&&Buffer.byteLength(canonicalJSON(output))<=2*1024*1024,'output');
     stage='result';await vault.put(marker.id+':result',output,{owner:marker.owner});ok=true;
    }catch(error){failure=error;}
    if(!ok&&stage==='precondition'){
     // Nothing external happened. Transient causes requeue (bounded); a permanent precondition
     // (expired context, revoked licence, broken binding) releases the job so the member can abandon it.
     const transient=failure instanceof ReviewError&&failure.retryable;
     const result=await store.transact(db=>{const op=db.operations[marker.id],job=db.jobs[marker.jobId];check(op.status==='running'&&job.pending===op.id&&!op.adapterStartedAt,'phase');op.lastError=failure instanceof ReviewError?failure.code:'review_gateway_internal';op.deferrals=(op.deferrals??0)+1;
      if(transient&&op.deferrals<=maxDeferrals){op.status='queued';op.notBefore=clock()+Math.min(60000,1000*2**Math.min(op.deferrals,6));delete op.startedAt;}
      else{op.status='cancelled';op.cancelledAt=clock();op.cancelReason=transient?'review_gateway_deferral_limit':op.lastError;job.pending=null;}
      return {job,op};});
     onError?.(failure);return receipt(result.job,result.op);
    }
    if(!ok)onError?.(failure);
    const result=await store.transact(db=>{const op=db.operations[marker.id],job=db.jobs[marker.jobId];check(op.status==='running'&&job.pending===op.id,'phase');op.status=ok?'completed':'uncertain';op.completedAt=clock();op.resultDigest=ok?digest(output):null;job.phase=ok?(['refused','owned-approved'].includes(output.status)?output.status:op.action==='reconcile'?(output.status==='unknown'?'relayed':'reconciled'):transitions[op.action][1]):'uncertain';if(ok)job.pending=null;return {job,op};});
    return receipt(result.job,result.op);
   }finally{activeOperation=null;executing=false;}
  }
 };
}
