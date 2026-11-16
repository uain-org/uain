import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,lstat,rm,symlink,link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,generateKeyPairSync,sign,verify } from 'node:crypto';
import { canonicalJSON,signingBytes,signedEnvelope } from '../../../chain/client/signing.mjs';
import { privatePartyConsent,signPrivateApproval } from '../../../chain/client/private-review.mjs';
import { holderIntentPurpose } from './external-signing.mjs';
import { paymentAgreementBytes,paymentReviewerBindingBytes } from '../server/native-payments.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const FIXTURE_DEADLINE_MS=120000;
// Waits for a condition without a fixed attempt count: it stops when the
// condition holds or when the pending courier settles (its own deadline).
async function until(probe,pending){let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});for(;;){const value=await probe();if(value||settled)return value;await new Promise(r=>setTimeout(r,5));}}
const actor=()=>{const keys=generateKeyPairSync('ed25519'),raw=keys.publicKey.export({type:'spki',format:'der'}).subarray(-32);return {...keys,raw,member:'uain1'+hash(raw).slice(0,40),key:raw.toString('base64url')};};
async function fixture(t,{withPurpose=false}={}){
 const api=await import('./courier-executor.mjs');const root=await mkdtemp(join(tmpdir(),'holder-courier-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const owner=actor(),recipient=actor(),reviewer=actor(),relay=actor();
 const purposeEvidence={payer:owner.member,payee:recipient.member,amountUnits:'26',clientRequestId:'fixture-payment-1',memo:'Fictional purchase of a bounded research service'};
 const invoice={schema:'baink-private-invoice-v1',id:'invoice-fixture-1',chainId:'courier-fixture',genesisSha256:'a'.repeat(64),payer:owner.member,payee:recipient.member,amountUnits:'26',requestDigest:withPurpose?hash(canonicalJSON(purposeEvidence)):'b'.repeat(64)};
 const intent={id:invoice.id,operation:'private_payment',amount:'26',agreement:{text:canonicalJSON(invoice),salt:'c'.repeat(64)},reviewer:reviewer.member,owner:{member:owner.member,publicKey:owner.key},recipient:{member:recipient.member,publicKey:recipient.key,address:'21'.repeat(43)}};
 const context={version:1,chain:invoice.chainId,expires:'200',licenceRevision:'0',effects:'d'.repeat(64),purpose:holderIntentPurpose(intent),reviewer:reviewer.raw.toString('hex')};
 const consentAddress='22'.repeat(43);
 const nativeApproval=signPrivateApproval({context,reviewerSigningKey:reviewer.privateKey,trustedRelayerKey:relay.publicKey,licensedSenderKey:owner.publicKey,licensedRecipientKey:recipient.publicKey,sender:privatePartyConsent(context,consentAddress,owner.privateKey),recipient:privatePartyConsent(context,intent.recipient.address,recipient.privateKey),outputs:[{address:consentAddress,amount:'44'},{address:intent.recipient.address,amount:'26'}],amount:'26',decision:{class:'neutral',checkedPurpose:context.purpose,bothLicencesChecked:true,statement:'The fictional checker independently inspected this isolated invoice and both licensed outputs.'}});
 const result={operation:'private_payment',payload:{bundle:'AQ',approval:nativeApproval},local_receipt:{effects:context.effects,outputs:[],secret:'private fixture receipt'}};
 const agreed={invoice,purposeCommitment:context.purpose,agreements:{}};
 for(const member of [owner,recipient])agreed.agreements[member.member]={publicKey:member.key,signature:sign(null,paymentAgreementBytes(invoice,context.purpose),member.privateKey).toString('base64url')};
 const reviewerBinding={publicKey:reviewer.key,signature:sign(null,paymentReviewerBindingBytes({...invoice,purposeCommitment:context.purpose},{effects:context.effects,reviewer:reviewer.member}),reviewer.privateKey).toString('base64url'),independentlyInspected:true};
 const envelope=signedEnvelope({version:1,chain_id:invoice.chainId,member:relay.member,sequence:'2',expires_height:'200',operation:'private_payment',payload:result.payload},relay.raw,relay.privateKey);
 let directory;const writes=[];
 const onExchange=async value=>{directory=value.directory;for(const [name,data] of [['agreed-invoice.json',agreed],['recipient-consent.json',privatePartyConsent(context,intent.recipient.address,recipient.privateKey)],['certificate.json',{fixture:'public certificate'}],['review-approval.json',nativeApproval],['reviewer-invoice-binding.json',reviewerBinding],['relay-envelope.json',envelope]])await writeFile(join(directory,name),JSON.stringify(data),{mode:0o600,flag:'wx'});};
 const producer=async({callbacks,signal})=>{assert.equal(signal.aborted,false);await callbacks.signature({kind:'party_consent',intent,context,address:consentAddress});await callbacks.recipientConsent({intent,context,address:intent.recipient.address});await callbacks.certificate(context);await callbacks.review({fixture:'encrypted native review envelope'});return structuredClone(result);};
 const adapter={async signConsent(i,r){assert.deepEqual(i,intent);return privatePartyConsent(r.context,r.address,owner.privateKey);},async relayRequest(i,r){assert.deepEqual(r,result);return {schema:'baink-holder-relay-request-v1',chainId:invoice.chainId,genesisSha256:invoice.genesisSha256,operation:'private_payment',payload:r.payload,signer:{member:relay.member,publicKey:relay.key,sequence:'2'},expiresHeight:'200'};},async verifyRelayEnvelope(i,r,e){assert.deepEqual(e,envelope);assert.ok(verify(null,signingBytes(e.command),relay.publicKey,Buffer.from(e.signature,'base64url')));return e;}};
 // The courier deadline is not under test here (the mocked-clock tests below
 // cover it). A one-second wall-clock deadline raced the full file exchange
 // under concurrent CI load (2.6 s observed on 9 November), so fixtures use
 // the code's own default ceiling of a deadline rather than a load-sensitive one.
 const config={exchangeRoot:root,reader:{genesisSha256:invoice.genesisSha256},tools:{},timeoutMs:FIXTURE_DEADLINE_MS,onExchange};
 return {api,root,owner,recipient,reviewer,relay,invoice,intent,context,result,agreed,purposeEvidence,reviewerBinding,envelope,adapter,config,producer,get directory(){return directory;}};
}
test('usable private file courier obtains real participant/checker/relay signatures and returns only public transaction material',async t=>{
 const f=await fixture(t),execute=f.api.createCourierExecutor(f.config,{runProducer:f.producer,readState:async()=>({chain_id:f.invoice.chainId})});
 const output=await execute({adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),source:{kind:'boundary',id:'e'.repeat(64),position:0},signal:new AbortController().signal});
 assert.deepEqual(output.reviewerBinding,f.reviewerBinding);assert.deepEqual(output.envelope,f.envelope);assert.equal(output.effects,f.context.effects);
 assert.ok(!JSON.stringify(output).includes('local_receipt'));assert.ok(!JSON.stringify(output).includes('private fixture receipt'));
 for(const name of ['invoice-request.json','recipient-consent-request.json','certificate-request.json','review-envelope.json','relay-request.json','private-result.json','public-output.json'])assert.equal((await lstat(join(f.directory,name))).mode&0o777,0o600);
 assert.equal((await lstat(f.directory)).mode&0o777,0o700);assert.equal(JSON.parse(await readFile(join(f.directory,'private-result.json'))).local_receipt.secret,'private fixture receipt');
});
test('canonical invoice must match immutable id, public owner/payee, amount and pinned genesis',async t=>{
 const f=await fixture(t);
 for(const change of [{amountUnits:'27'},{payer:f.recipient.member},{payee:f.owner.member},{id:'other-invoice-id'},{genesisSha256:'f'.repeat(64)},{requestDigest:'bad'}]){
  const intent={...f.intent,agreement:{...f.intent.agreement,text:canonicalJSON({...f.invoice,...change})}};
  assert.throws(()=>f.api.parseCanonicalInvoice(intent,f.config.reader));
 }
 assert.throws(()=>f.api.parseCanonicalInvoice({...f.intent,agreement:{...f.intent.agreement,text:JSON.stringify(f.invoice,null,2)}},f.config.reader));
});
test('both participant agreement signatures and the exact independently inspecting checker signature are required',async t=>{
 const f=await fixture(t);assert.deepEqual(f.api.verifyAgreedInvoice(f.intent,f.invoice,f.agreed),f.agreed);
 const bad=structuredClone(f.agreed);bad.agreements[f.recipient.member].signature=bad.agreements[f.owner.member].signature;assert.throws(()=>f.api.verifyAgreedInvoice(f.intent,f.invoice,bad));
 for(const binding of [{...f.reviewerBinding,publicKey:f.owner.key},{...f.reviewerBinding,independentlyInspected:false},{...f.reviewerBinding,signature:'A'.repeat(86)}])assert.throws(()=>f.api.verifyReviewerInvoiceBinding(f.intent,f.invoice,f.result,binding));
 const changed={...f.invoice,requestDigest:'9'.repeat(64)};assert.throws(()=>f.api.verifyReviewerInvoiceBinding(f.intent,changed,f.result,f.reviewerBinding));
});
test('courier readers refuse symlinks, oversized files and weak private permissions',async t=>{
 const f=await fixture(t),good=join(f.root,'good.json');await writeFile(good,'{}',{mode:0o600});const link=join(f.root,'linked.json');await symlink(good,link);
 await assert.rejects(f.api.readCourierJSON(link));
 const loose=join(f.root,'loose.json');await writeFile(loose,'{}',{mode:0o644});await assert.rejects(f.api.readCourierJSON(loose));
 const large=join(f.root,'large.json');await writeFile(large,'x'.repeat(1024*1024+1),{mode:0o600});await assert.rejects(f.api.readCourierJSON(large));
});
test('missing real checker binding waits and cancellation ends the file courier without producing an envelope',async t=>{
 const f=await fixture(t),onExchange=f.config.onExchange;
 f.config.onExchange=async value=>{await onExchange(value);await rm(join(value.directory,'reviewer-invoice-binding.json'));};
 const execute=f.api.createCourierExecutor(f.config,{runProducer:f.producer,readState:async()=>({chain_id:f.invoice.chainId})}),controller=new AbortController();
 const pending=execute({adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),signal:controller.signal});
 setTimeout(()=>controller.abort(),40);await assert.rejects(pending);
});

