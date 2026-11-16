import { hasPendingNativeSend } from './native-sequence-fence.mjs';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { nativeFinancialSigningBytes } from './native-financial-command.mjs';

const HASH=/^[a-f0-9]{64}$/, ADDRESS=/^uain1[a-f0-9]{40}$/, ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const UINT=/^(0|[1-9][0-9]{0,19})$/, AMOUNT=/^(0|[1-9][0-9]{0,20})$/, EVENT=/^[0-9]{20}$/;
const CAP=108000000000000000000n;
const sha=x=>createHash('sha256').update(x).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const policies={storage_activation:'compact-state-v1',membership_activation:'project-membership-v1',operator_reward_activation:'pairwise-operator-rewards-v1',private_activation:'orchard-v2-reviewed-otc-v1',coin_activation:'verified-bounties-108t-micro-v1'};
const GLOBAL=[...Object.keys(policies),'coin_supply','guardians','guardian_epoch_current'];
export class NativeEarningError extends Error { constructor(status,code){super(code);this.status=status;this.code=code} }
const check=(ok,status,code)=>{if(!ok)throw new NativeEarningError(status,code)};
const proofOK=ok=>check(ok,503,'native_proof_unavailable');
const decimal=x=>typeof x==='string'&&UINT.test(x);
const quantity=x=>typeof x==='string'&&AMOUNT.test(x)&&BigInt(x)<=CAP;
function inputPayload(operation,p) {
 if(operation==='coin_quote')check(exact(p,['task','open_event','amount','evidence_digest'])&&typeof p.task==='string'&&ID.test(p.task)&&typeof p.open_event==='string'&&EVENT.test(p.open_event)&&BigInt(p.open_event)>0n&&quantity(p.amount)&&BigInt(p.amount)>0n&&HASH.test(p.evidence_digest),400,'invalid_earning_payload');
 else if(operation==='coin_reserve')check(exact(p,['task','evidence_digest'])&&typeof p.task==='string'&&ID.test(p.task)&&HASH.test(p.evidence_digest),400,'invalid_earning_payload');
 else if(operation==='coin_claim')check(exact(p,['contribution'])&&typeof p.contribution==='string'&&ID.test(p.contribution),400,'invalid_earning_payload');
 else check(false,400,'invalid_earning_operation');
 return operation==='coin_quote'?{task:p.task,open_event:p.open_event,amount:p.amount,evidence_digest:p.evidence_digest}:operation==='coin_reserve'?{task:p.task,evidence_digest:p.evidence_digest}:{contribution:p.contribution};
}
export function nativeEarningSigningBytes(command) {
 check(exact(command,['version','chain_id','member','sequence','expires_height','operation','payload'])&&command.version===1&&ADDRESS.test(command.member)&&decimal(command.sequence)&&BigInt(command.sequence)<18446744073709551615n&&decimal(command.expires_height)&&BigInt(command.expires_height)>0n&&BigInt(command.expires_height)<=9223372036854775807n,400,'invalid_native_command');
 inputPayload(command.operation,command.payload);
 return nativeFinancialSigningBytes(command);
}
function holder(user) {
 check(typeof user?.publicKey==='string'&&ADDRESS.test(user.address),401,'invalid_native_holder');
 const key=Buffer.from(user.publicKey,'base64');
 check(key.length===32&&key.toString('base64')===user.publicKey&&'uain1'+sha(key).slice(0,40)===user.address,401,'invalid_native_holder');return key.toString('base64url');
}
// Struct field order and HTML escaping match Go's immutable metadata encoder.
function metadata(record,meta,task=false) {
 proofOK(object(meta)&&meta.id===record.id&&typeof meta.title==='string'&&['benevolent','neutral'].includes(meta.class)&&object(meta.prior_art)&&typeof meta.prior_art.basis==='string'&&Array.isArray(meta.prior_art.searches)&&meta.prior_art.searches.every(s=>typeof s==='string'));
 const value={id:meta.id,title:meta.title,class:meta.class,prior_art:{basis:meta.prior_art.basis,searches:meta.prior_art.searches}};
 if(task){proofOK(typeof meta.criteria==='string');value.criteria=meta.criteria}
 const raw=JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 proofOK(HASH.test(record.metadata_digest??'')&&sha(raw)===record.metadata_digest);return value;
}
const rows=x=>Array.isArray(x)?x: x===null||x===undefined?[]:null;
function supply(record) {
 proofOK(exact(record,['minted','reserved','transparent','shielded'])&&Object.values(record).every(quantity));
 proofOK(BigInt(record.minted)+BigInt(record.reserved)<=CAP&&BigInt(record.transparent)+BigInt(record.shielded)===BigInt(record.minted));return record;
}
/** Public native earning only. The injected reader is the pinned native adapter,
 * never browser/indexer JSON. Keys/signatures remain with each account holder.
 * The injected store must atomically persist and fsync transact() before return.
 */
