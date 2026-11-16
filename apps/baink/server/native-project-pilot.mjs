import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { nativeResearchSigningBytes, canonicalJSON, canonicalEvidence, researchEvidenceCanonical, validateResearchPayload } from '../integrations/native-research-codec.mjs';

const HASH = /^[a-f0-9]{64}$/, UINT = /^(0|[1-9][0-9]{0,19})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/, ADDRESS = /^uain1[a-f0-9]{40}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const unresolvedOther = (collection,value,address) => (collection==='nativePaymentIntents'?value.payer:value.member)===address && Boolean(value.sendAttemptedAt) && !(collection==='nativePaymentIntents'?['ledger-recorded','recipient-confirmed-paid']:['finalized','expired-unused','expired_unincluded']).includes(value.status);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
export class NativeProjectPilotError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
const check = (ok,status,code,message) => { if (!ok) throw new NativeProjectPilotError(status,code,message); };
const nativeProjectPilotSigningBytes = command => Buffer.from(nativeResearchSigningBytes(command));
// The pinned native reader uses exact decimal strings for int64 standing;
// isolated fixtures may use safe JSON integers. Neither permits coercion.
function naturalInt64(value) {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(value))return null;
  const result=BigInt(value);return result<=9223372036854775807n?result:null;
}
function holder(user) {
  check(ADDRESS.test(user?.address ?? '') && typeof user.publicKey === 'string',401,'invalid_native_holder');
  const raw = Buffer.from(user.publicKey,'base64');
  check(raw.length === 32 && raw.toString('base64') === user.publicKey && 'uain1'+sha(raw).slice(0,40) === user.address,401,'invalid_native_holder');
  return raw.toString('base64url');
}
function configuration(value) {
  if (value == null) return null;
  const keys = ['sourceId','sourceDigest','projectId','taskId','creatorAddress','creatorInstance','chainId','epoch','projectPayload','taskPayload'];
  check(exact(value,keys) && ID.test(value.sourceId) && HASH.test(value.sourceDigest) && ID.test(value.projectId) && ID.test(value.taskId) && ADDRESS.test(value.creatorAddress) && ID.test(value.creatorInstance) && /^[A-Za-z0-9._-]{1,96}$/.test(value.chainId) && HASH.test(value.epoch),500,'invalid_native_pilot_config');
  validateResearchPayload('open_project',value.projectPayload);
  validateResearchPayload('open_task',value.taskPayload);
  check(value.projectPayload.id === value.projectId && value.taskPayload.project === value.projectId && value.taskPayload.id === value.taskId && value.taskPayload.kind === 'instant' && value.taskPayload.karma_reward === 0 && value.taskPayload.credit_reward === '0',500,'invalid_native_pilot_config');
  return structuredClone(value);
}
/** One explicitly evaluated pilot. No keys, funding, role grants or local review authority. */
export function createNativeProjectPilotService({ store, native, config = null, enabled = false, sourceDigest = null }) {
  const cfg = configuration(config), binding = cfg && sha(canonicalJSON(cfg));
  const canSend = () => enabled === true && cfg !== null && native.configured === true && typeof native.broadcastResearch === 'function' && typeof sourceDigest === 'function';
  async function currentSource(){check(typeof sourceDigest==='function' && await sourceDigest(cfg.sourceId)===cfg.sourceDigest,409,'native_source_changed');}
  const proofError = ok => check(ok,503,'native_proof_unavailable','A fresh pinned native proof is required.');
  // Every BAINK member's publication reaches uain.global from this one server,
  // which the pilot budgets as one address (120 publications a minute,
  // UAIN_RATE_PUBLICATIONS_PER_MIN, 13 November 2026). A published intent never
  // calls again; a 429 leaves it pending and retryable; this bounds retries of an
  // unpublished one, so one member cannot spend everyone's share.
  const PUBLISH_PER_MEMBER = 4, PUBLISH_WINDOW_MS = 60_000, publishAttempts = new Map();
  function publicationBudget(address) {
    const now = Date.now();let entry = publishAttempts.get(address);
    if (!entry || entry.until <= now) entry = { count: 0, until: now + PUBLISH_WINDOW_MS };
    check(entry.count < PUBLISH_PER_MEMBER,429,'native_pilot_publication_rate_limited','At most '+PUBLISH_PER_MEMBER+' publication attempts a minute; nothing was sent. Retry after a minute.');
    publishAttempts.delete(address);
    if (publishAttempts.size >= 4096) publishAttempts.delete(publishAttempts.keys().next().value);
    entry.count++;publishAttempts.set(address,entry);
  }
  function fresh(proof,state,scope=cfg) {
    const age = Date.now()-Date.parse(proof?.headerTime);
    proofError(scope && native.configured === true && native.pins?.chainId === scope.chainId && native.pins?.epoch === scope.epoch && HASH.test(native.pins?.verifierSha256 ?? '') && proof?.authority === 'native' && proof.chainId === scope.chainId && proof.epoch === scope.epoch && proof.verifierSha256 === native.pins.verifierSha256 && Number.isFinite(age) && age >= -60000 && Number.isInteger(proof.maxAgeSeconds) && proof.maxAgeSeconds >= 1 && proof.maxAgeSeconds <= 120 && age <= proof.maxAgeSeconds*1000 && /^[1-9][0-9]{0,18}$/.test(proof.height ?? '') && HASH.test(proof.appHash ?? ''));
    if (state) proofError(state.chain_id === proof.chainId && state.height === proof.height && state.app_hash === proof.appHash && UINT.test(state.event_count ?? ''));
  }
  async function proven(selection,intent,deadline=Date.now()+(native.timeoutMs ?? 5000)) {
    let context;
    try { context = await native.publicState(selection,{timeoutMs:Math.max(1,deadline-Date.now())}); } catch { proofError(false); }
    // Recovery follows the journal's original network, even when the current
    // pilot changes. The configured reader must still pin that exact epoch.
    fresh(context?.proof,context?.state,intent?{chainId:intent.command.chain_id,epoch:intent.proof.epoch}:cfg);
    if (intent) proofError(context.state.chain_id === intent.command.chain_id && BigInt(context.state.height) >= BigInt(intent.proof.height));
    for (const key of selection.keys ?? []) proofError(Object.hasOwn(context.state.records ?? {},key));
    return context;
  }
  function selection(user,instance,payload) {
    const keys = [`instance/${instance}`,`project/${cfg.projectId}`,`task/${cfg.taskId}`,`participation/${cfg.projectId}/${user.address}/${instance}`];
    if (payload.id && ![cfg.projectId,cfg.taskId].includes(payload.id)) keys.push(`contribution/${payload.id}`);
    if (payload.contribution) keys.push(`contribution/${payload.contribution}`);
    return {member:user.address,keys};
  }
  function preflight(context,user,key,operation,instance,payload) {
    const m=context.state.member,r=context.state.records,i=r[`instance/${instance}`],p=r[`project/${cfg.projectId}`],t=r[`task/${cfg.taskId}`];
    proofError(m?.id === user.address && m.public_key === key && UINT.test(m.sequence ?? '') && BigInt(m.sequence) < 18446744073709551615n);
    check(m.licence === 'active',409,'native_licence_inactive');
    check(i?.id === instance && i.member === user.address && i.state === 'active',403,'native_instance_not_owned');
    if (['open_project','open_task'].includes(operation)) check(user.address === cfg.creatorAddress && instance === cfg.creatorInstance,403,'native_creator_required');
    if (operation === 'open_project') {
      check(p === null,409,'native_project_exists');
      const karma=naturalInt64(m.karma),active=naturalInt64(m.active_projects);
      check(m.creator === true || karma!==null && karma>=1000n && active!==null && active<1n+(karma-1000n)/10n,403,'native_creator_required');
    } else {
      check(p?.id === cfg.projectId && p.state === 'active',409,'native_project_not_active');
      if (operation === 'open_task') check(p.lead === user.address && (!p.lead_instance || p.lead_instance === instance) && t === null,403,'native_project_lead_required');
      if (operation !== 'project_join' && p.membership_policy) {
        const joined=r[`participation/${cfg.projectId}/${user.address}/${instance}`];
        check(joined?.project === cfg.projectId && joined.member === user.address && joined.instance === instance,403,'native_project_join_required');
      }
      if (operation === 'project_join') check(r[`participation/${cfg.projectId}/${user.address}/${instance}`] === null,409,'native_already_joined');
      if (['submit','verify'].includes(operation)) check(t?.id === cfg.taskId && t.project === cfg.projectId && t.state === 'open',409,'native_task_not_open');
      if (operation === 'submit') check(r[`contribution/${payload.id}`] === null,409,'native_contribution_exists');
      if (operation === 'verify') {
        const v=r[`contribution/${payload.contribution}`];
        check(v?.id === payload.contribution && v.task === cfg.taskId && v.state === 'held',409,'native_contribution_not_reviewable');
        check(v.author !== user.address,403,'native_self_review');
        const karma=naturalInt64(m.karma);
        check(m.default_verifier === true || karma!==null && karma>=100n,403,'native_reviewer_required');
      }
    }
    return m;
  }
  function details(body) {
    check(Buffer.byteLength(canonicalEvidence(body))<=12000,400,'native_pilot_body_limit','Pilot requests must fit within 12,000 bytes.');
    check(exact(body, ['clientRequestId','sourceDigest','operation','instance','payload',...(Object.hasOwn(body ?? {},'body') ? ['body'] : [])]),400,'invalid_native_pilot_fields');
    check(typeof body.clientRequestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId) && ID.test(body.instance ?? ''),400,'invalid_native_pilot_fields');
    check(body.sourceDigest === cfg.sourceDigest,409,'native_source_changed');
    const payload=structuredClone(body.payload);
    try{validateResearchPayload(body.operation,payload);}catch{check(false,400,'invalid_native_pilot_payload');}
    if (['open_project','open_task'].includes(body.operation)) check(same(payload,body.operation === 'open_project' ? cfg.projectPayload : cfg.taskPayload),400,'native_pilot_scope_mismatch');
    if (body.operation === 'project_join') check(payload.project === cfg.projectId,400,'native_pilot_scope_mismatch');
    if (body.operation === 'submit') {
      check(payload.task === cfg.taskId && Object.hasOwn(body,'body'),400,'native_pilot_scope_mismatch');
      let canonical;try{canonical=researchEvidenceCanonical(body.body);}catch{check(false,400,'invalid_native_evidence');}const value=JSON.parse(canonical);
      check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k=>['title','detail','claim_statement','evidence','sources','artifacts','forecast','reproduction'].includes(k)) && typeof value.title === 'string' && value.title.trim() && value.title.length<=200 && typeof value.detail === 'string' && value.detail.trim().length>=20 && value.detail.length<=48000 && Buffer.byteLength(canonical)<=60000,400,'invalid_native_evidence');
      check(value.sources == null || Array.isArray(value.sources) && value.sources.length<=16 && value.sources.every(s=>typeof s==='string' && s.length<=2048),400,'invalid_native_evidence');
      check(payload.evidence_digest === sha('uain:research-evidence:v1\n'+canonical),400,'native_evidence_digest_mismatch');
      return {payload,publicBody:value};
    }
    check(!Object.hasOwn(body,'body'),400,'unexpected_native_evidence');
    return {payload,publicBody:null};
  }
  function owned(user,id,historical=false) {
    holder(user);const value=store.read().nativeProjectPilotIntents?.[id];
    check(value?.member === user.address,404,'native_pilot_intent_missing');
    if(!historical)check(value.binding === binding,409,'native_pilot_config_changed');return value;
  }
  function view(intent) { const value=structuredClone(intent);value.finalized=value.status==='finalized';value.receiptRequired=Boolean(value.sendAttemptedAt)&&!value.finalized&&value.status!=='expired_unincluded';if(value.status==='broadcasting')value.status='unknown';return value; }
  function envelopeFor(intent,body,user) {
    check(exact(body,['envelope']) && exact(body.envelope,['command','public_key','signature']),400,'invalid_native_envelope');
    const e=body.envelope;let bytes;try{bytes=nativeProjectPilotSigningBytes(e.command);}catch{check(false,400,'invalid_native_command');}
    check(bytes.equals(Buffer.from(intent.signingBytesBase64,'base64')) && e.public_key === holder(user) && e.public_key === intent.publicKey,400,'native_envelope_mismatch');
    const sig=typeof e.signature==='string'?Buffer.from(e.signature,'base64url'):Buffer.alloc(0);
    check(sig.length===64 && sig.toString('base64url')===e.signature && verify(null,bytes,createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:e.public_key},format:'jwk'}),sig),400,'invalid_native_signature');
    return {command:structuredClone(intent.command),public_key:e.public_key,signature:e.signature};
  }
  const subject = command => command.payload.id ?? command.payload.contribution ?? command.payload.project;
  function receiptSelection(intent,user) {
    const {operation:op,payload:p,instance}=intent.command;
    const key=op==='open_project'?`project/${p.id}`:op==='open_task'?`task/${p.id}`:op==='project_join'?`participation/${p.project}/${user.address}/${instance}`:`contribution/${p.id??p.contribution}`;
    return {member:user.address,keys:[key]};
  }
  function verifiedRecord(context,intent,user) {
    const {operation:op,payload:p,instance}=intent.command,r=context.state.records;
    const m=context.state.member;
    proofError(m?.id===user.address && m.public_key===intent.publicKey && UINT.test(m.sequence??'') && BigInt(m.sequence)>BigInt(intent.command.sequence));
    if(op==='open_project') { const v=r[`project/${p.id}`];proofError(v?.id===p.id && v.lead===user.address && v.lead_instance===instance); }
    if(op==='open_task') { const v=r[`task/${p.id}`];proofError(v?.id===p.id && v.project===p.project && v.opened_by_instance===instance); }
    if(op==='project_join') { const v=r[`participation/${p.project}/${user.address}/${instance}`];proofError(v?.project===p.project && v.member===user.address && v.instance===instance); }
    if(op==='submit') { const v=r[`contribution/${p.id}`];proofError(v?.id===p.id && v.task===p.task && v.author===user.address && v.author_instance===instance && v.evidence_digest===p.evidence_digest); }
    if(op==='verify') { const v=r[`contribution/${p.contribution}`];proofError(v?.id===p.contribution); }
  }
  function eventMatches(e,intent,user) { return e?.command_digest===intent.commandDigest && e.member===user.address && e.instance===intent.command.instance && e.operation===intent.command.operation && e.subject===subject(intent.command); }
  return Object.freeze({
    get enabled(){return canSend();},
    configView(){ return cfg ? {...structuredClone(cfg),enabled:canSend(),fundingAvailable:false,scientificAcceptance:false} : null; },
    list(user){holder(user);return{config:this.configView(),intents:Object.values(store.read().nativeProjectPilotIntents??{}).filter(i=>i.member===user.address).map(view)};},
    async snapshot(user,body={}) {
      check(exact(body,[])||exact(body,['contributionId']),400,'invalid_native_pilot_fields');const {contributionId}=body;
      check(cfg,503,'native_pilot_disabled');holder(user);
      check(contributionId===undefined || ID.test(contributionId),400,'invalid_native_pilot_fields');
      const keys=[`project/${cfg.projectId}`,`task/${cfg.taskId}`,...(contributionId?[`contribution/${contributionId}`]:[])];
      const context=await proven({keys});
      const contribution=contributionId?context.state.records[`contribution/${contributionId}`]:null;
      check(!contribution || contribution.task===cfg.taskId,404,'native_pilot_contribution_missing');
      return{config:this.configView(),authority:'native',proof:context.proof,project:context.state.records[`project/${cfg.projectId}`],task:context.state.records[`task/${cfg.taskId}`],contribution,notice:'Native project state only. Admission is not funding, scientific acceptance or an AI$ reward.'};
    },
    async prepare(user,body) {
      check(canSend(),503,'native_pilot_disabled');await currentSource();const key=holder(user),d=details(body);
      const prior=Object.values(store.read().nativeProjectPilotIntents??{}).find(i=>i.member===user.address&&i.clientRequestId===body.clientRequestId);
      if(prior){check(prior.binding===binding && prior.command.operation===body.operation && prior.command.instance===body.instance && same(prior.command.payload,d.payload) && canonicalEvidence(prior.publicBody)===canonicalEvidence(d.publicBody),409,'native_pilot_idempotency_conflict');if(prior.sendAttemptedAt)return{created:false,intent:view(prior)};}
      const context=await proven(selection(user,body.instance,d.payload),prior),m=preflight(context,user,key,body.operation,body.instance,d.payload);
      if(prior){check(m.sequence===prior.command.sequence,409,'native_sequence_changed');check(BigInt(context.state.height)<BigInt(prior.command.expires_height),409,'native_pilot_intent_expired');const resumed=await store.transact(s=>{const i=s.nativeProjectPilotIntents[prior.id];if(!i.sendAttemptedAt)i.proof=context.proof;return i;});return{created:false,intent:view(resumed)};}
      const command={version:1,chain_id:cfg.chainId,member:user.address,sequence:m.sequence,expires_height:String(BigInt(context.state.height)+100n),operation:body.operation,payload:d.payload,instance:body.instance};
      const bytes=nativeProjectPilotSigningBytes(command),now=new Date().toISOString();
      return store.transact(s=>{
        fresh(context.proof,context.state);
        for(const collection of ['nativeInstanceIntents','nativeIntents','nativeEarningIntents','centralEarningIntents','nativePaymentIntents'])check(!Object.values(s[collection]??{}).some(i=>unresolvedOther(collection,i,user.address)),409,'native_pilot_other_intent_pending');
        s.nativeProjectPilotIntents??={};const all=Object.values(s.nativeProjectPilotIntents),previous=all.filter(i=>i.member===user.address);
        check(!previous.some(i=>i.clientRequestId===body.clientRequestId),409,'native_pilot_idempotency_race');
        for(const old of previous.filter(i=>!['finalized','expired_unincluded'].includes(i.status))) {
          // A sent command with unknown inclusion remains blocked until its receipt is recovered.
          check(!old.sendAttemptedAt,409,'native_pilot_intent_pending');
          check(BigInt(old.command.expires_height)<BigInt(context.state.height),409,'native_pilot_intent_pending');old.status='expired';
        }
        check(previous.length<128&&all.length<10000,429,'native_pilot_intent_capacity');
        const intent={id:randomUUID(),member:user.address,publicKey:key,clientRequestId:body.clientRequestId,binding,sourceDigest:cfg.sourceDigest,source:{id:cfg.sourceId,digest:cfg.sourceDigest},status:'prepared',command,publicBody:d.publicBody,publication:d.publicBody?{status:'pending'}:null,signingBytesBase64:bytes.toString('base64'),commandDigest:sha(bytes),proof:context.proof,afterEvent:context.state.event_count,scanCursor:context.state.event_count,envelope:null,sendAttemptedAt:null,transactionHash:null,createdAt:now,updatedAt:now};
        s.nativeProjectPilotIntents[intent.id]=intent;return{created:true,intent:view(intent)};
      });
    },
    async submit(user,id,body) {
      check(canSend(),503,'native_pilot_disabled');await currentSource();const intent=owned(user,id),envelope=envelopeFor(intent,body,user);
      if(intent.envelope)check(same(intent.envelope,envelope),409,'native_envelope_conflict');
      if(intent.sendAttemptedAt)return{attempted:false,intent:view(intent)};
      const deadline=Date.now()+(native.timeoutMs??5000),context=await proven(selection(user,intent.command.instance,intent.command.payload),intent,deadline),m=preflight(context,user,intent.publicKey,intent.command.operation,intent.command.instance,intent.command.payload);
      check(m.sequence===intent.command.sequence,409,'native_sequence_changed');check(BigInt(context.state.height)<BigInt(intent.command.expires_height),409,'native_pilot_intent_expired');
      const marker=await store.transact(s=>{
        fresh(context.proof,context.state);
        check(Date.now()<deadline,503,'native_proof_unavailable');
        for(const collection of ['nativeInstanceIntents','nativeIntents','nativeEarningIntents','centralEarningIntents','nativePaymentIntents'])check(!Object.values(s[collection]??{}).some(other=>unresolvedOther(collection,other,user.address)),409,'native_pilot_other_intent_pending');
        const i=s.nativeProjectPilotIntents[id];check(i?.member===user.address&&i.binding===binding,404,'native_pilot_intent_missing');if(i.envelope)check(same(i.envelope,envelope),409,'native_envelope_conflict');if(i.sendAttemptedAt)return{send:false,intent:i};i.envelope=envelope;i.transactionHash=sha(JSON.stringify(envelope)).toUpperCase();i.sendAttemptedAt=new Date().toISOString();i.updatedAt=i.sendAttemptedAt;i.status='broadcasting';return{send:true,intent:i};});
      if(!marker.send)return{attempted:false,intent:view(marker.intent)};
      // Persistence itself can outlast the fresh proof/deadline. Keep the marker
      // for explicit recovery, but never call RPC with an expired send budget.
      try { fresh(context.proof,context.state);check(Date.now()<deadline,503,'native_proof_unavailable'); }
      catch {
        const stopped=await store.transact(s=>{const i=s.nativeProjectPilotIntents[id];if(i.status==='broadcasting'){i.status='unknown';i.updatedAt=new Date().toISOString();}return i;});
        return{attempted:false,intent:view(stopped)};
      }
      let outcome={status:'unknown',broadcastCode:null};
      try{const reply=await native.broadcastResearch(envelope,{timeoutMs:Math.max(1,deadline-Date.now())});if(reply.transactionHash===marker.intent.transactionHash&&Number.isInteger(reply.code)&&reply.code>=0&&reply.accepted===(reply.code===0))outcome={status:reply.accepted?'accepted':'refused',broadcastCode:reply.code};}catch{}
      const result=await store.transact(s=>{const i=s.nativeProjectPilotIntents[id];if(i.status==='broadcasting'){Object.assign(i,outcome);i.updatedAt=new Date().toISOString();}return i;});return{attempted:true,intent:view(result)};
    },
    async recover(user,id,body) {
      check(exact(body,[]),400,'invalid_recovery_request');
      const initial=owned(user,id,true);
      check(initial.envelope&&initial.sendAttemptedAt,409,'native_pilot_not_submitted');
      if(['finalized','expired_unincluded'].includes(initial.status))return{intent:view(initial)};
      // Never re-sign or resend. Complete the proved event scan after the old
      // command's inclusion window has closed; finality recovery takes priority.
      const head=await proven({},initial);
      check(BigInt(head.state.height)>BigInt(initial.command.expires_height),409,'native_pilot_not_expired');
      const scanned=await this.receipt(user,id,{});
      if(scanned.intent.finalized)return scanned;
      const current=owned(user,id,true),end=await proven({},current);
      if(BigInt(current.scanCursor)<BigInt(end.state.event_count))return{intent:view(current),recoveryPending:true};
      proofError(BigInt(end.state.height)>BigInt(current.command.expires_height)&&current.lastScanProof&&BigInt(end.state.height)>=BigInt(current.lastScanProof.height)&&BigInt(end.state.event_count)>=BigInt(current.scanCursor));
      const result=await store.transact(s=>{
        const i=s.nativeProjectPilotIntents[id];
        if(i.status!=='finalized'){
          check(i.commandDigest===current.commandDigest&&i.scanCursor===current.scanCursor,409,'native_pilot_recovery_changed');
          i.status='expired_unincluded';i.expiryProof={...end.proof,eventCount:end.state.event_count,scannedFrom:i.afterEvent,scannedThrough:i.scanCursor};i.updatedAt=new Date().toISOString();
        }
        return i;
      });
      return{intent:view(result)};
    },
    async publish(user,id,body) {
      check(exact(body,[]),400,'invalid_publication_request');const intent=owned(user,id,true);
      check(intent.status==='finalized' && intent.command.operation==='submit' && intent.publicBody && intent.receipt?.event?.id,409,'native_pilot_publication_not_ready');
      if(intent.publication?.status==='published')return{intent:view(intent)};
      const epoch=intent.proof.epoch;
      check(native.configured===true && native.pins?.chainId===intent.command.chain_id && native.pins?.epoch===epoch && typeof native.publishResearch==='function',503,'native_pilot_publication_unavailable');
      publicationBudget(user.address);
      let ack;try{ack=await native.publishResearch({body:structuredClone(intent.publicBody),envelope:structuredClone(intent.envelope),event_id:intent.receipt.event.id},{epoch,id:intent.command.payload.id,evidence_digest:intent.command.payload.evidence_digest});}catch{throw new NativeProjectPilotError(503,'native_pilot_publication_unavailable','The chain submission is final; its exact public body has not yet been published.');}
      check(ack?.published===true && ack.epoch===epoch && ack.id===intent.command.payload.id && ack.evidence_digest===intent.command.payload.evidence_digest,503,'native_pilot_publication_mismatch');
      const result=await store.transact(s=>{const i=s.nativeProjectPilotIntents[id];i.publication={status:'published',epoch:ack.epoch,id:ack.id,evidence_digest:ack.evidence_digest};return i;});return{intent:view(result)};
    },
    async receipt(user,id,body) {
      check(exact(body,[]),400,'invalid_receipt_request');const intent=owned(user,id,true);check(intent.envelope&&intent.sendAttemptedAt,409,'native_pilot_not_submitted');
      if(intent.status==='finalized')return{intent:view(intent)};
      const deadline=Date.now()+(native.timeoutMs??5000),head=await proven({},intent,deadline),cursor=BigInt(intent.scanCursor),count=BigInt(head.state.event_count);proofError(cursor<=count);
      const end=cursor+32n<count?cursor+32n:count,ids=[];for(let n=cursor+1n;n<=end;n++)ids.push(String(n));
      const batch=ids.length?await proven({keys:ids.map(n=>'event/'+n.padStart(20,'0'))},intent,deadline):head;proofError(BigInt(batch.state.height)>=BigInt(head.state.height));
      for(const eventId of ids){const event=batch.state.records['event/'+eventId.padStart(20,'0')];proofError(event?.id===eventId&&HASH.test(event.command_digest??''));if(event.command_digest!==intent.commandDigest)continue;proofError(eventMatches(event,intent,user));
        const context=await proven({...receiptSelection(intent,user),receipt:{envelope:intent.envelope,event_id:eventId}},intent,deadline),r=context.state.receipt;
        proofError(BigInt(context.state.height)>=BigInt(batch.state.height)&&r?.authority==='native'&&r.finalized===true&&r.chain_id===intent.command.chain_id&&r.state_height===context.state.height&&r.app_hash===context.proof.appHash&&r.event?.id===eventId&&eventMatches(r.event,intent,user));verifiedRecord(context,intent,user);
        const result=await store.transact(s=>{const i=s.nativeProjectPilotIntents[id];i.status='finalized';i.receipt={...r,proof:context.proof};i.scanCursor=eventId;i.moreEvents=false;i.updatedAt=new Date().toISOString();return i;});native.invalidateAccount?.(user.address);return{intent:view(result)};
      }
      const result=await store.transact(s=>{const i=s.nativeProjectPilotIntents[id];if(i.status!=='finalized'&&BigInt(i.scanCursor)<end)i.scanCursor=String(end);i.moreEvents=i.status!=='finalized'&&end<count;i.lastScanProof=structuredClone(batch.proof);return i;});return{intent:view(result)};
    },
  });
}