test('paired payer exports only its pending recipient request and imports only the exact recipient signature',async t=>{
 const f=await fixture(t),base=f.config.onExchange;f.config.onExchange=async value=>{await base(value);await rm(join(value.directory,'recipient-consent.json'));};
 const execute=f.api.createCourierExecutor(f.config,{runProducer:f.producer,readState:async()=>({chain_id:f.invoice.chainId})}),operationId='11111111-1111-4111-8111-111111111111',controller=new AbortController();t.after(()=>controller.abort());
 const pending=execute({operationId,adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),signal:controller.signal});
 const exported=await until(()=>execute.recipientConsentRequest({operationId,intent:f.intent}),pending);
 assert.ok(exported);assert.deepEqual(exported.request.intent,f.intent);assert.deepEqual(exported.request.context,f.context);assert.equal(exported.request.address,f.intent.recipient.address);assert.equal(exported.request.chainId,f.invoice.chainId);assert.equal(exported.request.genesisSha256,f.invoice.genesisSha256);
 const consent=privatePartyConsent(f.context,f.intent.recipient.address,f.recipient.privateKey);
 await assert.rejects(execute.acceptRecipientConsent({operationId,intent:f.intent,requestDigest:'f'.repeat(64),consent}));
 await assert.rejects(execute.acceptRecipientConsent({operationId,intent:f.intent,requestDigest:exported.requestDigest,consent:privatePartyConsent(f.context,f.intent.recipient.address,f.owner.privateKey)}));
 await assert.rejects(execute.recipientConsentRequest({operationId,intent:{...f.intent,amount:'27'}}));
 assert.deepEqual(await execute.acceptRecipientConsent({operationId,intent:f.intent,requestDigest:exported.requestDigest,consent}),{accepted:true});
 assert.deepEqual((await pending).envelope,f.envelope);assert.equal(await execute.recipientConsentRequest({operationId,intent:f.intent}),null);
 await assert.rejects(execute.acceptRecipientConsent({operationId,intent:f.intent,requestDigest:exported.requestDigest,consent}));
});

