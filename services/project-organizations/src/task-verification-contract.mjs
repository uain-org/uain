/** Prospective pure binding compiler. No method is qualified by default.
 * This artifact grants no publishing authority, material availability, novelty,
 * native funding or scientific reproduction. Existing runtime is not wired here. */
import {types} from 'node:util';
import {HASH,NATIVE_ID,digest,exactKeys,need,parseStrictJSON,sha256,text} from './common.mjs';

const CANDIDATE='uain-manager-verification-candidate-v1';
const FORMAL='formal-text-assessment-v1';
const safeInt=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const hash=x=>typeof x==='string'&&HASH.test(x);
const id=x=>typeof x==='string'&&NATIVE_ID.test(x);

/** Inspect descriptor VALUES, never getters; validate before canonicalization. */
function inertJSON(root){
 let nodes=0,stringBytes=0;const seen=new Set();
 const string=s=>{
  need(s.length<=65536,'verification_data_limit');
  stringBytes+=Buffer.byteLength(s);need(stringBytes<=65536,'verification_data_limit');
  need(s.isWellFormed(),'verification_data_invalid');
 };
 function walk(v,depth){
  need(++nodes<=4096&&depth<=32,'verification_data_limit');
  if(typeof v==='string'){string(v);return;}
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='number'){need(Number.isSafeInteger(v),'verification_data_invalid');return;}
  need(typeof v==='object'&&!types.isProxy(v)&&!seen.has(v),'verification_data_invalid');
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
  need(array?proto===Array.prototype:proto===Object.prototype||proto===null,'verification_data_invalid');
  seen.add(v);const keys=Reflect.ownKeys(v);
  need(keys.length<=4096-nodes,'verification_data_limit');
  const props=Object.getOwnPropertyDescriptors(v);
  for(const k of keys){need(typeof k==='string','verification_data_invalid');string(k);}
  if(array){
   const n=props.length?.value;need(safeInt(n,0,4096)&&keys.length===n+1,'verification_data_invalid');
   for(let i=0;i<n;i++)need(Object.hasOwn(props,String(i)),'verification_data_invalid');
  }
  for(const key of keys){
   const d=props[key];need(Object.hasOwn(d,'value')&&(array&&key==='length'||d.enumerable),'verification_data_invalid');
   if(!(array&&key==='length'))walk(d.value,depth+1);
  }
  seen.delete(v);
 }
 walk(root,0);need(Buffer.byteLength(JSON.stringify(root))<=65536,'verification_data_limit');
}
function candidate(v){
 need(exactKeys(v,['schema','taskId','projectId','planRevision','stage','criteria','methodId','materialManifestDigest'])&&v.schema===CANDIDATE,'verification_candidate_invalid');
 need(id(v.taskId)&&id(v.projectId)&&safeInt(v.planRevision,1,Number.MAX_SAFE_INTEGER)&&safeInt(v.stage,1,5)&&text(v.criteria,20,4096)&&typeof v.methodId==='string'&&hash(v.materialManifestDigest),'verification_candidate_invalid');
 return v;
}
export function parseVerificationCandidate(json){
 const value=parseStrictJSON(json,{maxBytes:16384,maxDepth:32});inertJSON(value);return candidate(value);
}
function method(v){
 need(exactKeys(v,['id','scope','driverId','driverSha256','evidenceSchema','maxEvidenceBytes','qualificationDigest'])&&v.id===FORMAL&&v.scope==='formal-text-content-and-logic-only'&&v.driverId==='formal-text-assessment'&&v.evidenceSchema==='uain-formal-text-evidence-v1'&&safeInt(v.maxEvidenceBytes,1,16384)&&hash(v.driverSha256)&&hash(v.qualificationDigest),'verification_method_invalid');
 return v;
}
function publicManifest(v,c){
 need(exactKeys(v,['schema','taskId','projectId','criteriaDigest','inputs'])&&v.schema==='uain-task-public-input-manifest-v1','verification_materials_invalid');
 need(v.taskId===c.taskId&&v.projectId===c.projectId&&v.criteriaDigest===sha256(c.criteria),'verification_materials_binding');
 need(Array.isArray(v.inputs)&&v.inputs.length>=1&&v.inputs.length<=16,'verification_materials_invalid');
 let bytes=0;const ids=new Set();
 for(const input of v.inputs){
  need(exactKeys(input,['id','mediaType','sha256','bytes','url'])&&id(input.id)&&!ids.has(input.id)&&['application/json','text/plain'].includes(input.mediaType)&&hash(input.sha256)&&safeInt(input.bytes,1,1048576)&&text(input.url,1,2048),'verification_materials_invalid');
  ids.add(input.id);bytes+=input.bytes;
  let url;try{url=new URL(input.url);}catch{need(false,'verification_materials_invalid');}
  need(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.href===input.url,'verification_materials_invalid');
 }
 need(bytes<=4194304,'verification_materials_invalid');
 need(digest(v)===c.materialManifestDigest,'verification_materials_digest');
}
export function compileVerificationContract(input){
 inertJSON(input);
 need(exactKeys(input,['candidate','approvedPlan','materialManifest'])||exactKeys(input,['candidate','approvedPlan','materialManifest','qualifiedMethods']),'verification_input_invalid');
 const c=candidate(input.candidate),p=input.approvedPlan,methods=input.qualifiedMethods??[];
 need(Array.isArray(methods)&&methods.length<=16,'verification_method_invalid');
 const ids=new Set();for(const m of methods){method(m);need(!ids.has(m.id),'verification_method_invalid');ids.add(m.id);}
 const selected=methods.find(m=>m.id===c.methodId);need(selected,'verification_adapter_required');
 need(exactKeys(p,['projectId','revision','status','stage','planDigest'])&&p.status==='approved'&&safeInt(p.revision,1,Number.MAX_SAFE_INTEGER)&&safeInt(p.stage,1,5)&&hash(p.planDigest),'verification_plan_invalid');
 need(p.projectId===c.projectId&&p.revision===c.planRevision&&p.stage===c.stage,'verification_plan_binding');
 publicManifest(input.materialManifest,c);
 const contract={schema:'uain-task-verification-contract-v1',verificationRequired:true,taskId:c.taskId,projectId:c.projectId,planRevision:c.planRevision,stage:c.stage,planDigest:p.planDigest,criteriaDigest:sha256(c.criteria),materialManifestDigest:c.materialManifestDigest,method:structuredClone(selected)};
 return {contract,contractDigest:digest(contract)};
}
