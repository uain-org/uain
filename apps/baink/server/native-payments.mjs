import { hasPendingPilotSend } from './native-pilot-sequence.mjs';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { canonicalJSON, nativeFinancialSigningBytes as signingBytes, memberAddress } from './native-financial-command.mjs';

const HASH = /^[a-f0-9]{64}$/, ADDRESS = /^uain1[a-f0-9]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,19})$/, MAX_PAYMENT = 9223372036854775807n;
const hash = value => createHash('sha256').update(value).digest('hex');
const keyObject = raw => createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:raw.toString('base64url')},format:'jwk'});
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value,k));
/** Product default D-1: a payment request is payable for seven days. Rows
 * written before expiry existed read as createdAt+7d; no parseable createdAt
 * means no expiry. Expiry is computed on read, never stored as a status, so an
 * already-sent payment can still reconcile and confirm against its request. */
export const PAYMENT_REQUEST_EXPIRY_MS=7*24*60*60*1000;
// Requests created before expiry existed (no stored expiresAt) stay payable for
// seven days after this release instead of expiring on deploy (the original
// D-17 Trade among them).
export const LEGACY_REQUEST_GRACE_UNTIL=Date.parse('2026-11-17T00:00:00Z');
export function paymentRequestExpiresAt(request) {
  if(typeof request?.expiresAt==='string' && Number.isFinite(Date.parse(request.expiresAt)))return request.expiresAt;
  const created=Date.parse(request?.createdAt);return Number.isFinite(created)?new Date(Math.max(created+PAYMENT_REQUEST_EXPIRY_MS,LEGACY_REQUEST_GRACE_UNTIL)).toISOString():null;
}
export function paymentRequestExpired(request,now=Date.now()) { const at=paymentRequestExpiresAt(request);return request?.status==='open' && at!==null && Date.parse(at)<=now; }
export function paymentRequestView(request,now=Date.now()) { return {...request,expiresAt:paymentRequestExpiresAt(request),status:paymentRequestExpired(request,now)?'expired':request.status}; }
export function addPaymentRequestHistory(state,type,request,actor) {
  (state.history??=[]).push({id:randomUUID(),type,requestId:request.id,at:new Date().toISOString(),actor,from:request.from,to:request.to,amount:request.amount,memo:request.memo,status:request.status,currency:'AI$'});
}
const CLOSED_INTENT=['abandoned','expired-unused'],RECORDED=['ledger-recorded','recipient-confirmed-paid'];
export class NativePaymentError extends Error {
  constructor(status,code,message=code) { super(message); this.status=status; this.code=code; }
}
function check(condition,status,code,message) { if (!condition) throw new NativePaymentError(status,code,message); }
function raw64(value,length) {
  check(typeof value === 'string' && value.length <= 256,400,'invalid_payment_signature');
  const bytes=Buffer.from(value,'base64url');
  check(bytes.length===length && bytes.toString('base64url')===value,400,'invalid_payment_signature');
  return bytes;
}
function holder(user) {
  check(ADDRESS.test(user?.address) && typeof user.publicKey==='string' && user.publicKey.length===44,401,'invalid_native_holder');
  const raw=Buffer.from(user.publicKey,'base64');
  check(raw.length===32 && raw.toString('base64')===user.publicKey && memberAddress(raw)===user.address,401,'invalid_native_holder');
  return raw;
}
function bound(intent) {
  return {id:intent.id,chainId:intent.chainId,genesisSha256:intent.genesisSha256,payer:intent.payer,payee:intent.payee,amountUnits:intent.amountUnits,requestDigest:intent.requestDigest};
}
/** Public signing contracts. No private agreement, salt, note or key is accepted. */
export function paymentAgreementBytes(intent,purposeCommitment) {
  check(HASH.test(purposeCommitment),400,'invalid_payment_agreement');
  return Buffer.from('BAINK/payment-agreement/v1\0'+canonicalJSON({...bound(intent),purposeCommitment}));
}
export function paymentConfirmationBytes(intent) {
  check(HASH.test(intent.effects),400,'invalid_payment_confirmation');
  return Buffer.from('BAINK/payment-recipient-confirmation/v1\0'+canonicalJSON({...bound(intent),effects:intent.effects,locallyInspected:true}));
}
/** The appointed checker signs only after independently inspecting the local
 * invoice/outputs. This binds hidden payment parties to this BAINK intent;
 * the on-chain native approval alone intentionally conceals those fields. */