test('paired payer delivers only the immutable bilateral agreement into its fixed pending courier file',async t=>{
 const f=await fixture(t),base=f.config.onExchange;let ready;const invoiceWaiting=new Promise(resolve=>{ready=resolve;});f.config.onExchange=async value=>{await base(value);await rm(join(value.directory,'agreed-invoice.json'));ready();};
 const execute=f.api.createCourierExecutor(f.config,{runProducer:f.producer,readState:async()=>({chain_id:f.invoice.chainId})}),operationId='22222222-2222-4222-8222-222222222222',controller=new AbortController();t.after(()=>controller.abort());
 const pending=execute({operationId,adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),signal:controller.signal});
 await invoiceWaiting;
 const bad=structuredClone(f.agreed);bad.invoice.amountUnits='27';await assert.rejects(execute.acceptInvoiceAgreement({operationId,intent:f.intent,agreement:bad}));
 assert.deepEqual(await execute.acceptInvoiceAgreement({operationId,intent:f.intent,agreement:f.agreed}),{accepted:true});assert.deepEqual((await pending).envelope,f.envelope);
 await assert.rejects(execute.acceptInvoiceAgreement({operationId,intent:f.intent,agreement:f.agreed}));
});


test('invoice purpose evidence is hash-bound and written before the bilateral agreement unblocks proof',async t=>{
 const f=await fixture(t,{withPurpose:true}),base=f.config.onExchange;let ready;const invoiceWaiting=new Promise(resolve=>{ready=resolve;});f.config.onExchange=async value=>{await base(value);await rm(join(value.directory,'agreed-invoice.json'));ready();};
 const execute=f.api.createCourierExecutor(f.config,{runProducer:f.producer,readState:async()=>({chain_id:f.invoice.chainId})}),operationId='33333333-3333-4333-8333-333333333333',controller=new AbortController();t.after(()=>controller.abort());
 const pending=execute({operationId,adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),signal:controller.signal});await invoiceWaiting;
 await assert.rejects(execute.acceptInvoiceAgreement({operationId,intent:f.intent,agreement:f.agreed,purposeEvidence:{...f.purposeEvidence,memo:'Changed unbound purpose'}}));
 assert.deepEqual(await execute.acceptInvoiceAgreement({operationId,intent:f.intent,agreement:f.agreed,purposeEvidence:f.purposeEvidence}),{accepted:true});assert.deepEqual((await pending).envelope,f.envelope);assert.deepEqual(await f.api.readCourierJSON(join(f.directory,'purpose-evidence.json')),f.purposeEvidence);
});


