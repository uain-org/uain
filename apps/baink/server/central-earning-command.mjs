/** Typed prospective central research commands. Keys stay with the holder. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {canonicalJSON,memberAddress} from './native-financial-command.mjs';
export const CENTRAL_POLICY='central-earning-five-kpi-fund-v2';
export const CENTRAL_PROJECT_UNITS=10000000000n;
export const CENTRAL_LIFETIME_UNITS=1000000000000000n;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,ADDRESS=/^uain1[0-9a-f]{40}$/,HASH=/^[a-f0-9]{64}$/;
const optional={central_submit:['revises']};
const fields={central_reassess:['submission'],central_evidence_expire:['submission'],central_evidence_activate:['policy','window_blocks','evidence_digest'],central_fund_configure:["project","evaluator","expected_evaluator","evidence_digest"],central_fund_plan:["project","revision","main_kpi","stages","reason","evidence_digest"],central_fund_plan_review:["project","revision","verdict","evidence_digest"],central_fund_apply:["id","project","round","revision","evidence_digest"],central_fund_decide:["application","verdict","verification_digest","feedback","main_kpi_achieved"],central_fund_close:["project","evidence_digest"],project_join:['project'],central_earning_activate:['policy','reviewer','evidence_digest'],central_project_start:['project','manager','evidence_digest'],central_task_open:['id','project','title','criteria','acceptance_digest','eligibility','eligibility_digest','solver_amount','reviewer_amount','evidence_digest'],central_task_fund:['task','evidence_digest'],central_submit:['id','task','evidence','evidence_digest'],central_review:['submission','verdict','criteria_digest','verification_digest','execution_id','evidence_digest']};
function check(ok){if(!ok)throw Error('Invalid typed central earning command');}
const sha=x=>createHash('sha256').update(x).digest('hex');
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
function exact(x,keys){check(plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)));}
function text(x,max,min=1){return typeof x==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x)&&Buffer.byteLength(x)>=min&&Buffer.byteLength(x)<=max;}
function positive(x){return typeof x==='string'&&/^[1-9][0-9]{0,15}$/.test(x)&&BigInt(x)<=CENTRAL_LIFETIME_UNITS;}
export function centralPayload(operation,value){
 check(Object.hasOwn(fields,operation));const extra=(optional[operation]??[]).filter(k=>plain(value)&&Object.hasOwn(value,k));exact(value,[...fields[operation],...extra]);
 // Copy before validation; caller mutation cannot alter an approved payload.
 const p=structuredClone(value);
 for(const key of ['id','project','task','submission','execution_id','application','revises'])if(Object.hasOwn(p,key))check(typeof p[key]==='string'&&ID.test(p[key]));
 for(const key of ['reviewer','manager','evaluator'])if(Object.hasOwn(p,key))check(typeof p[key]==='string'&&ADDRESS.test(p[key]));
 for(const key of ['evidence_digest','acceptance_digest','eligibility_digest','criteria_digest','verification_digest'])if(Object.hasOwn(p,key))check(typeof p[key]==='string'&&HASH.test(p[key]));
 if(operation==='central_fund_configure')check(p.expected_evaluator===''||(typeof p.expected_evaluator==='string'&&ADDRESS.test(p.expected_evaluator)));
 if(Object.hasOwn(p,'round'))check(Number.isInteger(p.round)&&p.round>=1&&p.round<=5);
 if(Object.hasOwn(p,'revision'))check(Number.isSafeInteger(p.revision)&&p.revision>=1);
 if(operation==='central_fund_plan'){
  check(Array.isArray(p.stages)&&p.stages.length===5&&text(p.main_kpi,4096,20)&&p.main_kpi.trim().length>=20&&text(p.reason,2048,10)&&p.reason.trim().length>=10);
  for(let i=0;i<5;i++){const row=p.stages[i];exact(row,['round','criteria']);check(row.round===i+1&&text(row.criteria,4096,20)&&row.criteria.trim().length>=20);}
 }
 if(['central_fund_plan_review','central_fund_decide'].includes(operation))check(['accept','reject'].includes(p.verdict));
 if(operation==='central_fund_decide')check(text(p.feedback,4096,20)&&p.feedback.trim().length>=20&&typeof p.main_kpi_achieved==='boolean');
 if(operation==='central_earning_activate')check(p.policy===CENTRAL_POLICY);
 if(operation==='central_task_open'){
  check(text(p.title,240,3)&&text(p.criteria,4096)&&sha(p.criteria)===p.acceptance_digest&&['hard','new','unresolved'].includes(p.eligibility)&&positive(p.solver_amount)&&positive(p.reviewer_amount)&&BigInt(p.solver_amount)+BigInt(p.reviewer_amount)<=CENTRAL_LIFETIME_UNITS);
 }
 if(operation==='central_submit')check(text(p.evidence,16384)&&p.evidence.trim().length>0&&sha(p.evidence)===p.evidence_digest);
 if(operation==='central_submit'&&Object.hasOwn(p,'revises'))check(p.revises!==p.id);
 if(operation==='central_evidence_activate')check(p.policy==='central-evidence-window-v1'&&typeof p.window_blocks==='string'&&/^[1-9][0-9]{0,6}$/.test(p.window_blocks)&&BigInt(p.window_blocks)<=1000000n);
 if(operation==='central_review')check(['accept','reject','needs_evidence'].includes(p.verdict));
 return Object.freeze(p);
}
export function centralEarningSigningBytes(command){
 exact(command,['version','chain_id','member','sequence','expires_height','operation','payload']);
 check(command.version===1&&typeof command.chain_id==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(command.chain_id)&&typeof command.member==='string'&&ADDRESS.test(command.member)&&typeof command.sequence==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(command.sequence)&&BigInt(command.sequence)<18446744073709551615n&&typeof command.expires_height==='string'&&/^[1-9][0-9]{0,18}$/.test(command.expires_height)&&BigInt(command.expires_height)<=9223372036854775807n);
 const validated={...command,payload:centralPayload(command.operation,command.payload)};
 // Preserve the native fixed field order while keeping the standalone release
 // independent of the repository's chain/client directory. Parity is tested.
 const order=['version','chain_id','member','sequence','expires_height','operation','payload'];
 return Buffer.from('uain:chain-command:v1\n{'+order.map(k=>canonicalJSON(k)+':'+canonicalJSON(validated[k])).join(',')+'}');
}
export function verifyCentralEnvelope(envelope,{chainId,operations}){
 exact(envelope,['command','public_key','signature']);check(Array.isArray(operations)&&operations.length>0&&operations.every(op=>Object.hasOwn(fields,op))&&operations.includes(envelope.command?.operation)&&envelope.command.chain_id===chainId);
 check(typeof envelope.public_key==='string'&&typeof envelope.signature==='string');
 const pub=Buffer.from(envelope.public_key,'base64url'),sig=Buffer.from(envelope.signature,'base64url');
 check(pub.length===32&&pub.toString('base64url')===envelope.public_key&&sig.length===64&&sig.toString('base64url')===envelope.signature&&memberAddress(pub)===envelope.command.member);
 check(verify(null,centralEarningSigningBytes(envelope.command),createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:envelope.public_key}}),sig));return true;
}
