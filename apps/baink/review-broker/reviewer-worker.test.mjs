import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {canonicalJSON,memberAddress} from '../../../chain/client/signing.mjs';
import {privatePartyConsent} from '../../../chain/client/private-review.mjs';
import {paymentAgreementBytes} from '../server/native-payments.mjs';
import {privateAIMessageBytes,verifyPrivateAIDecision,validatePurposeEvidence,validateInspectedInvoice} from './reviewer-worker.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
function identity(){const pair=generateKeyPairSync('ed25519'),publicKey=Buffer.from(pair.publicKey.export({format:'der',type:'spki'})).subarray(-32).toString('base64url');return{...pair,publicKey,member:memberAddress(Buffer.from(publicKey,'base64url'))};}
function audit(){const broker=identity(),purpose='a'.repeat(64),report={schema:'baink-private-service-inspection-v1',jobId:'1'.repeat(32),inspectionDigest:'b'.repeat(64),inspection:{context:{purpose},checks:{ownerLicenceChecked:true,bothLicencesChecked:false}},proof:{height:'123'}};
 const decision={class:'neutral',statement:'Fictional actual-model-output format used solely for isolated signature tests.',checkedPurpose:purpose,ownerLicenceChecked:true,bothLicencesChecked:false};
 const request=JSON.stringify({schema:'baink-private-ai-request-v1',jobId:report.jobId,inspectionDigest:report.inspectionDigest,report}),response=JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:decision});
 const payload={schema:'baink-private-ai-decision-v1',jobId:report.jobId,inspectionDigest:report.inspectionDigest,provider:'claude-code',model:'claude-sonnet-5-5',completedAt:new Date().toISOString(),requestSha256:hash(request),responseSha256:hash(response),decision};
 return{broker,report,request,response,attestation:{payload,signature:sign(null,privateAIMessageBytes(payload),broker.privateKey).toString('base64url')},publicKey:broker.publicKey};
}
test('decision requires exact current signed broker, frozen report, raw request and actual successful model output',()=>{
 const f=audit();assert.equal(verifyPrivateAIDecision(f).class,'neutral');
 for(const alter of [v=>{v.report.inspectionDigest='c'.repeat(64);},v=>{v.request+=' ';},v=>{v.response+=' ';},v=>{v.attestation.payload.model='different-model';},v=>{v.attestation.payload.decision.class='benevolent';},v=>{v.attestation.signature='x'.repeat(86);},v=>{v.publicKey=identity().publicKey;}]){const v=structuredClone({...f,broker:undefined});alter(v);assert.throws(()=>verifyPrivateAIDecision(v));}
 assert.throws(()=>verifyPrivateAIDecision({...f,now:Date.now()+121000}));
});
test('broker cannot replace a refused actual response with a positive attested classification',()=>{
 const f=audit();f.response=JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{...f.attestation.payload.decision,class:'refuse'}});f.attestation.payload.responseSha256=hash(f.response);f.attestation.signature=sign(null,privateAIMessageBytes(f.attestation.payload),f.broker.privateKey).toString('base64url');assert.throws(()=>verifyPrivateAIDecision(f));
});
test('purpose evidence proves the frozen direct memo and refuses opaque, empty, changed or mismapped terms',()=>{
 const value={payer:'payer',payee:'payee',amountUnits:'26',clientRequestId:'fictional-payment-26',memo:'Fictional reviewed computing service.'},invoice={payer:'payer',payee:'payee',amountUnits:'26',requestDigest:hash(canonicalJSON(value))};assert.deepEqual(validatePurposeEvidence(invoice,value),value);
 for(const changed of [{...value,memo:'Different service.'},{...value,memo:''},{...value,payer:'other'}])assert.throws(()=>validatePurposeEvidence(invoice,changed));
 const empty={...value,memo:'   '};assert.throws(()=>validatePurposeEvidence({...invoice,requestDigest:hash(canonicalJSON(empty))},empty));assert.throws(()=>validatePurposeEvidence(invoice,null));
});
test('request purpose evidence binds inverse request parties, micro-unit amount, currency and exact snapshot',()=>{
 const value={id:'fictional-request',from:'payee',to:'payer',amount:'0.000026',memo:'Fictional reviewed compute invoice.',currency:'AI$',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},invoice={payer:'payer',payee:'payee',amountUnits:'26',requestDigest:hash(canonicalJSON(value))};assert.deepEqual(validatePurposeEvidence(invoice,value),value);
 for(const changed of [{...value,to:'payee'},{...value,amount:'0.000027'},{...value,currency:'USD'},{...value,amount:'0.0000260'}])assert.throws(()=>validatePurposeEvidence({...invoice,requestDigest:hash(canonicalJSON(changed))},changed));
});
test('OTC inspection validates real bilateral cryptographic consents, canonical invoice, frozen memo and owned output values',()=>{
 const sender=identity(),recipient=identity(),reviewer=identity(),evidence={payer:sender.member,payee:recipient.member,amountUnits:'26',clientRequestId:'fictional-invoice',memo:'Fictional independently inspected computing invoice.'};
 const pins={chainId:'fictional-reviewer-test',genesisSha256:'4'.repeat(64)},invoice={schema:'baink-private-invoice-v1',id:'fictional-invoice-1',...pins,payer:sender.member,payee:recipient.member,amountUnits:'26',requestDigest:hash(canonicalJSON(evidence))};
 const context={version:1,chain:pins.chainId,expires:'200',licenceRevision:'0',effects:'3'.repeat(64),purpose:'5'.repeat(64),reviewer:Buffer.from(reviewer.publicKey,'base64url').toString('hex')};
 const packet={operation:'private_payment',amount:'26',agreement:{text:canonicalJSON(invoice),salt:'6'.repeat(64)},consents:[privatePartyConsent(context,'7'.repeat(86),sender.privateKey),privatePartyConsent(context,'8'.repeat(86),recipient.privateKey)]};
 const inspected={context,operation:packet.operation,amount:packet.amount,agreement:packet.agreement,state:{relayer:{member:identity().member},parties:[{member:sender.member,public_key:sender.publicKey},{member:recipient.member,public_key:recipient.publicKey}]},inspection:{outputs:[{address:'8'.repeat(86),amount:'26'},{address:'7'.repeat(86),amount:'44'}]}};
 const agreedInvoice={invoice,purposeCommitment:context.purpose,agreements:Object.fromEntries([sender,recipient].map(w=>[w.member,{publicKey:w.publicKey,signature:sign(null,paymentAgreementBytes(invoice,context.purpose),w.privateKey).toString('base64url')}]))};
 const input={packet,inspected,agreedInvoice,purposeEvidence:evidence,pins};assert.deepEqual(validateInspectedInvoice(input),invoice);
 const changed=structuredClone(input);changed.inspected.inspection.outputs[1].address='9'.repeat(86);assert.throws(()=>validateInspectedInvoice(changed));
 const missing=structuredClone(input);missing.packet.consents.pop();assert.throws(()=>validateInspectedInvoice(missing));
 const opaque=structuredClone(input);opaque.purposeEvidence=null;assert.throws(()=>validateInspectedInvoice(opaque));
});