test('courier wait never reads a hardlink while atomic publication cleanup is pending',async t=>{
 const f=await fixture(t),temporary=join(f.root,'publishing.json'),visible=join(f.root,'published.json');await writeFile(temporary,JSON.stringify({fixture:'complete private response'}),{mode:0o600});await link(temporary,visible);
 await assert.rejects(f.api.readCourierJSON(visible));const controller=new AbortController();t.after(()=>controller.abort());let completed=false;
 const pending=f.api.waitForCourier(visible,controller.signal).then(value=>{completed=true;return value;});await new Promise(r=>setTimeout(r,10));assert.equal(completed,false);await rm(temporary);assert.deepEqual(await pending,{fixture:'complete private response'});
});

test('default courier survives 180 seconds and has a distinct bounded 360-second deadline',async t=>{
 const f=await fixture(t);delete f.config.timeoutMs;let started;const ready=new Promise(r=>{started=r;});let active,configured;
 const execute=f.api.createCourierExecutor(f.config,{readState:async()=>({chain_id:f.invoice.chainId}),runProducer:async({signal,timeoutMs})=>{active=signal;configured=timeoutMs;started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('private worker stderr must remain private')),{once:true}));}});
 t.mock.timers.enable({apis:['setTimeout']});const pending=execute({adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),signal:new AbortController().signal});const failed=assert.rejects(pending,e=>e.code==='HOLDER_COURIER_TIMEOUT'&&e.message==='Holder courier deadline exceeded');await ready;
 assert.equal(configured,360000);t.mock.timers.tick(180001);assert.equal(active.aborted,false);t.mock.timers.tick(179999);await failed;
});
test('courier custom deadline remains capped at 600 seconds',async t=>{const f=await fixture(t);assert.throws(()=>f.api.createCourierExecutor({...f.config,timeoutMs:600001}));assert.equal(typeof f.api.createCourierExecutor({...f.config,timeoutMs:600000}),'function');});

test('owner cancellation is not mislabeled as a courier deadline',async t=>{const f=await fixture(t);let started;const ready=new Promise(r=>{started=r;}),owner=new AbortController();const execute=f.api.createCourierExecutor(f.config,{readState:async()=>({chain_id:f.invoice.chainId}),runProducer:async({signal})=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Owner operation cancelled')),{once:true}));}});const pending=execute({adapter:f.adapter,intent:f.intent,spendingKeyFile:join(f.root,'orchard-key.json'),signal:owner.signal});const failed=assert.rejects(pending,e=>e.code!=='HOLDER_COURIER_TIMEOUT');await ready;owner.abort();await failed;});