export function paymentReviewerBindingBytes(intent,{effects,reviewer}) {
  check(HASH.test(effects) && ADDRESS.test(reviewer) && HASH.test(intent.purposeCommitment),400,'invalid_payment_reviewer_binding');
  return Buffer.from('BAINK/payment-reviewer-binding/v1\0'+canonicalJSON({...bound(intent),purposeCommitment:intent.purposeCommitment,effects,reviewer,independentlyInspected:true}));
}
function units(amount) {
  check(typeof amount==='string' && /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(amount),409,'payment_request_changed');
  const [whole,part='']=amount.split('.');return String(BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0')));
}
function requestSnapshot(request) {
  return {id:request.id,from:request.from,to:request.to,amount:request.amount,memo:request.memo??'',currency:request.currency,createdAt:request.createdAt,updatedAt:request.updatedAt};
}
function tradeRequestBinding(request,validateTradeRequest) {
  if (!Object.hasOwn(request,'trade')) return null;
  check(typeof validateTradeRequest==='function',409,'payment_request_changed');
  let binding;try { binding=validateTradeRequest(request); } catch { check(false,409,'payment_request_changed'); }
  check(binding && HASH.test(binding.tradeDigest),409,'payment_request_changed');
  return binding;
}
function requestMatchesState(state,intent,{confirmed=false,validateTradeRequest}={}) {
  if (!intent.requestId) return;
  const request=state.requests?.[intent.requestId];
  check(request && (request.status==='open' || confirmed && request.status==='paid' && request.paymentIntentId===intent.id) && hash(canonicalJSON(requestSnapshot(request)))===intent.requestDigest,409,'payment_request_changed');
  // A send already attempted is unaffected by expiry until it is reconciled.
  check(intent.sendAttemptedAt || !paymentRequestExpired(request),409,'payment_request_expired','This payment request has expired.');
  const trade=tradeRequestBinding(request,validateTradeRequest);
  check((trade?.tradeDigest??null)===(intent.tradeDigest??null),409,'payment_request_changed');
}

/** Native contract: configured,pins={chainId,epoch,verifierSha256},timeoutMs;
 * publicState({member?,keys?,receipt?:{envelope,event_id}},{timeoutMs}) returns
 * {state:{chain_id,height,app_hash,event_count,member?,records,receipt?},proof}.
 * records use exact native keys. broadcastPayment(envelope,{timeoutMs}) is a
 * separately gated bounded private_payment-only transport returning
 * {transactionHash,accepted,code}. Store transact MUST durably commit before
 * resolving. No server-held wallet, private reader selectors or amount proof.
 */
export function createNativePaymentService({store,native,enabled=false,validateTradeRequest,tradeAvailability=null}) {
  const requestMatches=(state,intent,options={})=>requestMatchesState(state,intent,{...options,validateTradeRequest});
  const proofError=ok=>check(ok,503,'native_proof_unavailable','A fresh pinned native payment proof is required.');
  const canSend=()=>enabled===true && native.configured===true && typeof native.broadcastPayment==='function';
  function fresh(context,intent) {
    const {proof:p,state:s}=context??{},pins=native.pins;
    const age=Date.now()-Date.parse(p?.headerTime);
    proofError(native.configured===true && HASH.test(pins?.epoch??'') && HASH.test(pins?.verifierSha256??'') && p?.authority==='native' && p.chainId===pins.chainId && p.epoch===pins.epoch && (p.genesisSha256===undefined || p.genesisSha256===pins.epoch) && p.verifierSha256===pins.verifierSha256 && Number.isFinite(age) && age>=-60000 && Number.isInteger(p.maxAgeSeconds) && p.maxAgeSeconds>=1 && p.maxAgeSeconds<=120 && age<p.maxAgeSeconds*1000 && /^[1-9][0-9]{0,18}$/.test(p.height??'') && HASH.test(p.appHash??'') && s?.chain_id===p.chainId && s.height===p.height && s.app_hash===p.appHash && UINT.test(s.event_count??''));
    if(intent)proofError(intent.chainId===p.chainId && intent.genesisSha256===p.epoch && intent.proof.verifierSha256===p.verifierSha256 && BigInt(p.height)>=BigInt(intent.proof.height));
    return context;
  }
  async function proven(selection,intent,deadline=Date.now()+Math.min(30000,native.timeoutMs||15000)) {
    let context;try{context=await native.publicState(selection,{timeoutMs:Math.max(1,deadline-Date.now())});}catch{proofError(false);}
    return fresh(context,intent);
  }
  function licensed(member,id,expectedKey) {
    proofError(member?.id===id && typeof member.public_key==='string');
    const key=raw64(member.public_key,32);proofError(memberAddress(key)===id && (!expectedKey || key.toString('base64')===expectedKey));
    check(member.licence==='active',409,'native_licence_inactive','Both payment participants need an active native licence.');
    return key;
  }
  function owned(user,id,payerOnly=false) {
    holder(user);const intent=store.read().nativePaymentIntents?.[id];
    check(intent && [intent.payer,intent.payee].includes(user.address),404,'payment_intent_missing');
    check(!payerOnly || intent.payer===user.address,403,'payment_payer_required');
    const expected=user.address===intent.payer?intent.payerPublicKey:intent.payeePublicKey;
    check(user.publicKey===expected,403,'payment_identity_changed');return intent;
  }
  function view(intent) {
    const result=structuredClone(intent);if(result.status==='broadcasting')result.status='unknown';
    result.paid=result.status==='recipient-confirmed-paid';result.amountVerification=result.paid?'recipient-attested':'not-publicly-proved';result.publicAmountProof=false;
    return result;
  }
  function open(intent) { check(intent.status!=='abandoned',409,'payment_intent_abandoned');check(intent.status!=='expired-unused',409,'payment_intent_expired_unused','This payment expired unused; prepare a new payment.'); }
  function agreed(intent) { open(intent);check(intent.agreements?.[intent.payer] && intent.agreements?.[intent.payee] && HASH.test(intent.purposeCommitment),409,'payment_agreement_required'); }
  const effectKey=(intent,effects)=>hash(intent.chainId+'\0'+intent.genesisSha256+'\0'+effects);
  function bindEffect(state,intent,effects) {
    state.nativePaymentEffects??={};
    const key=effectKey(intent,effects);
    check(!state.nativePaymentEffects[key] || state.nativePaymentEffects[key]===intent.id,409,'payment_effect_reused');
    state.nativePaymentEffects[key]=intent.id;
  }
  function approvalBytes(chain,approval,reviewerKey) {
    const u64=value=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(value));return b;};
    return Buffer.concat([Buffer.from('UAIN/private-exchange/approval/v1\0'),Buffer.from(hash(chain),'hex'),u64(approval.expires_height),u64(approval.licence_revision),Buffer.from(approval.effects,'hex'),Buffer.from(approval.purpose_commitment,'hex'),Buffer.from([approval.class==='benevolent'?1:2,1]),reviewerKey]);
  }
  function envelopeShape(intent,envelope) {
    agreed(intent);
    check(exact(envelope,['command','public_key','signature']) && exact(envelope.command,['version','chain_id','member','sequence','expires_height','operation','payload']),400,'invalid_payment_envelope');
    const c=envelope.command;
    check(c.version===1 && c.operation==='private_payment' && c.chain_id===intent.chainId && ADDRESS.test(c.member) && typeof c.sequence==='string' && UINT.test(c.sequence) && BigInt(c.sequence)<18446744073709551615n && typeof c.expires_height==='string' && /^[1-9][0-9]{0,18}$/.test(c.expires_height) && BigInt(c.expires_height)<=9223372036854775807n && exact(c.payload,['bundle','approval']),400,'invalid_payment_envelope');
    const a=c.payload.approval;
    check(exact(a,['reviewer','effects','purpose_commitment','class','expires_height','licence_revision','signature']) && ADDRESS.test(a.reviewer) && HASH.test(a.effects) && a.purpose_commitment===intent.purposeCommitment && ['benevolent','neutral'].includes(a.class) && typeof a.expires_height==='string' && /^[1-9][0-9]{0,18}$/.test(a.expires_height) && BigInt(a.expires_height)<=9223372036854775807n && typeof a.licence_revision==='string' && UINT.test(a.licence_revision) && BigInt(a.licence_revision)<=18446744073709551615n,400,'invalid_payment_approval');
    const bundle=c.payload.bundle;
    check(typeof bundle==='string' && bundle.length<=22000 && bundle.length>0 && Buffer.from(bundle,'base64url').length<=16384 && Buffer.from(bundle,'base64url').toString('base64url')===bundle,400,'invalid_payment_bundle');
    const raw=raw64(envelope.public_key,32),sig=raw64(envelope.signature,64);
    let bytes;try{bytes=signingBytes(c);}catch{check(false,400,'invalid_payment_envelope');}
    check(memberAddress(raw)===c.member && verify(null,bytes,keyObject(raw),sig),400,'invalid_payment_signature');
    return {envelope:structuredClone(envelope),commandDigest:hash(bytes),effects:a.effects,transactionHash:hash(JSON.stringify(envelope)).toUpperCase()};
  }
  async function validateLiveEnvelope(intent,envelope,deadline) {
    const c=envelope.command,a=c.payload.approval;
    const context=await proven({member:c.member,keys:['private_activation','coin_activation','private_licence_revision','member/'+intent.payer,'member/'+intent.payee,'member/'+a.reviewer,'private_reviewer/'+a.reviewer]},intent,deadline);
    const r=context.state.records,height=BigInt(context.state.height),policy=r.private_activation,coin=r.coin_activation;
    check(policy?.policy==='orchard-v2-reviewed-otc-v1' && UINT.test(policy.height??'') && BigInt(policy.height)<=height && policy.relayer===c.member && coin?.policy==='verified-bounties-108t-micro-v1' && UINT.test(coin.height??'') && BigInt(coin.height)<=height,409,'native_payment_policy_inactive');
    check(![intent.payer,intent.payee,a.reviewer].includes(c.member) && ![intent.payer,intent.payee].includes(a.reviewer),409,'native_payment_roles_conflict');
    const relay=licensed(context.state.member,c.member);
    proofError(relay.toString('base64url')===envelope.public_key && context.state.member.sequence===c.sequence);
    licensed(r['member/'+intent.payer],intent.payer,intent.payerPublicKey);licensed(r['member/'+intent.payee],intent.payee,intent.payeePublicKey);
    const reviewer=licensed(r['member/'+a.reviewer],a.reviewer);
    check(r['private_reviewer/'+a.reviewer]?.active===true && Number.isSafeInteger(r['member/'+a.reviewer].karma) && r['member/'+a.reviewer].karma>=100,409,'native_payment_reviewer_inactive');
    proofError(r.private_licence_revision?.value===a.licence_revision);
    check(BigInt(c.expires_height)>height && BigInt(c.expires_height)<=BigInt(a.expires_height) && BigInt(a.expires_height)>=height && BigInt(a.expires_height)<=height+720n,409,'payment_intent_expired');
    check(verify(null,approvalBytes(c.chain_id,a,reviewer),keyObject(reviewer),raw64(a.signature,64)),400,'invalid_payment_approval');
    return context;
  }
  function verifyReviewerBinding(intent,envelope,binding) {
    check(exact(binding,['publicKey','signature','independentlyInspected']) && binding.independentlyInspected===true,400,'invalid_payment_reviewer_binding');
    const approval=envelope.command.payload.approval,raw=raw64(binding.publicKey,32);
    check(memberAddress(raw)===approval.reviewer && ![intent.payer,intent.payee,envelope.command.member].includes(approval.reviewer),400,'invalid_payment_reviewer_binding');
    // Historical recovery retains signature validity after a role is revoked.
    // The exact native receipt subsequently proves consensus accepted this
    // reviewer/approval; fresh role checks remain mandatory for a new send.
    check(verify(null,approvalBytes(intent.chainId,approval,raw),keyObject(raw),raw64(approval.signature,64)) && verify(null,paymentReviewerBindingBytes(intent,{effects:approval.effects,reviewer:approval.reviewer}),keyObject(raw),raw64(binding.signature,64)),400,'invalid_payment_reviewer_binding');
    return structuredClone(binding);
  }
  async function attach(user,id,body,send) {
    check(exact(body,['envelope','reviewerBinding']),400,'invalid_payment_envelope');
    const intent=owned(user,id,true),details=envelopeShape(intent,body.envelope);
    const reviewerBinding=verifyReviewerBinding(intent,details.envelope,body.reviewerBinding);
    if(intent.envelope)check(canonicalJSON(intent.envelope)===canonicalJSON(details.envelope),409,'payment_envelope_conflict');
    if(intent.reviewerBinding)check(canonicalJSON(intent.reviewerBinding)===canonicalJSON(reviewerBinding),409,'payment_reviewer_binding_conflict');
    if(intent.sendAttemptedAt)return{attempted:false,intent:view(intent)};
    if(send)check(canSend(),503,'native_payment_disabled');
    // Recovery authenticates the signed public bytes without requiring current
    // roles/sequence: revocation must not prevent proving a past exact event.
    const deadline=Date.now()+Math.min(30000,native.timeoutMs||15000);
    const liveContext=send?await validateLiveEnvelope(intent,details.envelope,deadline):null;
    function stillCurrent(){fresh(liveContext,intent);check(Date.now()<deadline,409,'payment_submission_expired');}
    const marker=await store.transact(state=>{
      const current=state.nativePaymentIntents[id];requestMatches(state,current);
      if(current.envelope)check(canonicalJSON(current.envelope)===canonicalJSON(details.envelope),409,'payment_envelope_conflict');
      if(current.sendAttemptedAt)return{send:false,intent:current};
      check(!hasPendingPilotSend(state,current.payer),409,'native_pilot_intent_pending');
      agreed(current);
      // A recovery claim is untrusted until exact finality; it cannot reserve
      // somebody else's public effect merely by naming it in uploaded bytes.
      if(send){stillCurrent();bindEffect(state,current,details.effects);}
      Object.assign(current,details,{reviewerBinding,sendAttemptedAt:new Date().toISOString(),status:send?'broadcasting':'unknown',submissionMode:send?'server-once':'receipt-only',updatedAt:new Date().toISOString()});
      return{send,intent:current};
    });
    if(!marker.send)return{attempted:false,intent:view(marker.intent)};
    // fsync/queue completion may outlast the validated context. Retain the
    // exact marker and envelope for receipt recovery, but never send stale
    // authority or turn this retained request into an automatic retry.
    let outcome={status:'unknown'},attempted=false;
    try{stillCurrent();}catch(error){outcome={status:'not-broadcast',broadcastAttempted:false,broadcastPreventedReason:error instanceof NativePaymentError?error.code:'native_proof_unavailable'};}
    if(outcome.status!=='not-broadcast'){
      attempted=true;
      try{const result=await native.broadcastPayment(details.envelope,{timeoutMs:Math.max(1,deadline-Date.now())});
        if(result.transactionHash===details.transactionHash && Number.isInteger(result.code) && result.code>=0 && result.accepted===(result.code===0))outcome={status:result.accepted?'submitted':'refused',broadcastCode:result.code};
      }catch{}
    }
    const result=await store.transact(state=>{const current=state.nativePaymentIntents[id];if(current.status==='broadcasting')Object.assign(current,outcome);return current;});
    return{attempted,intent:view(result)};
  }
  const service={
    get enabled(){return canSend();},
    get(user,id){return{intent:view(owned(user,id))};},
    list(user){holder(user);return{intents:Object.values(store.read().nativePaymentIntents??{}).filter(i=>[i.payer,i.payee].includes(user.address)).map(view)};},
    async prepare(user,body){
      const raw=holder(user),allowed=['clientRequestId','to','amountUnits',...(Object.hasOwn(body??{},'requestId')?['requestId','requestVersion']:[]),...(Object.hasOwn(body??{},'memo')?['memo']:[]),...(Object.hasOwn(body??{},'expectedTradeDigest')?['expectedTradeDigest']:[])];
      check(exact(body,allowed) && typeof body.clientRequestId==='string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId) && typeof body.to==='string' && ADDRESS.test(body.to) && body.to!==user.address && typeof body.amountUnits==='string' && /^[1-9][0-9]{0,20}$/.test(body.amountUnits) && BigInt(body.amountUnits)<=MAX_PAYMENT && (!Object.hasOwn(body,'requestId') || typeof body.requestId==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(body.requestId) && typeof body.requestVersion==='string' && body.requestVersion.length>0 && body.requestVersion.length<=100),400,'invalid_payment_intent');
      check(body.memo===undefined || typeof body.memo==='string' && body.memo.length<=500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.memo),400,'invalid_payment_intent');
      check(!Object.hasOwn(body,'expectedTradeDigest') || typeof body.requestId==='string' && typeof body.expectedTradeDigest==='string' && HASH.test(body.expectedTradeDigest),400,'invalid_payment_intent');
      const prior=Object.values(store.read().nativePaymentIntents??{}).find(i=>i.payer===user.address && i.clientRequestId===body.clientRequestId);
      const input={to:body.to,amountUnits:body.amountUnits,requestId:body.requestId??null,requestVersion:body.requestVersion??null,memo:body.memo??''};
      if(Object.hasOwn(body,'expectedTradeDigest'))input.expectedTradeDigest=body.expectedTradeDigest;
      if(prior){check(prior.inputDigest===hash(canonicalJSON(input)),409,'payment_idempotency_conflict');return{created:false,intent:view(prior)};}
      const context=await proven({member:user.address,keys:['member/'+body.to]});
      licensed(context.state.member,user.address,raw.toString('base64'));
      const payeeKey=licensed(context.state.records['member/'+body.to],body.to);
      const result=await store.transact(state=>{
        state.nativePaymentIntents??={};state.nativePaymentRequestLocks??={};
        const existing=Object.values(state.nativePaymentIntents).find(i=>i.payer===user.address && i.clientRequestId===body.clientRequestId);
        if(existing){check(existing.inputDigest===hash(canonicalJSON(input)),409,'payment_idempotency_conflict');return{created:false,intent:existing};}
        check(Object.keys(state.nativePaymentIntents).length<10000 && Object.values(state.nativePaymentIntents).filter(i=>i.payer===user.address).length<128,429,'payment_intent_capacity');
        let snapshot=null,trade=null;
        if(body.requestId){const request=state.requests?.[body.requestId];check(request && request.status==='open',409,'payment_request_changed');check(!paymentRequestExpired(request),409,'payment_request_expired','This payment request has expired.');check(request.to===user.address && request.from===body.to && request.currency==='AI$' && request.updatedAt===body.requestVersion && units(request.amount)===body.amountUnits && (body.memo===undefined || body.memo===(request.memo??'')),409,'payment_request_changed');trade=tradeRequestBinding(request,validateTradeRequest);tradeAvailability?.assert('payment.start',{request});check(trade?body.expectedTradeDigest===trade.tradeDigest:body.expectedTradeDigest===undefined,trade?409:400,trade?'payment_trade_review_required':'invalid_payment_intent');check(!state.nativePaymentRequestLocks[body.requestId],409,'payment_request_locked');const sendLock=state.serverSendRequestLocks?.[body.requestId];check(!sendLock||['expired','cancelled','checker-refused'].includes(state.serverSendIntents?.[sendLock]?.status),409,'payment_request_locked');check(!Object.values(state.serverSendIntents??{}).some(r=>r?.intent?.requestId===body.requestId&&r.status==='finalized'),409,'payment_request_paid','This request is already paid; the recipient now confirms receipt, so do not pay it again.');snapshot=requestSnapshot(request);}
        const stamp=new Date().toISOString(),id=randomUUID();
        const frozen=snapshot??{payer:user.address,payee:body.to,amountUnits:body.amountUnits,clientRequestId:body.clientRequestId,memo:body.memo??''};
        const intent={id,clientRequestId:body.clientRequestId,payer:user.address,payee:body.to,payerPublicKey:raw.toString('base64'),payeePublicKey:payeeKey.toString('base64'),amountUnits:body.amountUnits,memo:snapshot?.memo??body.memo??'',requestId:body.requestId??null,requestVersion:body.requestVersion??null,requestDigest:hash(canonicalJSON(frozen)),inputDigest:hash(canonicalJSON(input)),chainId:context.proof.chainId,genesisSha256:context.proof.epoch,proof:context.proof,afterEvent:context.state.event_count,scanCursor:context.state.event_count,status:'awaiting-agreement',agreements:{},purposeCommitment:null,envelope:null,effects:null,sendAttemptedAt:null,createdAt:stamp,updatedAt:stamp};
        if(trade)intent.tradeDigest=trade.tradeDigest;
        state.nativePaymentIntents[id]=intent;if(body.requestId)state.nativePaymentRequestLocks[body.requestId]=id;return{created:true,intent};
      });return{created:result.created,intent:view(result.intent)};
    },
    async agree(user,id,body){
      const intent=owned(user,id);open(intent);check(exact(body,['purposeCommitment','signature']) && HASH.test(body.purposeCommitment),400,'invalid_payment_agreement');
      check(!intent.purposeCommitment || intent.purposeCommitment===body.purposeCommitment,409,'payment_agreement_conflict');
      check(verify(null,paymentAgreementBytes(intent,body.purposeCommitment),keyObject(holder(user)),raw64(body.signature,64)),400,'invalid_payment_signature');
      const result=await store.transact(state=>{const current=state.nativePaymentIntents[id];open(current);requestMatches(state,current);check(!current.purposeCommitment || current.purposeCommitment===body.purposeCommitment,409,'payment_agreement_conflict');current.purposeCommitment=body.purposeCommitment;const prior=current.agreements[user.address];check(!prior || prior===body.signature,409,'payment_agreement_conflict');current.agreements[user.address]=body.signature;if(!current.sendAttemptedAt && current.agreements[current.payer] && current.agreements[current.payee])current.status='intent-ready';return current;});return{intent:view(result)};
    },
    async abandon(user,id,body){
      owned(user,id);check(exact(body,[]),400,'invalid_payment_abandon');
      // T1: never lock permanently. Nothing sent (even after both agreements)
      // or a proved expired-unused send may be abandoned; any other send must
      // first be reconciled, and a recorded payment never can be.
      const result=await store.transact(state=>{const intent=state.nativePaymentIntents[id];if(intent.status==='abandoned')return intent;check(!RECORDED.includes(intent.status),409,'payment_intent_locked');check(intent.status==='expired-unused' || !intent.envelope && !intent.sendAttemptedAt,409,'payment_reconcile_required','Reconcile the submitted payment before abandoning it.');intent.status='abandoned';intent.updatedAt=new Date().toISOString();if(intent.requestId && state.nativePaymentRequestLocks?.[intent.requestId]===id)delete state.nativePaymentRequestLocks[intent.requestId];return intent;});return{intent:view(result)};
    },
    submit:(user,id,body)=>attach(user,id,body,true),
    recover:(user,id,body)=>attach(user,id,body,false),
    async receipt(user,id,body){
      check(exact(body,[]),400,'invalid_payment_receipt');const intent=owned(user,id);check(intent.envelope && intent.sendAttemptedAt,409,'payment_not_submitted');
      verifyReviewerBinding(intent,intent.envelope,intent.reviewerBinding);
      if(RECORDED.includes(intent.status) || intent.recovery)return{intent:view(intent)};
      const head=await proven({},intent),cursor=BigInt(intent.scanCursor),count=BigInt(head.state.event_count);proofError(cursor<=count);
      const end=cursor+32n<count?cursor+32n:count,ids=[];for(let n=cursor+1n;n<=end;n++)ids.push(String(n));
      const batch=ids.length?await proven({keys:ids.map(n=>'event/'+n.padStart(20,'0'))},intent):head;proofError(BigInt(batch.state.height)>=BigInt(head.state.height));
      for(const eventId of ids){const event=batch.state.records['event/'+eventId.padStart(20,'0')];proofError(event?.id===eventId && HASH.test(event.command_digest??''));if(event.command_digest!==intent.commandDigest)continue;
        const matches=e=>e?.id===eventId && e.command_digest===intent.commandDigest && e.member===intent.envelope.command.member && e.operation==='private_payment' && e.subject===intent.effects && !e.instance;
        proofError(matches(event));
        const context=await proven({receipt:{envelope:intent.envelope,event_id:eventId}},intent),receipt=context.state.receipt;
        proofError(BigInt(context.state.height)>=BigInt(batch.state.height) && receipt?.authority==='native' && receipt.finalized===true && receipt.chain_id===intent.chainId && receipt.state_height===context.state.height && receipt.app_hash===context.proof.appHash && matches(receipt.event));
        const result=await store.transact(state=>{const current=state.nativePaymentIntents[id];if(current.recovery)return current;bindEffect(state,current,current.effects);if(current.status!=='recipient-confirmed-paid')current.status='ledger-recorded';current.receipt={...receipt,proof:context.proof};current.scanCursor=eventId;current.moreEvents=false;return current;});return{intent:view(result)};
      }
      const result=await store.transact(state=>{const current=state.nativePaymentIntents[id];if(!RECORDED.includes(current.status) && !current.recovery && BigInt(current.scanCursor)<end)current.scanCursor=String(end);current.moreEvents=end<count;return current;});return{intent:view(result)};
    },
    /** T1 recovery: prove the exact retained envelope can never be included
     * (past its expiry height, relay sequence unconsumed, no private_payment
     * record), then close it as expired-unused and release the request lock
     * and effect binding. Never sends; a present record means use receipt. */
    async reconcile(user,id,body){
      check(exact(body,[]),400,'invalid_payment_reconcile');const intent=owned(user,id,true);
      if(intent.recovery)return{intent:view(intent)};
      check(intent.envelope && intent.sendAttemptedAt,409,'payment_not_submitted');
      check(!RECORDED.includes(intent.status),409,'payment_already_recorded');
      const c=intent.envelope.command,recordKey='private_payment/'+intent.effects;
      let digest;try{digest=hash(signingBytes(c));}catch{proofError(false);}
      proofError(digest===intent.commandDigest && c.payload.approval.effects===intent.effects);
      const deadline=Date.now()+Math.min(30000,native.timeoutMs||15000);
      const context=await proven({member:c.member,keys:[recordKey]},intent,deadline),records=context.state.records??{},relay=context.state.member;
      proofError(relay?.id===c.member && UINT.test(relay.sequence??'') && Object.hasOwn(records,recordKey));
      check(records[recordKey]===null,409,'payment_record_present','The payment record exists on the native ledger; use receipt to record it.');
      check(BigInt(context.state.height)>BigInt(c.expires_height) && relay.sequence===c.sequence,409,'payment_recovery_not_ready','The submitted payment has not provably expired unused yet.');
      const saved=await store.transact(state=>{
        const current=state.nativePaymentIntents[id];
        // Keep the first terminal outcome, including a receipt that won this race.
        if(current.recovery || RECORDED.includes(current.status))return current;
        check(current.sendAttemptedAt===intent.sendAttemptedAt && canonicalJSON(current.envelope)===canonicalJSON(intent.envelope),409,'payment_envelope_conflict');
        fresh(context,current);check(Date.now()<deadline,409,'payment_submission_expired');
        current.recovery={schema:'baink-native-payment-recovery-v1',verified:true,status:'expired-unused',paid:false,priorStatus:current.status==='broadcasting'?'unknown':current.status,commandDigest:current.commandDigest,relay:c.member,sequence:c.sequence,expiresHeight:c.expires_height,recordKey,recordPresent:false,proof:context.proof};
        current.status='expired-unused';current.updatedAt=new Date().toISOString();
        if(current.requestId && state.nativePaymentRequestLocks?.[current.requestId]===id)delete state.nativePaymentRequestLocks[current.requestId];
        const key=effectKey(current,current.effects);if(state.nativePaymentEffects?.[key]===id)delete state.nativePaymentEffects[key];
        return current;
      });return{intent:view(saved)};
    },
    async confirm(user,id,body){
      const intent=owned(user,id);check(user.address===intent.payee,403,'payment_recipient_required');
      check(exact(body,['effects','chainId','requestDigest','locallyInspected','signature']) && body.effects===intent.effects && body.chainId===intent.chainId && body.requestDigest===intent.requestDigest && body.locallyInspected===true,400,'invalid_payment_confirmation');
      check(['ledger-recorded','recipient-confirmed-paid'].includes(intent.status),409,'payment_not_recorded');
      verifyReviewerBinding(intent,intent.envelope,intent.reviewerBinding);
      check(verify(null,paymentConfirmationBytes(intent),keyObject(holder(user)),raw64(body.signature,64)),400,'invalid_payment_signature');
      const result=await store.transact(state=>{const current=state.nativePaymentIntents[id];if(current.status==='recipient-confirmed-paid')return current;requestMatches(state,current);check(current.status==='ledger-recorded',409,'payment_not_recorded');current.status='recipient-confirmed-paid';current.recipientAcknowledgement={signature:body.signature,locallyInspected:true,at:new Date().toISOString()};if(current.requestId){const request=state.requests[current.requestId];request.status='paid';request.paymentIntentId=id;request.settlement={kind:'native-private-payment',effects:current.effects,chainId:current.chainId,requestDigest:current.requestDigest,amountVerification:'recipient-attested',publicAmountProof:false};addPaymentRequestHistory(state,'request.paid',request,user.address);}return current;});return{intent:view(result)};
    },
  };
  return Object.freeze(service);
}
