/** Offline coordination proposals. This module has no signing, network, database,
 * provider, execution or payment capability. The native chain remains authority. */
import { createHash } from 'node:crypto';
const fail = () => { throw new Error('invalid_task_plan'); };
const need = (ok) => { if (!ok) fail(); };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function exact(value, keys) {
 need(value !== null && typeof value === 'object' && !Array.isArray(value));
 need([Object.prototype, null].includes(Object.getPrototypeOf(value)));
 const own = Reflect.ownKeys(value);
 need(own.length === keys.length && keys.every(k => own.includes(k)) && own.every(k => typeof k === 'string' && 'value' in Object.getOwnPropertyDescriptor(value,k)));
}
function text(value,max,min=0) {
 need(typeof value === 'string' && Buffer.byteLength(value) <= max && !controls.test(value));
 const out = value.trim();need(Buffer.byteLength(out) >= min);return out;
}
function dataArray(value, max, min = 0) {
 need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
 const count = Object.getOwnPropertyDescriptor(value, 'length')?.value;
 need(Number.isSafeInteger(count) && count >= min && count <= max);
 const keys = Reflect.ownKeys(value);
 need(keys.length === count + 1 && keys.includes('length'));
 const result = [];
 for (let i = 0; i < count; i++) {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
  need(descriptor && 'value' in descriptor);
  result.push(descriptor.value);
 }
 return result;
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function buildTaskPlan(input) {
 exact(input,['project','task']);
 exact(input.project,['id','sourceSha256','workflow']);
 exact(input.task,['id','title','class','criteria','priorArt','creditReward','karmaReward']);
 exact(input.task.priorArt,['basis','searches']);
 const p=input.project,t=input.task;
 need(typeof p.id === 'string' && ID.test(p.id) && typeof t.id === 'string' && ID.test(t.id));
 need(typeof p.sourceSha256 === 'string' && HASH.test(p.sourceSha256));
 need(['native','legacy','catalogue'].includes(p.workflow));
 need(['benevolent','neutral'].includes(t.class));
 const title=text(t.title,250,5),criteria=text(t.criteria,4000),basis=text(t.priorArt.basis,4000);
 const searches=dataArray(t.priorArt.searches,20).map(x=>text(x,1000,5));
 const unpriced=t.creditReward===null && t.karmaReward===null;
 need(unpriced || (typeof t.creditReward === 'string' && /^(0|[1-9][0-9]{0,6})$/.test(t.creditReward) && BigInt(t.creditReward)<=1000000n && Number.isSafeInteger(t.karmaReward) && t.karmaReward>=0 && t.karmaReward<=1000000));
 const binding={projectId:p.id,projectSourceSha256:p.sourceSha256,workflow:p.workflow,task:{id:t.id,title,class:t.class,criteria,priorArt:{basis,searches},creditReward:t.creditReward,karmaReward:t.karmaReward}};
 const missing=unpriced?['research_price_not_established']:[];
 if(Buffer.byteLength(basis)<40 || searches.length<2 || new Set(searches).size!==searches.length) missing.push('prior_art_research_required');
 if(Buffer.byteLength(criteria)<40) missing.push('verification_criteria_required');
 const legacy=p.workflow==='legacy', catalogue=p.workflow==='catalogue';
 const metadataReady=!legacy && !catalogue && missing.length===0;
 return {
  schema:'baink-paperclip/task-plan/v1',revision:hash(binding),binding,
  status:catalogue?'admission-required':legacy?'legacy-workflow-required':metadataReady?'metadata-ready':'needs-research',
  sourceTextIsUntrusted:true,sourceProvenanceVerified:false,executionAvailable:false,
  blockers:[...missing,...(catalogue?['native_project_admission_not_established']:[]),...(legacy?['legacy_operation_mapping_required','legacy_native_coin_opening_not_established']:[]),'native_authority_and_fresh_state_required','holder_local_signature_required','paperclip_runtime_and_scoped_writes_not_qualified'],
  nativeIntent:metadataReady?{operation:'open_task',payload:{id:t.id,project:p.id,title,class:t.class,prior_art:{basis,searches:[...searches]},criteria,kind:'instant',karma_reward:t.karmaReward,credit_reward:t.creditReward}}:null,
  workflow:[
   {stage:'research-gap',authority:'reviewed-prior-art-basis-and-searches',complete:false},
   {stage:'open-task',authority:legacy?'qualified-legacy-workflow':'active-native-project-lead-local-signature-and-exact-finalized-receipt',complete:false},
   {stage:'fund-before-work',authority:'qualified-coin-policy-lead-quote-and-guardian-reservation',complete:false},
   {stage:'contribute',authority:'eligible-holder-local-submit-and-published-evidence-digest',complete:false},
   {stage:'independent-review',authority:'native-standing-novelty-operator-family-and-challenge-rules',complete:false},
   {stage:'claim-reward',authority:'licensed-winning-holder-local-claim-and-exact-finalized-reward-proof',complete:false}
  ],
  reward:{assetId:'uain-native-coin',symbol:'AI$',researchCreditsAreMoney:false,amountUnits:null,paid:null,executionAvailable:false,paperclipDoneIsPayment:false,operations:['coin_quote','coin_reserve','coin_claim'],requirements:['active_native_coin_and_private_policies','genuine_post_activation_native_opening_event','lead_pricing_and_guardian_reservation','reservation_before_submissions','licensed_settled_winning_author','at_least_two_independent_operators_and_other_family','frozen_confirmed_new_novelty_checks','no_open_challenge_or_withheld_award','exact_finalized_native_receipt']},
  notice:'Offline unsigned coordination proposal only. Source hashes and supplied research are not independently verified. Research credits/Karma and Paperclip completion are not AI$ payment. No task, agent, reservation or money is created.'
 };
}
export function buildTaskBatch(inputs) {
 const plans=dataArray(inputs,100,1).map(buildTaskPlan),seen=new Set();
 for(const p of plans){const id=p.binding.task.id;need(!seen.has(id));seen.add(id);}
 return {schema:'baink-paperclip/task-plan-batch/v1',revision:hash(plans.map(x=>x.revision)),plans,executionAvailable:false};
}