export function createNativeEarningService({store,native,enabled=false}) {
 const canSend=()=>enabled===true&&native.configured===true&&typeof native.broadcastEarning==='function';
 function fresh(p,s,{historical=false}={}) {
  const age=Date.now()-Date.parse(p?.headerTime);
  proofOK(native.configured===true&&HASH.test(native.pins?.epoch??'')&&HASH.test(native.pins?.verifierSha256??'')&&p?.authority==='native'&&p.chainId===native.pins.chainId&&p.epoch===native.pins.epoch&&p.genesisSha256===native.pins.epoch&&p.verifierSha256===native.pins.verifierSha256&&Number.isFinite(age)&&age>=-60000&&Number.isInteger(p.maxAgeSeconds)&&p.maxAgeSeconds>=1&&p.maxAgeSeconds<=120&&(historical||age<=p.maxAgeSeconds*1000)&&decimal(p.height)&&BigInt(p.height)>0n&&HASH.test(p.appHash??''));
  if(s)proofOK(s.chain_id===p.chainId&&s.height===p.height&&s.app_hash===p.appHash&&decimal(s.event_count)&&object(s.records));
 }
 async function proven(selection,intent,deadline=Date.now()+native.timeoutMs) {
  proofOK(Date.now()<deadline);let c;
  try{c=await native.publicState(selection,{timeoutMs:Math.max(1,deadline-Date.now())})}catch{proofOK(false)}
  fresh(c?.proof,c?.state);proofOK(object(c?.state));
  for(const k of selection.keys??[])proofOK(Object.hasOwn(c.state.records,k));
  if(intent)proofOK(c.proof.epoch===intent.proof.epoch&&c.proof.verifierSha256===intent.proof.verifierSha256&&c.state.chain_id===intent.command.chain_id&&BigInt(c.state.height)>=BigInt(intent.proof.height));
  return c;
 }
 function account(c,user,key) {
  const m=c.state.member;proofOK(m?.id===user.address&&m.public_key===key&&decimal(m.sequence)&&BigInt(m.sequence)<18446744073709551615n);return m;
 }
 // Multiple dependent selections must prove the same state root. Even if an
 // empty block advances height, no changed source can be stitched into a plan.
 async function context(user,request={},intent,deadline=Date.now()+native.timeoutMs) {
  const key=holder(user), first=await proven({member:user.address,keys:GLOBAL},intent,deadline),m=account(first,user,key);
  let latest=first;const r={...first.state.records};
  async function add(keys) {
   keys=[...new Set(keys)].filter(k=>!Object.hasOwn(r,k));
   for(let at=0;at<keys.length;at+=32){const c=await proven({member:user.address,keys:keys.slice(at,at+32)},intent,deadline);proofOK(c.proof.appHash===first.proof.appHash&&BigInt(c.proof.height)>=BigInt(latest.proof.height)&&c.state.event_count===first.state.event_count&&account(c,user,key).sequence===m.sequence);Object.assign(r,c.state.records);latest=c}
  }
  let currentGuardians=r.guardians;
  if(r.guardian_epoch_current!==null){const epoch=r.guardian_epoch_current;proofOK(typeof epoch==='string'&&ID.test(epoch));await add(['guardian_epoch/'+epoch]);const current=r['guardian_epoch/'+epoch];proofOK(current?.id===epoch&&decimal(current.height)&&BigInt(current.height)>=1n&&BigInt(current.height)<=BigInt(latest.state.height)&&HASH.test(current.evidence_digest??''));currentGuardians=current.guardians}
  proofOK(Array.isArray(currentGuardians)&&currentGuardians.length>=1&&currentGuardians.length<=20&&new Set(currentGuardians).size===currentGuardians.length&&currentGuardians.every(x=>ADDRESS.test(x)));
  let task=request.task,contribution=null;
  if(request.contribution){await add(['contribution/'+request.contribution,'coin_reward/'+request.contribution]);contribution=r['contribution/'+request.contribution];if(contribution!==null){proofOK(contribution.id===request.contribution&&ID.test(contribution.task));check(!task||task===contribution.task,400,'earning_task_mismatch');task=contribution.task}}
  let t=null,p=null,tm=null,pm=null,opening=null,quote=null,reservation=null,checks=[];
  if(task){await add(['task/'+task,'task_metadata/'+task,'coin_quote/'+task,'coin_reservation/'+task]);t=r['task/'+task];quote=r['coin_quote/'+task];reservation=r['coin_reservation/'+task];
   if(t!==null){proofOK(t.id===task&&ID.test(t.project)&&rows(t.submissions)!==null&&rows(t.open_challenges)!==null);tm=t.storage_policy==='compact-state-v1'?metadata(t,r['task_metadata/'+task],true):null;await add(['project/'+t.project,'project_metadata/'+t.project,'participation/'+t.project+'/'+user.address+'/']);p=r['project/'+t.project];proofOK(p?.id===t.project&&ADDRESS.test(p.lead));pm=p.storage_policy==='compact-state-v1'?metadata(p,r['project_metadata/'+t.project]):null;
    const event=request.openEvent??quote?.open_event;if(event!==undefined){proofOK(typeof event==='string'&&EVENT.test(event)&&BigInt(event)>0n);await add(['event/'+event]);opening=r['event/'+event];if(opening!==null)proofOK(decimal(opening.id)&&opening.id.padStart(20,'0')===event)}
   }
  }
  if(contribution?.settlement){const refs=contribution.settlement.check_refs;proofOK(!contribution.arbitration_policy||contribution.arbitration_policy==='bounded-research-arbitration-v1');proofOK(!contribution.research_policy||contribution.research_policy==='bounded-research-proceedings-v1'&&contribution.arbitration_policy==='bounded-research-arbitration-v1');const limit=contribution.arbitration_policy==='bounded-research-arbitration-v1'?(contribution.research_policy==='bounded-research-proceedings-v1'?23:22):20;proofOK(rows(contribution.settlement.checks)?.length===0&&Array.isArray(refs)&&refs.length>=1&&refs.length<=limit&&new Set(refs).size===refs.length&&refs.every(x=>HASH.test(x)));await add(refs.map(ref=>'verification_summary/'+contribution.id+'/'+ref));checks=refs.map(ref=>{const v=r['verification_summary/'+contribution.id+'/'+ref];proofOK(v?.record_digest===ref&&ADDRESS.test(v.member)&&rows(v.searches)?.length===0);return v})}
  const c={state:{...first.state,height:latest.state.height,header_time:latest.state.header_time,records:r},proof:latest.proof,member:m,currentGuardians,task:t,project:p,taskMetadata:tm,projectMetadata:pm,contribution,quote,reservation,opening,checks};
  // AppHash equality means every selected record belongs to this final root.
  fresh(c.proof,c.state);return c;
 }
 function policyBlockers(c) {
  const blockers=[];
  for(const [k,policy] of Object.entries(policies)){const a=c.state.records[k];if(a===null){blockers.push(k+'_inactive');continue}const h=a?.height??a?.effective_height;proofOK(a?.policy===policy&&decimal(h)&&BigInt(h)>=2n&&HASH.test(a.evidence_digest??''));if(BigInt(h)>BigInt(c.state.height))blockers.push(k+'_inactive')}
  if(c.state.records.coin_supply===null)blockers.push('coin_supply_unavailable');else supply(c.state.records.coin_supply);
  proofOK(Array.isArray(c.state.records.guardians)&&c.state.records.guardians.every(x=>ADDRESS.test(x)));return blockers;
 }
 function openingValid(c) {
  const e=c.opening,t=c.task,p=c.project,a=c.state.records.coin_activation;
  return object(e)&&decimal(e.id)&&decimal(e.height)&&e.operation==='open_task'&&e.subject===t?.id&&e.member===p?.lead&&!e.origin&&HASH.test(e.command_digest??'')&&a&&BigInt(e.height)>=BigInt(a.height)&&BigInt(e.height)<=BigInt(c.state.height);
 }
 function blockers(c,operation,payload,user) {
  const b=policyBlockers(c),t=c.task,p=c.project,v=c.contribution,r=c.state.records;
  if(c.member.licence!=='active')b.push('native_licence_inactive');
  if(!t||!p){b.push('native_task_required');return b}
  if(p.operator_policy!==policies.operator_reward_activation||p.membership_policy!==policies.membership_activation||p.storage_policy!==policies.storage_activation||t.storage_policy!==policies.storage_activation||t.reward_policy!=='pilot-credits-v1')b.push('prospective_native_policies_required');
  if(p.safety_halted!==false)b.push('project_safety_halted');
  if(rows(t.open_challenges).length||t.prior_art_decision)b.push('unresolved_or_upheld_prior_art');
  if(!openingValid(c))b.push('post_activation_native_opening_required');
  const q=c.quote,res=c.reservation;
  if(operation==='coin_quote'||operation==='coin_reserve'){
   if(p.state!=='active'||t.state!=='open'||t.winner||rows(t.submissions).length)b.push('unstarted_active_task_required');
   if(t.kind==='future'&&(!t.kpi||!Number.isFinite(Date.parse(t.kpi.resolves_by))||Date.parse(t.kpi.resolves_by)<=Date.now()))b.push('kpi_expired_or_unresolved');
   if(res!==null)b.push('reservation_already_exists');
  }
  if(operation==='coin_quote'){
   if(p.lead!==user.address)b.push('project_lead_required');
   const joined=r['participation/'+p.id+'/'+user.address+'/'];if(joined?.project!==p.id||joined.member!==user.address||joined.instance)b.push('project_participation_required');
   if(q!==null)b.push('quote_already_exists');
   if(c.opening?.id!==String(BigInt(payload.open_event)))b.push('opening_event_mismatch');
  }
  if(operation==='coin_reserve'||operation==='coin_claim'){
   if(!q||q.task!==t.id||q.manager!==p.lead||!quantity(q.amount)||BigInt(q.amount)<=0n||!decimal(q.height)||!HASH.test(q.evidence_digest??'')||!c.opening||q.open_event!==c.opening.id.padStart(20,'0')||BigInt(q.height)<BigInt(c.opening.height)||BigInt(q.height)>BigInt(c.state.height))b.push('valid_native_quote_required');
  }
  if(operation==='coin_reserve'){
   if(!c.currentGuardians.includes(user.address))b.push('guardian_required');
   if(q&&quantity(q.amount)&&r.coin_supply&&BigInt(q.amount)>CAP-BigInt(r.coin_supply.minted)-BigInt(r.coin_supply.reserved))b.push('insufficient_unreserved_supply');
  }
  if(operation==='coin_claim'){
   const s=v?.settlement;
   if(!v||v.author!==user.address)b.push('winning_author_required');
   if(!v||v.state!=='settled'||v.award_withheld||t.state!=='settled'||t.winner!==v.id)b.push('settled_unwithheld_winner_required');
   if(!s||s.paid!==true||s.policy!=='pilot-credits-v1'||s.factor_numerator!==1||s.factor_denominator!==1)b.push('fully_paid_native_settlement_required');
   if(!s||!Number.isInteger(s.independent_operators)||s.independent_operators<2)b.push('two_independent_operators_required');
   if(s?.other_family!==true)b.push('other_model_family_required');
   if(!Number.isInteger(t.verifiers_required)||t.verifiers_required<2||c.checks.length<t.verifiers_required||new Set(c.checks.map(x=>x.member)).size!==c.checks.length||c.checks.some(x=>x.member===v?.author||x.verdict!=='confirm'||x.novelty!=='new'))b.push('frozen_new_novelty_checks_required');
   if(!res||res.task!==t.id||res.state!=='reserved'||res.amount!==q?.amount||!decimal(res.height)||!decimal(q?.height)||BigInt(res.height)<BigInt(q.height)||BigInt(res.height)>BigInt(c.state.height)||!HASH.test(res.evidence_digest??''))b.push('unpaid_native_reservation_required');
   if(v&&r['coin_reward/'+v.id]!==null)b.push('reward_already_claimed');
  }
  return [...new Set(b)];
 }
 function eligible(c,operation,payload,user){const missing=blockers(c,operation,payload,user);check(!missing.length,409,missing[0]);return c.member}
 const requestFor=(op,p)=>op==='coin_claim'?{contribution:p.contribution}:{task:p.task,...(op==='coin_quote'?{openEvent:p.open_event}:{})};
 function owned(user,id){holder(user);const i=store.read().nativeEarningIntents?.[id];check(i?.member===user.address,404,'earning_intent_missing');return i}
 function historicalAward(i) {
  const r=i.receipt,e=r?.event,result=i.result;
  proofOK(i.status==='finalized'&&i.command?.operation==='coin_claim'&&i.command.member===i.member&&i.sendAttemptedAt&&r?.authority==='native'&&r.finalized===true&&r.chain_id===i.command.chain_id&&result?.verified===true&&result.paid===true&&result.status==='earned'&&quantity(result.amountUnits)&&result.amountUnits===i.expectedAmount);
  const user={address:i.member,publicKey:Buffer.from(i.publicKey,'base64url').toString('base64')};
  const envelope=envelopeFor(i,{envelope:i.envelope},user);
  proofOK(sha(nativeEarningSigningBytes(i.command))===i.commandDigest&&sha(JSON.stringify(envelope)).toUpperCase()===i.transactionHash&&e?.member===i.member&&e.operation==='coin_claim'&&e.subject===i.command.payload.contribution&&e.command_digest===i.commandDigest&&!e.instance&&!e.origin&&decimal(e.id)&&BigInt(e.id)>0n&&decimal(e.height)&&decimal(r.state_height)&&BigInt(r.state_height)>=BigInt(e.height));
  fresh(r.proof,null,{historical:true});fresh(result.proof,null,{historical:true});
  proofOK(r.proof.chainId===r.chain_id&&r.proof.height===r.state_height&&r.proof.appHash===r.app_hash&&result.proof.chainId===r.chain_id&&BigInt(result.proof.height)>=BigInt(r.state_height));
 }
 function view(i){const out=structuredClone(i);out.finalized=i.status==='finalized';out.receiptRequired=Boolean(i.sendAttemptedAt)&&!out.finalized&&i.status!=='expired-unused';if(out.status==='broadcasting')out.status='unknown';if(out.result?.verified){try{if(out.result.paid===true){historicalAward(i);out.result.historicalReceipt=true}else fresh(out.result.proof)}catch{out.result={verified:false,status:'proof_unavailable'}}}return out}
 function envelopeFor(i,body,user){check(exact(body,['envelope'])&&exact(body.envelope,['command','public_key','signature']),400,'invalid_native_envelope');const e=body.envelope,b=nativeEarningSigningBytes(e.command);check(b.equals(Buffer.from(i.signingBytesBase64,'base64'))&&e.public_key===i.publicKey&&holder(user)===i.publicKey,400,'native_envelope_mismatch');const sig=typeof e.signature==='string'?Buffer.from(e.signature,'base64url'):Buffer.alloc(0);check(sig.length===64&&sig.toString('base64url')===e.signature&&verify(null,b,createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:i.publicKey},format:'jwk'}),sig),400,'invalid_native_signature');return{command:structuredClone(i.command),public_key:i.publicKey,signature:e.signature}}
 async function resultFor(i,user,receipt,deadline){
  const c=await context(user,requestFor(i.command.operation,i.command.payload),i,deadline),p=i.command.payload,r=c.state.records;
  proofOK(BigInt(c.member.sequence)>BigInt(i.command.sequence)&&BigInt(c.state.height)>=BigInt(receipt.state_height));
  let amount;
  if(i.command.operation==='coin_quote'){const q=c.quote;proofOK(q?.task===p.task&&q.open_event===p.open_event&&q.manager===user.address&&q.amount===p.amount&&q.evidence_digest===p.evidence_digest&&q.height===receipt.event.height);amount=q.amount}
  else if(i.command.operation==='coin_reserve'){const v=c.reservation;proofOK(v?.task===p.task&&v.amount===i.expectedAmount&&v.evidence_digest===p.evidence_digest&&['reserved','paid','released'].includes(v.state)&&v.height===receipt.event.height);amount=v.amount}
  else{const reward=r['coin_reward/'+p.contribution];proofOK(reward?.contribution===p.contribution&&reward.task===c.task?.id&&reward.member===user.address&&reward.amount===i.expectedAmount&&c.reservation?.state==='paid'&&c.reservation.amount===reward.amount&&reward.height===receipt.event.height);amount=reward.amount}
  return{verified:true,status:i.command.operation==='coin_claim'?'earned':i.command.operation==='coin_reserve'?'reserved':'quoted',amountUnits:amount,paid:i.command.operation==='coin_claim',proof:c.proof};
 }
 const service={
  get enabled(){return canSend()},
  list(user){holder(user);return{intents:Object.values(store.read().nativeEarningIntents??{}).filter(i=>i.member===user.address).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(view)}},
  async readiness(user,body={}){
   check(object(body)&&Object.keys(body).every(k=>['task','contribution','openEvent'].includes(k))&&(!body.task||ID.test(body.task))&&(!body.contribution||ID.test(body.contribution))&&(!body.openEvent||EVENT.test(body.openEvent)),400,'invalid_earning_selection');
   const c=await context(user,body),m=c.member;proofOK(typeof m.creator==='boolean'&&typeof m.default_verifier==='boolean'&&/^-?[0-9]+$/.test(String(m.karma))&&/^[0-9]+$/.test(String(m.active_projects)));
   const karma=BigInt(m.karma),canCreate=m.licence==='active'&&(m.creator||karma>=1000n&&BigInt(m.active_projects)<1n+(karma-1000n)/10n);
   const actions={};if(c.task){for(const op of ['coin_quote','coin_reserve',...(c.contribution?['coin_claim']:[])]){const p=op==='coin_claim'?{contribution:c.contribution.id}:{task:c.task.id,...(op==='coin_quote'?{open_event:body.openEvent??c.quote?.open_event??'00000000000000000000'}:{})};const missing=blockers(c,op,p,user);actions[op]={eligible:missing.length===0,blockers:missing,...(op==='coin_quote'?{pricingEvidenceRequired:true}:{})}}}
   return{authority:'native',verified:true,proof:c.proof,enabled:canSend(),account:{member:user.address,licence:m.licence,canCreateProject:canCreate,defaultVerifier:m.default_verifier,karma:String(m.karma)},policyBlockers:policyBlockers(c),task:c.task?.id??null,actions,creditConversion:false,researchEvidenceRequired:true,requirements:['genuine_unsolved_problem_and_new_result','reviewer_default_appointment','two_independent_operators','other_model_family','reservation_before_submission','no_unresolved_prior_art_or_safety_challenges','future_kpi_met_before_claim'],reviewBasis:c.contribution?.settlement?'frozen_native_settlement':'review_team_not_established',supply:c.state.records.coin_supply};
  },
  async discover(user,body={afterEvent:'0'}){
   check(exact(body,['afterEvent'])&&decimal(body.afterEvent),400,'invalid_discovery_cursor');holder(user);const deadline=Date.now()+native.timeoutMs,head=await proven({keys:GLOBAL},null,deadline);policyBlockers({state:head.state});const cursor=BigInt(body.afterEvent),count=BigInt(head.state.event_count);check(cursor<=count,400,'invalid_discovery_cursor');const end=cursor+32n<count?cursor+32n:count,ids=[];for(let n=cursor+1n;n<=end;n++)ids.push(String(n));
   const batch=ids.length?await proven({keys:ids.map(n=>'event/'+n.padStart(20,'0'))},null,deadline):head;proofOK(batch.proof.appHash===head.proof.appHash);let scanned=cursor,examined=0;const opportunities=[];
   for(const n of ids){const e=batch.state.records['event/'+n.padStart(20,'0')];proofOK(e?.id===n&&typeof e.operation==='string');scanned=BigInt(n);if(e.operation!=='open_task'||e.origin)continue;proofOK(ID.test(e.subject));const c=await context(user,{task:e.subject,openEvent:n.padStart(20,'0')},null,deadline);proofOK(c.proof.appHash===head.proof.appHash);const t=c.task,q=c.quote,res=c.reservation;
    if(!policyBlockers(c).length&&t?.state==='open'&&!t.winner&&c.project?.state==='active'&&c.project.safety_halted===false&&c.project.operator_policy===policies.operator_reward_activation&&c.project.membership_policy===policies.membership_activation&&t.reward_policy==='pilot-credits-v1'&&c.taskMetadata&&openingValid(c)&&!rows(t.open_challenges).length&&!t.prior_art_decision&&(t.kind==='instant'||t.kind==='future'&&Number.isFinite(Date.parse(t.kpi?.resolves_by))&&Date.parse(t.kpi.resolves_by)>Date.now())&&q?.task===t.id&&q.open_event===n.padStart(20,'0')&&q.manager===c.project.lead&&HASH.test(q.evidence_digest??'')&&decimal(q.height)&&BigInt(q.height)>=BigInt(c.opening.height)&&res?.task===t.id&&res.state==='reserved'&&quantity(res.amount)&&BigInt(res.amount)>0n&&res.amount===q.amount&&HASH.test(res.evidence_digest??'')&&decimal(res.height)&&BigInt(res.height)>=BigInt(q.height)&&BigInt(res.height)<=BigInt(c.state.height))opportunities.push({task:t.id,project:t.project,title:c.taskMetadata.title,amountUnits:res.amount,assetId:'uain-native-coin',symbol:'AI$',paid:false,rewardState:'reserved',reviewRequired:true,openEvent:n.padStart(20,'0'),proof:c.proof});
    if(++examined>=4)break;
   }
   return{authority:'native',opportunities,scannedThrough:String(scanned),more:scanned<count,creditConversion:false,proof:batch.proof};
  },
  async prepare(user,body){
   const key=holder(user);check(exact(body,['clientRequestId','operation','payload'])&&typeof body.clientRequestId==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId),400,'invalid_earning_request');const p=inputPayload(body.operation,body.payload),identity=JSON.stringify({operation:body.operation,payload:p});
   const prior=Object.values(store.read().nativeEarningIntents??{}).find(i=>i.member===user.address&&i.clientRequestId===body.clientRequestId);
   if(prior){check(prior.identity===identity,409,'earning_idempotency_conflict');if(prior.sendAttemptedAt)return{created:false,intent:view(prior)}}
   const c=await context(user,requestFor(body.operation,p),prior),m=eligible(c,body.operation,p,user);
   if(prior&&body.operation!=='coin_quote')check(c.quote.amount===prior.expectedAmount,409,'earning_source_changed');
   const command=prior?.command??{version:1,chain_id:c.state.chain_id,member:user.address,sequence:m.sequence,expires_height:String(BigInt(c.state.height)+100n),operation:body.operation,payload:p};
   check(command.sequence===m.sequence,409,'native_sequence_changed');check(BigInt(c.state.height)<BigInt(command.expires_height),409,'earning_intent_expired');const bytes=nativeEarningSigningBytes(command),now=new Date().toISOString();
   const result=await store.transact(state=>{state.nativeEarningIntents??={};const previous=Object.values(state.nativeEarningIntents).filter(i=>i.member===user.address),same=previous.find(i=>i.clientRequestId===body.clientRequestId);if(same){check(same.identity===identity,409,'earning_idempotency_conflict');if(!same.sendAttemptedAt)same.proof=c.proof;return{created:false,intent:same}}
    // A send-marked request never becomes replaceable just because it expired.
    // Its exact receipt must first be resolved; expiry does not prove absence.
    for(const old of previous.filter(i=>i.status!=='finalized'&&i.status!=='expired-unused')){check(!old.sendAttemptedAt&&BigInt(old.command.expires_height)<BigInt(c.state.height),409,'earning_intent_pending');old.status='expired'}
    check(previous.length<256&&Object.keys(state.nativeEarningIntents).length<10000,429,'earning_intent_capacity');const i={id:randomUUID(),member:user.address,publicKey:key,clientRequestId:body.clientRequestId,identity,status:'prepared',command,signingBytesBase64:bytes.toString('base64'),commandDigest:sha(bytes),expectedAmount:body.operation==='coin_quote'?p.amount:c.quote.amount,proof:c.proof,afterEvent:c.state.event_count,scanCursor:c.state.event_count,envelope:null,sendAttemptedAt:null,transactionHash:null,result:{verified:false,status:'pending'},createdAt:now,updatedAt:now};state.nativeEarningIntents[i.id]=i;return{created:true,intent:i}});
   return{created:result.created,intent:view(result.intent)};
  },
  async submit(user,id,body){
   check(canSend(),503,'native_earning_disabled');const i=owned(user,id),envelope=envelopeFor(i,body,user);if(i.envelope)check(JSON.stringify(i.envelope)===JSON.stringify(envelope),409,'native_envelope_conflict');if(i.sendAttemptedAt)return{attempted:false,intent:view(i)};
   const deadline=Date.now()+native.timeoutMs,c=await context(user,requestFor(i.command.operation,i.command.payload),i,deadline),m=eligible(c,i.command.operation,i.command.payload,user);check(m.sequence===i.command.sequence,409,'native_sequence_changed');if(i.command.operation!=='coin_quote')check(c.quote.amount===i.expectedAmount,409,'earning_source_changed');check(BigInt(c.state.height)<BigInt(i.command.expires_height),409,'earning_intent_expired');fresh(c.proof,c.state);
   const marker=await store.transact(state=>{const current=state.nativeEarningIntents[id];check(current?.member===user.address,404,'earning_intent_missing');if(current.sendAttemptedAt)return{send:false,intent:current};check(!hasPendingNativeSend(state,user.address),409,'native_sequence_pending');fresh(c.proof,c.state);proofOK(Date.now()<deadline);current.envelope=envelope;current.transactionHash=sha(JSON.stringify(envelope)).toUpperCase();current.sendAttemptedAt=new Date().toISOString();current.updatedAt=current.sendAttemptedAt;current.status='broadcasting';return{send:true,intent:current}});if(!marker.send)return{attempted:false,intent:view(marker.intent)};
   let outcome={status:'unknown',broadcastCode:null};try{const reply=await native.broadcastEarning(envelope,{timeoutMs:Math.max(1,deadline-Date.now())});if(reply.transactionHash===marker.intent.transactionHash&&Number.isInteger(reply.code)&&reply.code>=0&&reply.accepted===(reply.code===0))outcome={status:reply.accepted?'accepted':'refused',broadcastCode:reply.code}}catch{}
   const result=await store.transact(state=>{const current=state.nativeEarningIntents[id];if(current.status==='broadcasting'){Object.assign(current,outcome);current.updatedAt=new Date().toISOString()}return current});return{attempted:true,intent:view(result)};
  },
  async reconcile(user,id,body){
   check(exact(body,[]),400,'invalid_reconcile_request');const i=owned(user,id);
   if(i.status==='finalized'||i.status==='expired-unused')return{intent:view(i)};
   check(i.envelope&&i.sendAttemptedAt,409,'earning_not_submitted');
   // Reconcile only the original authenticated bytes. This method has no send.
   const envelope=envelopeFor(i,{envelope:i.envelope},user);
   proofOK(sha(nativeEarningSigningBytes(i.command))===i.commandDigest&&sha(JSON.stringify(envelope)).toUpperCase()===i.transactionHash);
   const operation=i.command.operation,payload=i.command.payload;
   const recordKey=operation==='coin_quote'?'coin_quote/'+payload.task:operation==='coin_reserve'?'coin_reservation/'+payload.task:'coin_reward/'+payload.contribution;
   const deadline=Date.now()+native.timeoutMs,c=await proven({member:user.address,keys:[recordKey]},i,deadline),member=account(c,user,i.publicKey);
   check(BigInt(c.state.height)>BigInt(i.command.expires_height)&&member.sequence===i.command.sequence&&c.state.records[recordKey]===null,409,'earning_recovery_not_ready');
   const recovery={schema:'baink-native-earning-recovery-v1',verified:true,status:'expired-unused',paid:false,commandDigest:i.commandDigest,sequence:i.command.sequence,expiresHeight:i.command.expires_height,recordKey,recordPresent:false,proof:c.proof};
   const saved=await store.transact(state=>{
    const current=state.nativeEarningIntents[id];check(current?.member===user.address,404,'earning_intent_missing');
    // Retain the first terminal proof, including finality that won this race.
    if(current.status==='finalized'||current.status==='expired-unused')return current;
    check(current.commandDigest===i.commandDigest&&current.transactionHash===i.transactionHash&&current.sendAttemptedAt===i.sendAttemptedAt&&JSON.stringify(current.envelope)===JSON.stringify(i.envelope),409,'native_envelope_conflict');
    fresh(c.proof,c.state);proofOK(Date.now()<deadline);
    current.status='expired-unused';current.recovery=recovery;current.updatedAt=new Date().toISOString();return current;
   });return{intent:view(saved)};
  },
  async receipt(user,id,body){
   check(exact(body,[]),400,'invalid_receipt_request');const i=owned(user,id);check(i.envelope&&i.sendAttemptedAt,409,'earning_not_submitted');const deadline=Date.now()+native.timeoutMs;
   if(i.status==='finalized'){try{const result=await resultFor(i,user,i.receipt,deadline);return{intent:view(await store.transact(s=>{s.nativeEarningIntents[id].result=result;return s.nativeEarningIntents[id]}))}}catch{return{intent:view(i)}}}
   const head=await proven({},i,deadline),cursor=BigInt(i.scanCursor),count=BigInt(head.state.event_count);proofOK(cursor<=count);const end=cursor+32n<count?cursor+32n:count,ids=[];for(let n=cursor+1n;n<=end;n++)ids.push(String(n));const batch=ids.length?await proven({keys:ids.map(n=>'event/'+n.padStart(20,'0'))},i,deadline):head;proofOK(BigInt(batch.state.height)>=BigInt(head.state.height));
   const subject=i.command.payload.task??i.command.payload.contribution;
   const sameEvent=(e,n)=>e?.id===n&&e.command_digest===i.commandDigest&&e.member===user.address&&e.operation===i.command.operation&&e.subject===subject&&!e.instance&&!e.origin;
   for(const n of ids){const event=batch.state.records['event/'+n.padStart(20,'0')];proofOK(event?.id===n&&HASH.test(event.command_digest??''));if(event.command_digest!==i.commandDigest)continue;proofOK(sameEvent(event,n));const c=await proven({member:user.address,keys:[],receipt:{envelope:i.envelope,event_id:n}},i,deadline),r=c.state.receipt;proofOK(BigInt(c.state.height)>=BigInt(batch.state.height)&&r?.authority==='native'&&r.finalized===true&&r.chain_id===i.command.chain_id&&r.state_height===c.state.height&&r.app_hash===c.proof.appHash&&sameEvent(r.event,n));const result=await resultFor(i,user,r,deadline);
    const saved=await store.transact(s=>{const current=s.nativeEarningIntents[id];current.status='finalized';current.receipt={...r,proof:c.proof};current.result=result;current.scanCursor=n;current.moreEvents=false;current.updatedAt=new Date().toISOString();return current});native.invalidateAccount?.(user.address);return{intent:view(saved)};
   }
   const saved=await store.transact(s=>{const current=s.nativeEarningIntents[id];if(current.status!=='finalized'&&BigInt(current.scanCursor)<end)current.scanCursor=String(end);current.moreEvents=current.status!=='finalized'&&end<count;return current});return{intent:view(saved)};
  },
 };
 return Object.freeze(service);
}
