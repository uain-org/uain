/** Prospective commitment compiler ONLY. No proof authentication, method qualification,
 * task publication, provider, reader, store or signer capability. Registry defaults empty. */
import {types} from 'node:util';
import {ADDRESS,HASH,digest,exactKeys,need,nativeProjectId,parseStrictJSON,sha256,text} from './common.mjs';
import {compileVerificationContract} from './task-verification-contract.mjs';
import {SUPPLY_CAP_UNITS,validatePricedTask} from './pricing.mjs';
import {centralPayload} from '../../../apps/baink/server/central-earning-command.mjs';
export const TASK_PRICE_V2_SCHEMA='uain-project-organization-task-price-v2';
const LIMIT=524288;
const eq=(a,b)=>digest(a)===digest(b);
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const hash=v=>typeof v==='string'&&HASH.test(v);
function inert(root){
 let nodes=0,bytes=0;const seen=new Set();
 const add=n=>{bytes+=n;need(bytes<=LIMIT,'pricing_v2_data_limit');};
 const str=s=>{
  need(s.length<=LIMIT&&s.isWellFormed(),'pricing_v2_data_limit');
  add(Buffer.byteLength(s)+2);
  // Count JSON escaping BEFORE allocating a serialized artifact.
  for(let n=0;n<s.length;n++){const c=s.charCodeAt(n);if(c===34||c===92)add(1);else if(c<32)add([8,9,10,12,13].includes(c)?1:5);}
 };
 function walk(v,d){
  need(++nodes<=32768&&d<=32,'pricing_v2_data_limit');
  if(typeof v==='string'){str(v);return;}if(v===null){add(4);return;}if(typeof v==='boolean'){add(v?4:5);return;}
  if(typeof v==='number'){need(Number.isSafeInteger(v),'pricing_v2_data_invalid');add(String(v).length);return;}
  need(typeof v==='object'&&!types.isProxy(v)&&!seen.has(v),'pricing_v2_data_invalid');
  const a=Array.isArray(v),p=Object.getPrototypeOf(v);need(a?p===Array.prototype:p===Object.prototype||p===null,'pricing_v2_data_invalid');
  seen.add(v);const keys=Reflect.ownKeys(v);need(keys.length<=32768-nodes,'pricing_v2_data_limit');const ds=Object.getOwnPropertyDescriptors(v);
  for(const k of keys)need(typeof k==='string','pricing_v2_data_invalid');
  if(a)need(integer(ds.length?.value)&&keys.length===ds.length.value+1&&Array.from({length:ds.length.value},(_,i)=>Object.hasOwn(ds,String(i))).every(Boolean),'pricing_v2_data_invalid');
  add(2);let count=0;
  for(const k of keys){const x=ds[k];need(Object.hasOwn(x,'value')&&(a&&k==='length'||x.enumerable),'pricing_v2_data_invalid');if(a&&k==='length')continue;if(count++)add(1);if(!a){str(k);add(1);}walk(x.value,d+1);}
  seen.delete(v);
 }walk(root,0);
}
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const utc=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s))return false;const base=s.slice(0,19)+'Z',n=Date.parse(base);return Number.isFinite(n)&&new Date(n).toISOString().slice(0,19)===s.slice(0,19);};
const same=(a,b)=>need(eq(a,b),'pricing_v2_binding');
export function parseTaskPricingV2Input(rawJSON){const v=parseStrictJSON(rawJSON,{maxBytes:LIMIT,maxDepth:32});inert(v);return v;}
function proposalBindings(p){
 need(exactKeys(p,['input','evidence'])&&exactKeys(p.input,['task','approvedPlan','priorArt','budget','supply','existingTaskIds']),'pricing_v2_proposal');
 const {input:i,evidence:e}=p,t=i.task;
 need(exactKeys(e,['schema','managerReport','taskIndex','priorArtSurvey','proposedTask','priorArt'])&&e.schema==='uain-project-organization-task-proposal-v1','pricing_v2_proposal');
 same(t.evidenceDigest,digest(e));
 const m=e.managerReport;
 need(exactKeys(m,['id','resultDigest','executionId','actual','receiptDigest','approvedPlanRevision','milestoneRound'])&&text(m.id,1,200)&&hash(m.resultDigest)&&m.actual===true&&text(m.executionId,1,200)&&hash(m.receiptDigest)&&m.approvedPlanRevision===t.planRevision&&m.milestoneRound===t.milestoneRound&&integer(e.taskIndex),'pricing_v2_proposal');
 need(exactKeys(e.priorArtSurvey,['taskId','submission','evidenceDigest'])&&text(e.priorArtSurvey.taskId,1,96)&&text(e.priorArtSurvey.submission,1,96)&&hash(e.priorArtSurvey.evidenceDigest),'pricing_v2_proposal');
 const q=e.proposedTask;
 need((exactKeys(q,['title','criteria','eligibility','eligibility_basis','proposed_price'])||exactKeys(q,['title','criteria','eligibility','eligibility_basis','proposed_price','candidate_id']))&&(!Object.hasOwn(q,'candidate_id')||q.candidate_id===null||typeof q.candidate_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(q.candidate_id))&&text(q.eligibility_basis,20,4096)&&exactKeys(q.proposed_price,['solver_amount','reviewer_amount','rationale']),'pricing_v2_proposal');
 for(const k of ['title','criteria','eligibility'])same(q[k],t[k]);same(q.proposed_price,{solver_amount:t.solverAmount,reviewer_amount:t.reviewerAmount,rationale:t.rationale});
 const r=e.priorArt;
 need(exactKeys(r,['schema','producer','subject','basis','searches','knownAnswer','openSolutionFound'])&&r.schema==='uain-project-organization-trusted-prior-art-v1','pricing_v2_proposal');
 need(exactKeys(r.producer,['kind','id','recordedAt'])&&r.producer.kind==='trusted_search'&&text(r.producer.id,3,200)&&![m.id,m.executionId].includes(r.producer.id.trim())&&utc(r.producer.recordedAt),'pricing_v2_proposal');
 need(exactKeys(r.subject,['projectId','criteriaDigest'])&&r.subject.projectId===t.projectId&&r.subject.criteriaDigest===sha256(t.criteria),'pricing_v2_binding');
 same(i.priorArt,{basis:r.basis,searches:r.searches,knownAnswer:r.knownAnswer,openSolutionFound:r.openSolutionFound});
 const norm=s=>s.trim().replace(/\s+/g,' ').toLowerCase();need(norm(r.basis)!==norm(q.eligibility_basis),'pricing_v2_proposal');
 need(Array.isArray(r.searches)&&r.searches.length<=32,'pricing_v2_proposal');
 for(const s of r.searches)need(typeof s.source==='string'&&!/^(?:model|llm|leadership|manager|ceo|assistant|self|agent)(?:$|[\s:/_-])/i.test(s.source.trim())&&utc(s.observedAt)&&Date.parse(s.observedAt)<=Date.parse(r.producer.recordedAt)&&typeof s.resultSummary==='string'&&norm(s.resultSummary)!==norm(q.eligibility_basis),'pricing_v2_proposal');
 need(Array.isArray(i.existingTaskIds)&&i.existingTaskIds.length<=4096&&i.existingTaskIds.every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v))&&new Set(i.existingTaskIds).size===i.existingTaskIds.length,'pricing_v2_proposal');
 return i;
}
function nativeBindings(c,i,network){
 need(exactKeys(network,['chainId','genesisSha256'])&&text(network.chainId,1,200)&&hash(network.genesisSha256),'pricing_v2_network');
 need(exactKeys(c,['schema','network','point','proofDigest','recordAnchors','records'])&&c.schema==='uain-manager-pricing-native-context-v1','pricing_v2_native');same(c.network,network);
 need(exactKeys(c.point,['height','appHash','headerTime'])&&typeof c.point.height==='string'&&/^[1-9][0-9]{0,18}$/.test(c.point.height)&&hash(c.point.appHash)&&utc(c.point.headerTime)&&hash(c.proofDigest),'pricing_v2_native');
 const names=['project','fundConfig','fundState','latestPlan','approvedPlan','budget','coinSupply','targetTask'];
 need(exactKeys(c.records,names)&&exactKeys(c.recordAnchors,names),'pricing_v2_native');const r=c.records,f=r.fundState,p=r.approvedPlan,P=nativeProjectId(i.task.projectId);
 need(exactKeys(f,['revision','approved_revision','pending','completed'])&&integer(f.revision,1)&&integer(f.approved_revision,1)&&f.revision>=f.approved_revision&&integer(f.completed)&&f.completed<=4,'pricing_v2_native');
 need(f.pending===''&&p?.state==='accept'&&p.project===P&&p.revision===f.approved_revision,'pricing_v2_native');
 const planKeys=['project','revision','state','main_kpi','stages','reason','evidence_digest','manager','reviewer','height'];
 for(const v of [p,r.latestPlan])need(exactKeys(v,planKeys)&&v.project===P&&integer(v.revision,1)&&['accept','reject','proposed'].includes(v.state)&&text(v.main_kpi,20,4096)&&text(v.reason,10,2048)&&hash(v.evidence_digest)&&ADDRESS.test(v.manager)&&ADDRESS.test(v.reviewer)&&typeof v.height==='string'&&/^[1-9][0-9]{0,18}$/.test(v.height),'pricing_v2_native');
 need(r.latestPlan.revision===f.revision&&(f.revision===f.approved_revision?eq(r.latestPlan,p):r.latestPlan.state==='reject'),'pricing_v2_native');
 need(r.project&&r.project.id===P&&Object.keys(r.project).every(k=>['id','lead','lead_instance','title','class','prior_art','state','budget','safety_halted','kpi','accounting','membership_policy','operator_policy','storage_policy','metadata_digest'].includes(k))&&['id','lead','title','class','prior_art','state','budget','safety_halted'].every(k=>Object.hasOwn(r.project,k))&&ADDRESS.test(r.project.lead)&&text(r.project.title,3,240)&&typeof r.project.class==='string'&&r.project.state==='active'&&typeof r.project.budget==='string'&&exactKeys(r.project.prior_art,['basis','searches'])&&typeof r.project.prior_art.basis==='string'&&Array.isArray(r.project.prior_art.searches)&&r.project.prior_art.searches.every(s=>typeof s==='string')&&r.project.safety_halted===false&&exactKeys(r.fundConfig,['project','evaluator','height','evidence_digest'])&&r.fundConfig.project===P&&ADDRESS.test(r.fundConfig.evaluator)&&ADDRESS.test(r.budget?.manager)&&r.fundConfig.evaluator!==r.budget.manager&&hash(r.fundConfig.evidence_digest)&&typeof r.fundConfig.height==='string'&&/^[1-9][0-9]{0,18}$/.test(r.fundConfig.height),'pricing_v2_native');
 const key={project:`project/${P}`,fundConfig:`central_fund_config/${P}`,fundState:`central_fund_state/${P}`,budget:`central_project_budget/${P}`,coinSupply:'coin_supply',targetTask:`central_task/${i.task.id}`,latestPlan:`central_fund_plan/${P}/${String(f.revision).padStart(20,'0')}`,approvedPlan:`central_fund_plan/${P}/${String(f.approved_revision).padStart(20,'0')}`};
 for(const n of names){const a=c.recordAnchors[n];need(exactKeys(a,['key','height','appHash'])&&a.key===key[n]&&a.height===c.point.height&&a.appHash===c.point.appHash,'pricing_v2_native');}
 need(r.targetTask===null,'pricing_v2_native');
 const approved={projectId:i.task.projectId,revision:p.revision,approved:true,stages:p.stages,currentRound:f.completed+1,mainKpiAchieved:r.budget?.main_kpi_achieved===true};same(i.approvedPlan,approved);same(i.budget,r.budget);
 const s=r.coinSupply;need(exactKeys(s,['minted','reserved','transparent','shielded'])&&Object.values(s).every(v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,20})$/.test(v))&&BigInt(s.transparent)+BigInt(s.shielded)===BigInt(s.minted),'pricing_v2_native');
 same(i.supply,{cap:String(SUPPLY_CAP_UNITS),issued:s.minted,reserved:s.reserved});
 return {projectId:P,revision:p.revision,status:'approved',stage:f.completed+1,planDigest:digest(p)};
}
export function compileTaskPricingV2(input,options={}){
 inert(input);need(exactKeys(input,['proposal','verificationCandidate','materialManifest','nativeContext']),'pricing_v2_input');
 need(options&&typeof options==='object'&&!types.isProxy(options)&&Object.getPrototypeOf(options)===Object.prototype,'pricing_v2_options');
 const keys=Reflect.ownKeys(options);need(keys.length<=3&&keys.every(k=>typeof k==='string'&&['qualifiedMethods','expectedNetwork','selection'].includes(k)),'pricing_v2_options');
 const ds=Object.getOwnPropertyDescriptors(options);need(keys.every(k=>Object.hasOwn(ds[k],'value')&&ds[k].enumerable),'pricing_v2_options');
 const {qualifiedMethods=[],expectedNetwork,selection}=options;need(expectedNetwork!==undefined,'pricing_v2_network');inert({qualifiedMethods,expectedNetwork});
 if(selection!==undefined)need(selection&&!types.isProxy(selection)&&Object.isFrozen(selection)&&Object.getOwnPropertyDescriptor(selection,'get')?.value instanceof Function,'pricing_v2_options');
 const x=structuredClone(input),i=proposalBindings(x.proposal),approvedPlan=nativeBindings(x.nativeContext,i,expectedNetwork),c=x.verificationCandidate;
 need(c.taskId===i.task.id&&c.projectId===nativeProjectId(i.task.projectId)&&c.criteria===i.task.criteria&&c.planRevision===i.task.planRevision&&c.stage===i.task.milestoneRound,'pricing_v2_binding');
 const {contract,contractDigest}=compileVerificationContract({candidate:c,approvedPlan,materialManifest:x.materialManifest,qualifiedMethods});
 const legacy=validatePricedTask({...i,...(selection===undefined?{}:{selection})});
 const priceEvidence={schema:TASK_PRICE_V2_SCHEMA,pricingV1:legacy.priceEvidence,pricingV1Digest:legacy.priceDigest,proposalEvidenceDigest:digest(x.proposal.evidence),verificationContractDigest:contractDigest,materialManifestDigest:digest(x.materialManifest),nativeContext:x.nativeContext};
 inert(priceEvidence);
 const priceDigest=digest(priceEvidence),nativePayload=centralPayload('central_task_open',{...legacy.nativePayload,evidence_digest:priceDigest});
 const bundle={schema:'uain-manager-task-opening-bundle-v2',proposalEvidence:x.proposal.evidence,verificationContract:contract,materialManifest:x.materialManifest,priceEvidence,nativePayload};
 inert(bundle);return freeze({priceEvidence,priceDigest,nativePayload,bundle});
}
