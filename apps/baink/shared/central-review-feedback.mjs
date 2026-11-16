/** Public-data codec only. A caller must supply independently proved native context. */
export const FEEDBACK_SCHEMA='uain-central-review-feedback-v1';
export const FEEDBACK_MAX_BYTES=73728;
const REQUEST_DOMAIN='UAIN/central-review-feedback-request/v1',DECISION_DOMAIN='UAIN/central-research-review/v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,ADDRESS=/^uain1[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const DECISION=['schema','domain','submission','task','reviewer','execution_id','criteria_digest','evidence_digest','verdict','findings','started_at','completed_at'];
const REVIEW=['submission','execution_id','criteria_digest','evidence_digest','verification_digest','reviewer','height','verdict'];
const encoder=new TextEncoder();
function insist(value){if(!value)throw Error('central_review_feedback_refused');}
function exact(value,fields){return value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k)&&Object.getOwnPropertyDescriptor(value,k)?.get===undefined&&Object.getOwnPropertyDescriptor(value,k)?.set===undefined);}
function text(value,max){return typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)&&encoder.encode(value).length<=max;}
function id(value){return typeof value==='string'&&ID.test(value);}
function hash(value){return typeof value==='string'&&HASH.test(value);}
function address(value){return typeof value==='string'&&ADDRESS.test(value);}
function positive(value){return typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;}
function date(value){return text(value,64)&&Number.isFinite(Date.parse(value));}
// Closed decision/request objects have fixed ASCII keys and string/string-array values.
// This is the worker decision encoding, not Go financial-command HTML escaping.
function canonical(value){if(value===null)return 'null';if(typeof value==='string')return JSON.stringify(value);if(Array.isArray(value)){const values=[];for(let i=0;i<value.length;i++)values.push(canonical(value[i]));return '['+values.join(',')+']';}return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
function findings(value){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>64||Reflect.ownKeys(value).length!==value.length+1)return false;for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value')||!text(d.value,8192)||d.value.length===0)return false;}return true;}

async function digest(value){const bytes=await globalThis.crypto.subtle.digest('SHA-256',encoder.encode(value));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
export function validateFeedbackRequest(value){insist(exact(value,['submission','executionId'])&&id(value.submission)&&(value.executionId===null||id(value.executionId))&&encoder.encode(canonical(value)).length<=512);return{submission:value.submission,executionId:value.executionId};}
export async function feedbackJobId(value){return(await digest(REQUEST_DOMAIN+'\n'+canonical(validateFeedbackRequest(value)))).slice(0,32);}
function validateDecision(d){
 const v2=d?.schema==='uain-central-research-decision-v2';insist(exact(d,v2?[...DECISION,'verification_attestation_digest']:DECISION)&&(v2||d.schema==='uain-central-research-decision-v1')&&d.domain===DECISION_DOMAIN);
 insist(['submission','task','execution_id'].every(k=>id(d[k]))&&address(d.reviewer)&&['criteria_digest','evidence_digest'].every(k=>hash(d[k]))&&(!v2||hash(d.verification_attestation_digest))&&['accept','reject','needs_evidence'].includes(d.verdict));
 insist(findings(d.findings));
 insist(date(d.started_at)&&date(d.completed_at)&&Date.parse(d.started_at)<=Date.parse(d.completed_at)&&Date.parse(d.completed_at)-Date.parse(d.started_at)<=600000&&encoder.encode(canonical(d)).length<=65536);
}
function validateReview(r){insist(exact(r,REVIEW)&&id(r.submission)&&id(r.execution_id)&&['criteria_digest','evidence_digest','verification_digest'].every(k=>hash(r[k]))&&address(r.reviewer)&&positive(r.height)&&['accept','reject','needs_evidence'].includes(r.verdict));}
export async function validateReviewFeedback(packet,expected,{now=Date.now()}={}){
 insist(exact(expected,['submission','executionId','author','task','project','review','chainId','genesisSha256','verifierSha256']));
 insist(exact(packet,['schema','submission','executionId','author','task','project','chainId','genesisSha256','nativeReview','decision','native'])&&packet.schema===FEEDBACK_SCHEMA);
 validateFeedbackRequest({submission:packet.submission,executionId:packet.executionId});insist(id(packet.executionId)&&id(packet.task)&&id(packet.project)&&address(packet.author)&&text(packet.chainId,128)&&packet.chainId.length>0&&hash(packet.genesisSha256));
 validateDecision(packet.decision);validateReview(packet.nativeReview);validateReview(expected.review);
 insist(['submission','executionId','author','task','project','chainId','genesisSha256'].every(k=>packet[k]===expected[k])&&packet.author!==packet.decision.reviewer&&canonical(packet.nativeReview)===canonical(expected.review));
 const d=packet.decision,r=packet.nativeReview,n=packet.native;
 insist(d.submission===packet.submission&&d.task===packet.task&&d.execution_id===packet.executionId&&['submission','execution_id','criteria_digest','evidence_digest','reviewer','verdict'].every(k=>d[k]===r[k]));
 insist(exact(n,['height','appHash','headerTime','verifierSha256'])&&positive(n.height)&&BigInt(n.height)>=BigInt(r.height)&&hash(n.appHash)&&hash(n.verifierSha256)&&n.verifierSha256===expected.verifierSha256&&date(n.headerTime)&&Number.isFinite(now)&&now-Date.parse(n.headerTime)>=-60000&&now-Date.parse(n.headerTime)<=120000);
 insist(encoder.encode(canonical(packet)).length<=FEEDBACK_MAX_BYTES);
 const verified=structuredClone(packet),context=structuredClone(expected);
 insist(await digest(DECISION_DOMAIN+'\n'+canonical(verified.decision))===context.review.verification_digest);
 return verified;
}
