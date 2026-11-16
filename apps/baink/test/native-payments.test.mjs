import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createNativePaymentService, paymentAgreementBytes, paymentConfirmationBytes, paymentReviewerBindingBytes } from '../server/native-payments.mjs';
import { signingBytes } from '../../../chain/client/signing.mjs';
import { canonicalJSON } from '../server/native-financial-command.mjs';
import { createTradeService } from '../server/trade.mjs';
import { createTradeTermsService } from '../server/trade-terms.mjs';
import { tradePaymentMemo, validateTradePaymentRequest } from '../server/trade-payment.mjs';
import { createTradeAvailability } from '../server/trade-availability.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function person() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);
  return {...pair, publicKeyObject:pair.publicKey, publicKey:raw.toString('base64'), address:'uain1'+hash(raw).slice(0,40), raw};
}
function fixture({tradeAvailability=null}={}) {
  const payer=person(),payee=person(),relay=person(),reviewer=person(), stranger=person();
  let data={requests:{}},tail=Promise.resolve(),sends=0,lost=false,proofPatch={},receipt=null;
  const store={read:()=>structuredClone(data),transact(fn){const task=tail.then(()=>{const next=structuredClone(data),value=fn(next);data=next;return structuredClone(value);});tail=task.catch(()=>{});return task;}};
  const members=Object.fromEntries([payer,payee,relay,reviewer].map(p=>[p.address,{id:p.address,public_key:p.raw.toString('base64url'),sequence:'7',licence:'active',karma:200}]));
  const state={chain_id:'payment-test',height:'100',app_hash:'c'.repeat(64),event_count:'0',records:{
    private_activation:{policy:'orchard-v2-reviewed-otc-v1',height:'1',relayer:relay.address},
    coin_activation:{policy:'verified-bounties-108t-micro-v1',height:'1'},
    private_licence_revision:{value:'1'},
    ['private_reviewer/'+reviewer.address]:{active:true},
  }};
  for(const [id,m] of Object.entries(members))state.records['member/'+id]=m;
  const native={configured:true,timeoutMs:1000,pins:{chainId:state.chain_id,epoch:'a'.repeat(64),verifierSha256:'b'.repeat(64)},
    async publicState(selection){return{state:{...structuredClone(state),member:members[selection.member],records:Object.fromEntries((selection.keys??[]).map(k=>[k,structuredClone(state.records[k]??null)])),...(selection.receipt?{receipt}: {})},proof:{authority:'native',chainId:state.chain_id,epoch:'a'.repeat(64),genesisSha256:'a'.repeat(64),verifierSha256:'b'.repeat(64),height:state.height,appHash:state.app_hash,headerTime:new Date().toISOString(),maxAgeSeconds:120,...proofPatch}};},
    async broadcastPayment(envelope){sends++;assert.ok(Object.values(store.read().nativePaymentIntents).some(i=>i.sendAttemptedAt&&i.envelope));if(lost)throw Error('uncertain');return{transactionHash:hash(JSON.stringify(envelope)).toUpperCase(),accepted:true,code:0};},
  };
  let service=createNativePaymentService({store,native,enabled:true,validateTradeRequest:validateTradePaymentRequest,tradeAvailability});
  const body={clientRequestId:'payment-request-01',to:payee.address,amountUnits:'26000000'};
  return{payer,payee,relay,reviewer,stranger,store,state,native,members,body,get service(){return service;},get sends(){return sends;},lose(){lost=true;},patch(p){proofPatch=p;},receiptPatch(p){Object.assign(receipt,p);},restart(){service=createNativePaymentService({store,native,enabled:true,validateTradeRequest:validateTradePaymentRequest,tradeAvailability});},
    async prepare(overrides={}){return(await service.prepare(payer,{...body,...overrides})).intent;},
    async agree(intent,purpose='e'.repeat(64)){for(const p of [payer,payee])await service.agree(p,intent.id,{purposeCommitment:purpose,signature:sign(null,paymentAgreementBytes(intent,purpose),p.privateKey).toString('base64url')});return service.get(payer,intent.id).intent;},
    envelope(intent,effects='d'.repeat(64)){
      const purpose=intent.purposeCommitment, context={version:1,chain:state.chain_id,expires:'180',licenceRevision:'1',effects,purpose,reviewer:reviewer.raw.toString('hex')};
      // Match the existing public checker approval format without involving secrets in the service.
      const u64=value=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(value));return b;};
      const bytes=Buffer.concat([Buffer.from('UAIN/private-exchange/approval/v1\0'),Buffer.from(hash(state.chain_id),'hex'),u64('180'),u64('1'),Buffer.from(effects,'hex'),Buffer.from(purpose,'hex'),Buffer.from([1,1]),reviewer.raw]);
      const approval={reviewer:reviewer.address,effects,purpose_commitment:purpose,class:'benevolent',expires_height:'180',licence_revision:'1',signature:sign(null,bytes,reviewer.privateKey).toString('base64url')};
      const command={version:1,chain_id:state.chain_id,member:relay.address,sequence:'7',expires_height:'180',operation:'private_payment',payload:{bundle:Buffer.alloc(100,1).toString('base64url'),approval}};
      return{command,public_key:relay.raw.toString('base64url'),signature:sign(null,signingBytes(command),relay.privateKey).toString('base64url')};
    },
    submission(intent,envelope=this.envelope(intent)) {
      return{envelope,reviewerBinding:{publicKey:reviewer.raw.toString('base64url'),independentlyInspected:true,signature:sign(null,paymentReviewerBindingBytes(intent,{effects:envelope.command.payload.approval.effects,reviewer:reviewer.address}),reviewer.privateKey).toString('base64url')}};
    },
    finalize(intent,patch={}){const event={id:'1',member:relay.address,operation:'private_payment',subject:intent.effects,command_digest:intent.commandDigest,...patch};state.event_count='1';state.height='101';state.records['event/00000000000000000001']=event;receipt={authority:'native',finalized:true,chain_id:state.chain_id,state_height:state.height,app_hash:state.app_hash,event};},
    confirmation(intent){return{effects:intent.effects,chainId:intent.chainId,requestDigest:intent.requestDigest,locallyInspected:true,signature:sign(null,paymentConfirmationBytes(intent),payee.privateKey).toString('base64url')};},
  };
}
const rejects=(promise,code)=>assert.rejects(promise,e=>e.code===code);

async function tradeRequest(f) {
  await f.store.transact(s=>{s.accounts=Object.fromEntries([f.payer,f.payee].map(p=>[p.address,{address:p.address,publicKey:p.publicKey}]));});
  const trade=createTradeService({store:f.store});
  const {offer}=await trade.create(f.payee,{clientRequestId:'trade-native-offer',title:'Original service scope',description:'A fictional service discussion for a payment boundary test.',price:'26',publish:true});
  const {enquiry}=await trade.enquire(f.payer,offer.id,{clientRequestId:'trade-native-enquiry',expectedRevision:offer.revision,message:'Discuss the exact service scope.'});
  const terms=createTradeTermsService({store:f.store,context:(...args)=>trade.termsContext(...args)});
  const {draft}=await terms.create(f.payee,enquiry.id,{clientRequestId:'trade-native-draft',terms:{scope:'Review this exact fictional package.',deliverables:'A written report on the exact inputs.',price:'26',timeline:'Within two working days.',acceptanceCriteria:'Document the inputs and observed outcomes.',expiresAt:null}});
  const {proposal}=await terms.send(f.payee,draft.id,{clientRequestId:'trade-native-proposal',expectedRevision:draft.revision,confirmNonbinding:true});
  const snapshotDigest=hash(canonicalJSON(proposal));
  const row={id:'R',from:f.payee.address,to:f.payer.address,amount:'26',memo:tradePaymentMemo(proposal,snapshotDigest),status:'open',currency:'AI$',createdAt:new Date().toISOString(),updatedAt:'trade-version-1',trade:{schema:'baink-trade-payment-v1',proposal,snapshotDigest}};
  await f.store.transact(s=>{s.requests.R=row;});
  return{row,snapshotDigest,body:{requestId:'R',requestVersion:row.updatedAt,expectedTradeDigest:snapshotDigest}};
}

test('trade payment requires explicit buyer review of the exact full sent snapshot',async()=>{
  const f=fixture(),trade=await tradeRequest(f);
  await rejects(f.prepare({requestId:'R',requestVersion:trade.row.updatedAt}),'payment_trade_review_required');
  await rejects(f.prepare({...trade.body,expectedTradeDigest:'f'.repeat(64)}),'payment_trade_review_required');
  const intent=await f.prepare(trade.body);
  assert.equal(intent.tradeDigest,trade.snapshotDigest);
  assert.equal(intent.memo,trade.row.memo);
  const snapshot=Object.fromEntries(['id','from','to','amount','memo','currency','createdAt','updatedAt'].map(k=>[k,trade.row[k]]));
  assert.equal(intent.requestDigest,hash(canonicalJSON(snapshot)));
  assert.equal(intent.payer,f.payer.address);assert.equal(intent.payee,f.payee.address);assert.equal(f.sends,0);
});
test('ordinary invoices and direct payments cannot smuggle a trade-review token',async()=>{
  const f=fixture();await rejects(f.prepare({expectedTradeDigest:'a'.repeat(64)}),'invalid_payment_intent');
  await f.store.transact(s=>{s.requests.R={id:'R',from:f.payee.address,to:f.payer.address,amount:'26',memo:'ordinary',status:'open',currency:'AI$',createdAt:'one',updatedAt:'version-1'};});
  await rejects(f.prepare({requestId:'R',requestVersion:'version-1',expectedTradeDigest:'a'.repeat(64)}),'invalid_payment_intent');
  assert.equal(f.sends,0);
});
test('trade preparation rejects altered terms, digest, price, memo and counterparty before any lock',async()=>{
  for(const alter of [r=>{r.trade.proposal.terms.scope='Another service.';},r=>{r.trade.snapshotDigest='a'.repeat(64);},r=>{r.trade.proposal.terms.price='27.000000';},r=>{r.trade.proposal.terms.priceUnits='27000000';},r=>{r.memo='Generic invoice';},r=>{r.trade.proposal.author=r.to;},r=>{r.trade.proposal.enquirySnapshot.buyer=r.from;},r=>{r.trade.proposal.enquirySnapshot.seller=r.to;}]){
    const f=fixture(),trade=await tradeRequest(f);await f.store.transact(s=>alter(s.requests.R));
    await rejects(f.prepare(trade.body),'payment_request_changed');
    assert.equal(Object.keys(f.store.read().nativePaymentIntents??{}).length,0);assert.equal(f.sends,0);
  }
});
test('reviewed trade intent survives restart and replay without changing terms or creating a second request payment',async()=>{
  const f=fixture(),trade=await tradeRequest(f),intent=await f.prepare(trade.body);f.restart();
  assert.equal((await f.prepare(trade.body)).id,intent.id);
  await rejects(f.prepare({...trade.body,expectedTradeDigest:'a'.repeat(64)}),'payment_idempotency_conflict');
  await rejects(f.prepare({...trade.body,clientRequestId:'trade-second-intent'}),'payment_request_locked');
  assert.equal(Object.keys(f.store.read().nativePaymentIntents).length,1);assert.equal(f.sends,0);
});
test('trade snapshot cannot be changed or removed between review, both agreements and submission',async()=>{
  for(const phase of ['agreement','submission','remove']){
    const f=fixture(),trade=await tradeRequest(f),intent=await f.prepare(trade.body);
    const agreed=phase==='agreement'?null:await f.agree(intent);
    await f.store.transact(s=>{if(phase==='remove')delete s.requests.R.trade;else s.requests.R.trade.proposal.terms.deliverables='Changed after buyer review.';});f.restart();
    if(phase==='agreement')await rejects(f.agree(intent),'payment_request_changed');
    else await rejects(f.service.submit(f.payer,intent.id,f.submission(agreed)),'payment_request_changed');
    assert.equal(f.sends,0);assert.equal(f.service.get(f.payer,intent.id).intent.sendAttemptedAt,null);
  }
});
test('only the intended buyer can prepare the reviewed trade request for its seller',async()=>{
  const f=fixture(),trade=await tradeRequest(f);
  await rejects(f.service.prepare(f.payee,{...f.body,...trade.body,to:f.payer.address}),'payment_request_changed');
  assert.equal(f.sends,0);
});

test('payer-bound exact atomic intent is stable and metadata never becomes a balance',async()=>{const f=fixture(),i=await f.prepare();assert.equal(i.payer,f.payer.address);assert.equal(i.amountUnits,'26000000');assert.equal(i.status,'awaiting-agreement');assert.equal((await f.prepare()).id,i.id);await rejects(f.prepare({amountUnits:'26000001'}),'payment_idempotency_conflict');assert.equal(i.balance,undefined);assert.equal(f.sends,0);assert.equal(f.service.list(f.stranger).intents.length,0);assert.throws(()=>f.service.get(f.stranger,i.id),e=>e.code==='payment_intent_missing');});
test('bounded inputs and stale, mismatched or unlicensed state fail closed',async()=>{for(const body of [{amountUnits:'1.1'},{amountUnits:'0'},{amountUnits:'1e6'},{to:'bad'},{privateKey:'secret'}]){const f=fixture();await rejects(f.prepare(body),'invalid_payment_intent');}for(const patch of [{epoch:'f'.repeat(64)},{headerTime:new Date(0).toISOString()},{chainId:'wrong'},{genesisSha256:'f'.repeat(64)}]){const f=fixture();f.patch(patch);await rejects(f.prepare(),'native_proof_unavailable');}const f=fixture();f.members[f.payee.address].licence='pending';await rejects(f.prepare(),'native_licence_inactive');});
test('both participants must sign the same frozen purpose before envelope acceptance',async()=>{const f=fixture(),i=await f.prepare();await rejects(f.service.submit(f.payer,i.id,f.submission({...i,purposeCommitment:'e'.repeat(64)})),'payment_agreement_required');await rejects(f.service.agree(f.stranger,i.id,{purposeCommitment:'e'.repeat(64),signature:'bad'}),'payment_intent_missing');await f.agree(i);const ready=f.service.get(f.payer,i.id).intent;assert.equal(ready.status,'intent-ready');await rejects(f.service.agree(f.payee,i.id,{purposeCommitment:'f'.repeat(64),signature:sign(null,paymentAgreementBytes(i,'f'.repeat(64)),f.payee.privateKey).toString('base64url')}),'payment_agreement_conflict');});
test('request amount, parties and revision freeze and duplicate intents cannot double-pay a request',async()=>{const f=fixture();await f.store.transact(s=>{s.requests.R={id:'R',from:f.payee.address,to:f.payer.address,amount:'26',memo:'invoice',status:'open',currency:'AI$',createdAt:'one',updatedAt:'version-1'};});const i=await f.prepare({requestId:'R',requestVersion:'version-1'});await rejects(f.prepare({clientRequestId:'another-request',requestId:'R',requestVersion:'version-1'}),'payment_request_locked');await f.agree(i);await f.store.transact(s=>{s.requests.R.amount='27';});await rejects(f.service.submit(f.payer,i.id,f.submission(f.service.get(f.payer,i.id).intent)),'payment_request_changed');});
test('exact relay envelope broadcasts once with durable marker through uncertainty and restart',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),envelope=f.envelope(i);f.lose();let r=await f.service.submit(f.payer,i.id,f.submission(i,envelope));assert.equal(r.intent.status,'unknown');f.restart();r=await f.service.submit(f.payer,i.id,f.submission(i,envelope));assert.equal(r.attempted,false);assert.equal(f.sends,1);await rejects(f.service.submit(f.payee,i.id,f.submission(i,envelope)),'payment_payer_required');});
test('wrong purpose, reviewer, relay signature and operation never broadcast',async()=>{for(const mutate of [e=>e.command.operation='coin_shield',e=>e.command.payload.approval.purpose_commitment='f'.repeat(64),e=>e.signature='bad',e=>e.command.payload.approval.signature='bad']){const f=fixture(),i=await f.agree(await f.prepare()),envelope=f.envelope(i);mutate(envelope);await assert.rejects(f.service.submit(f.payer,i.id,f.submission(i,envelope)));assert.equal(f.sends,0);}});
test('one public effect cannot be assigned to two payment intents',async()=>{const f=fixture(),a=await f.agree(await f.prepare()),b=await f.agree(await f.prepare({clientRequestId:'different-request'}));await f.service.submit(f.payer,a.id,f.submission(a));await rejects(f.service.submit(f.payer,b.id,f.submission(b)),'payment_effect_reused');assert.equal(f.sends,1);});
test('record-only and wrong exact native event cannot mark a payment recorded or paid',async()=>{const f=fixture(),i=await f.agree(await f.prepare());const r=await f.service.submit(f.payer,i.id,f.submission(i));f.finalize(r.intent,{subject:'f'.repeat(64)});await rejects(f.service.receipt(f.payer,i.id,{}),'native_proof_unavailable');assert.notEqual(f.service.get(f.payer,i.id).intent.status,'ledger-recorded');await rejects(f.service.confirm(f.payee,i.id,f.confirmation(r.intent)),'payment_not_recorded');});
test('exact receipt is recorded separately from recipient local-note acknowledgement',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),r=await f.service.submit(f.payer,i.id,f.submission(i));f.finalize(r.intent);const recorded=(await f.service.receipt(f.payee,i.id,{})).intent;assert.equal(recorded.status,'ledger-recorded');assert.equal(recorded.paid,false);await rejects(f.service.confirm(f.payer,i.id,f.confirmation(recorded)),'payment_recipient_required');await rejects(f.service.confirm(f.payee,i.id,{...f.confirmation(recorded),locallyInspected:false}),'invalid_payment_confirmation');const paid=(await f.service.confirm(f.payee,i.id,f.confirmation(recorded))).intent;assert.equal(paid.status,'recipient-confirmed-paid');assert.equal(paid.amountVerification,'recipient-attested');assert.equal(paid.publicAmountProof,false);assert.equal(paid.paid,true);assert.equal((await f.service.confirm(f.payee,i.id,f.confirmation(recorded))).intent.status,paid.status);});
test('receipt-only recovery never broadcasts and exact envelope cannot be replaced',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),envelope=f.envelope(i);const recovered=await f.service.recover(f.payer,i.id,f.submission(i,envelope));assert.equal(recovered.intent.status,'unknown');assert.equal(f.sends,0);await f.service.submit(f.payer,i.id,f.submission(i,envelope));assert.equal(f.sends,0);await rejects(f.service.recover(f.payer,i.id,f.submission(i,f.envelope(i,'f'.repeat(64)))),'payment_envelope_conflict');});
test('concurrent identical submissions commit one journal and send once',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),envelope=f.envelope(i);const results=await Promise.all([f.service.submit(f.payer,i.id,f.submission(i,envelope)),f.service.submit(f.payer,i.id,f.submission(i,envelope))]);assert.equal(results.filter(r=>r.attempted).length,1);assert.equal(f.sends,1);});
test('receipt-only recovery works after role revocation without making new sends eligible',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),envelope=f.envelope(i);for(const member of Object.values(f.members))member.licence='inactive';const recovered=(await f.service.recover(f.payer,i.id,f.submission(i,envelope))).intent;f.finalize(recovered);const result=await f.service.receipt(f.payer,i.id,{});assert.equal(result.intent.status,'ledger-recorded');assert.equal(f.sends,0);});
test('an unproved recovery claim cannot steal the global effect reservation',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),other=await f.agree(await f.prepare({clientRequestId:'other-payment-1'}));await f.service.recover(f.payer,i.id,f.submission(i));assert.deepEqual(f.store.read().nativePaymentEffects,undefined);await f.service.submit(f.payer,other.id,f.submission(other));assert.equal(f.sends,1);f.finalize(f.service.get(f.payer,i.id).intent);await rejects(f.service.receipt(f.payer,i.id,{}),'payment_effect_reused');});
test('a record-only receipt is rejected despite a matching event projection',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),r=(await f.service.submit(f.payer,i.id,f.submission(i))).intent;f.finalize(r);f.receiptPatch({finalized:false,proof_kind:'ciphertext_record',transaction_inclusion_verified:false});await rejects(f.service.receipt(f.payer,i.id,{}),'native_proof_unavailable');});
test('recipient acknowledgement rejects chain, effect, request and signature substitutions',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),sent=(await f.service.submit(f.payer,i.id,f.submission(i))).intent;f.finalize(sent);const recorded=(await f.service.receipt(f.payee,i.id,{})).intent;for(const patch of [{chainId:'other'},{effects:'f'.repeat(64)},{requestDigest:'f'.repeat(64)},{signature:'bad'},{privateKey:'secret'}])await assert.rejects(f.service.confirm(f.payee,i.id,{...f.confirmation(recorded),...patch}));assert.equal(f.service.get(f.payer,i.id).intent.paid,false);});
test('only recipient confirmation updates a frozen request and no metadata balance changes',async()=>{const f=fixture();await f.store.transact(s=>{s.requests.R={id:'R',from:f.payee.address,to:f.payer.address,amount:'26.000000',memo:'invoice',status:'open',currency:'AI$',createdAt:'one',updatedAt:'version-1'};s.accounts={[f.payer.address]:{balance:null}};});const i=await f.agree(await f.prepare({requestId:'R',requestVersion:'version-1'})),sent=(await f.service.submit(f.payer,i.id,f.submission(i))).intent;f.finalize(sent);const recorded=(await f.service.receipt(f.payee,i.id,{})).intent;assert.equal(f.store.read().requests.R.status,'open');await f.service.confirm(f.payee,i.id,f.confirmation(recorded));assert.equal(f.store.read().requests.R.status,'paid');assert.equal(f.store.read().requests.R.settlement.amountVerification,'recipient-attested');assert.equal(f.store.read().accounts[f.payer.address].balance,null);});
test('payer/payee agreement cannot appropriate another effect without the exact checker binding',async()=>{const f=fixture(),a=await f.agree(await f.prepare()),b=await f.agree(await f.prepare({clientRequestId:'appropriation-test'})),submission=f.submission(a);await rejects(f.service.recover(f.payer,b.id,submission),'invalid_payment_reviewer_binding');assert.equal(f.store.read().nativePaymentEffects,undefined);assert.equal(f.service.get(f.payer,b.id).intent.envelope,null);});
test('checker binding is required and rejects attacker signature, wrong effects and changed invoice fields',async()=>{const f=fixture(),i=await f.agree(await f.prepare()),good=f.submission(i);await rejects(f.service.submit(f.payer,i.id,{envelope:good.envelope}),'invalid_payment_envelope');for(const patch of [{independentlyInspected:false},{publicKey:f.payer.raw.toString('base64url')},{signature:'bad'},{signature:sign(null,paymentReviewerBindingBytes({...i,amountUnits:'1'},{effects:good.envelope.command.payload.approval.effects,reviewer:f.reviewer.address}),f.reviewer.privateKey).toString('base64url')}])await assert.rejects(f.service.recover(f.payer,i.id,{...good,reviewerBinding:{...good.reviewerBinding,...patch}}));assert.equal(f.sends,0);assert.equal(f.service.get(f.payer,i.id).intent.envelope,null);});
test('new sends still require an active appointed reviewer and active payment policies',async()=>{for(const mutate of [f=>{f.state.records['private_reviewer/'+f.reviewer.address].active=false;},f=>{f.members[f.reviewer.address].licence='inactive';},f=>{f.state.records.private_activation.policy='wrong';},f=>{f.state.records.private_licence_revision.value='2';}]){const f=fixture(),i=await f.agree(await f.prepare());mutate(f);await assert.rejects(f.service.submit(f.payer,i.id,f.submission(i)));assert.equal(f.sends,0);}});
test('memo is bounded and frozen into idempotency and checker invoice digest',async()=>{const f=fixture(),i=await f.prepare({memo:'Invoice one'});assert.equal(i.memo,'Invoice one');await rejects(f.prepare({memo:'Invoice two'}),'payment_idempotency_conflict');assert.notEqual((await f.prepare({clientRequestId:'memo-other-request',memo:'Invoice two'})).requestDigest,i.requestDigest);await rejects(f.prepare({clientRequestId:'memo-invalid-request',memo:'x'.repeat(501)}),'invalid_payment_intent');});
test('either participant may abandon before bilateral agreement, releasing request lock without reviving old signing rights',async()=>{const f=fixture();await f.store.transact(s=>{s.requests.R={id:'R',from:f.payee.address,to:f.payer.address,amount:'26',memo:'invoice',status:'open',currency:'AI$',createdAt:'one',updatedAt:'version-1'};});const i=await f.prepare({requestId:'R',requestVersion:'version-1'});assert.equal((await f.service.abandon(f.payee,i.id,{})).intent.status,'abandoned');assert.equal(f.store.read().nativePaymentRequestLocks.R,undefined);await rejects(f.service.agree(f.payer,i.id,{purposeCommitment:'e'.repeat(64),signature:sign(null,paymentAgreementBytes(i,'e'.repeat(64)),f.payer.privateKey).toString('base64url')}),'payment_intent_abandoned');const next=await f.prepare({clientRequestId:'new-after-abandon',requestId:'R',requestVersion:'version-1'});await f.agree(next);assert.equal((await f.service.abandon(f.payer,next.id,{})).intent.status,'abandoned');assert.equal(f.store.read().nativePaymentRequestLocks.R,undefined);const sent=await f.agree(await f.prepare({clientRequestId:'sent-after-abandon',requestId:'R',requestVersion:'version-1'}));await f.service.submit(f.payer,sent.id,f.submission(sent));await rejects(f.service.abandon(f.payer,sent.id,{}),'payment_reconcile_required');await rejects(f.service.abandon(f.payee,sent.id,{}),'payment_reconcile_required');assert.equal(f.store.read().nativePaymentRequestLocks.R,sent.id);});
test('queued submission rechecks proof freshness before persisting a send marker or effect lock',async t=>{const f=fixture(),i=await f.agree(await f.prepare()),original=f.store.transact.bind(f.store),wall=Date.now();let offset=0;t.mock.method(Date,'now',()=>wall+offset);f.store.transact=fn=>original(state=>{offset=600000;return fn(state)});await rejects(f.service.submit(f.payer,i.id,f.submission(i)),'native_proof_unavailable');assert.equal(f.sends,0);assert.equal(f.service.get(f.payer,i.id).intent.sendAttemptedAt,null);assert.equal(f.store.read().nativePaymentEffects,undefined)});
test('queued submission cannot reset the shared operation deadline while its proof is still fresh',async t=>{const f=fixture(),i=await f.agree(await f.prepare()),original=f.store.transact.bind(f.store),wall=Date.now();let offset=0;t.mock.method(Date,'now',()=>wall+offset);f.store.transact=fn=>original(state=>{offset=2000;return fn(state)});await rejects(f.service.submit(f.payer,i.id,f.submission(i)),'payment_submission_expired');assert.equal(f.sends,0);assert.equal(f.service.get(f.payer,i.id).intent.sendAttemptedAt,null)});
test('expiry during marker persistence records no broadcast and never blindly retries the retained envelope',async t=>{const f=fixture(),i=await f.agree(await f.prepare()),original=f.store.transact.bind(f.store),wall=Date.now();let offset=0;t.mock.method(Date,'now',()=>wall+offset);f.store.transact=async fn=>{const result=await original(fn);offset=600000;return result};const submitted=await f.service.submit(f.payer,i.id,f.submission(i));assert.equal(submitted.attempted,false);assert.equal(submitted.intent.status,'not-broadcast');assert.equal(submitted.intent.broadcastAttempted,false);assert.ok(submitted.intent.sendAttemptedAt);assert.ok(submitted.intent.envelope);assert.equal(f.sends,0);f.restart();await f.service.submit(f.payer,i.id,f.submission(i));assert.equal(f.sends,0)});
test('payment intents accept the exact Orchard int64 maximum and refuse larger amounts before invoice locking',async()=>{const allowed=fixture(),maximum=await allowed.prepare({amountUnits:'9223372036854775807'});assert.equal(maximum.amountUnits,'9223372036854775807');for(const amountUnits of ['9223372036854775808','108000000000000000000']){const f=fixture();await f.store.transact(s=>{s.requests.R={id:'R',from:f.payee.address,to:f.payer.address,amount:amountUnits==='9223372036854775808'?'9223372036854.775808':'108000000000000',memo:'invoice',status:'open',currency:'AI$',createdAt:'one',updatedAt:'version-1'}});await rejects(f.prepare({amountUnits,requestId:'R',requestVersion:'version-1'}),'invalid_payment_intent');assert.equal(f.store.read().nativePaymentRequestLocks,undefined);assert.equal(f.store.read().nativePaymentIntents,undefined);assert.equal(f.sends,0)}});

// T1 recovery: reconcile, then let the buyer retry or cancel; never lock permanently.
import { createTradeRoutes, requestPaymentLock } from '../server/routes/trade.mjs';
import { PAYMENT_REQUEST_EXPIRY_MS } from '../server/native-payments.mjs';
function refuse(f){let refused=0;f.native.broadcastPayment=async envelope=>{refused++;return{transactionHash:hash(JSON.stringify(envelope)).toUpperCase(),accepted:false,code:5};};return()=>refused;}
const U='00000000-0000-4000-8000-0000000000aa';
async function invoice(f,extra={}){await f.store.transact(s=>{s.history??=[];s.requests[U]={id:U,from:f.payee.address,to:f.payer.address,amount:'26',memo:'invoice',status:'open',currency:'AI$',createdAt:new Date().toISOString(),updatedAt:'version-1',...extra};});return{requestId:U,requestVersion:'version-1'};}
function routes(f){const r=createTradeRoutes({store:f.store,nativePayments:f.service,nativeAsset:{async account(){return{native:{verified:true,memberStatus:'active',assetStatus:'active'}};}}});
  return(user,method,target,body={})=>{const url=new URL('http://baink.test'+target);return r.member({method,path:url.pathname,url,body,user,query:()=>({}),send:(status,body)=>({status,body})});};}
async function refusedSend(f,clientRequestId='payment-request-01'){const req=await invoice(f),i=await f.agree(await f.prepare({clientRequestId,...req})),sent=(await f.service.submit(f.payer,i.id,f.submission(i))).intent;return{req,i,sent};}

test('refused send -> proved expiry -> reconcile -> expired-unused releases lock and effect; request cancel succeeds',async()=>{
  const f=fixture(),count=refuse(f),{i,sent}=await refusedSend(f);assert.equal(sent.status,'refused');assert.equal(count(),1);
  await rejects(f.service.abandon(f.payer,i.id,{}),'payment_reconcile_required');
  const route=routes(f);await assert.rejects(route(f.payee,'POST',`/api/requests/${U}/cancel`),e=>e.code==='payment_request_locked');
  f.state.height='181';
  await rejects(f.service.reconcile(f.payee,i.id,{}),'payment_payer_required');
  const done=(await f.service.reconcile(f.payer,i.id,{})).intent;
  assert.equal(done.status,'expired-unused');assert.equal(done.paid,false);assert.equal(done.recovery.priorStatus,'refused');assert.equal(done.recovery.recordPresent,false);assert.equal(done.recovery.recordKey,'private_payment/'+sent.effects);
  assert.equal(f.store.read().nativePaymentRequestLocks[U],undefined);assert.deepEqual(f.store.read().nativePaymentEffects,{});
  assert.equal((await f.service.reconcile(f.payer,i.id,{})).intent.status,'expired-unused');
  assert.equal((await f.service.abandon(f.payer,i.id,{})).intent.status,'abandoned');
  const closed=await route(f.payee,'POST',`/api/requests/${U}/cancel`);assert.equal(closed.body.request.status,'cancelled');assert.equal(count(),1);
});
test('a stale lock on an expired-unused intent is released by request cancel in the same transaction',async()=>{
  const f=fixture();refuse(f);const id='00000000-0000-4000-8000-000000000001';
  await f.store.transact(s=>{s.history=[];s.requests[id]={id,from:f.payee.address,to:f.payer.address,amount:'26',memo:'invoice',status:'open',currency:'AI$',createdAt:new Date().toISOString(),updatedAt:'version-1'};});
  const i=await f.agree(await f.prepare({requestId:id,requestVersion:'version-1'}));await f.service.submit(f.payer,i.id,f.submission(i));
  const route=routes(f);await assert.rejects(route(f.payer,'POST',`/api/requests/${id}/decline`),e=>e.code==='payment_request_locked');
  await f.store.transact(s=>{s.nativePaymentIntents[i.id].status='expired-unused';});
  assert.equal((await route(f.payer,'POST',`/api/requests/${id}/decline`)).body.request.status,'declined');assert.equal(f.store.read().nativePaymentRequestLocks[id],undefined);
});
test('refused send -> proved expiry -> a new prepare for the same request succeeds and sends once more only through the new intent',async()=>{
  const f=fixture(),count=refuse(f),{req,i}=await refusedSend(f);
  await rejects(f.prepare({clientRequestId:'retry-request-01',...req}),'payment_request_locked');
  f.state.height='181';await f.service.reconcile(f.payer,i.id,{});
  const next=await f.prepare({clientRequestId:'retry-request-01',...req});assert.notEqual(next.id,i.id);assert.equal(f.store.read().nativePaymentRequestLocks[U],next.id);
  await rejects(f.prepare({clientRequestId:'retry-request-02',...req}),'payment_request_locked');
  // The retried send needs a fresh envelope at the new height; the old one is never reused.
  assert.equal(count(),1);
});
test('unknown send with the record present: reconcile refuses expiry and points to receipt',async()=>{
  const f=fixture();f.lose();const {i,sent}=await refusedSend(f);assert.equal(sent.status,'unknown');
  f.state.height='181';f.state.records['private_payment/'+sent.effects]={bundle:'x'};
  await rejects(f.service.reconcile(f.payer,i.id,{}),'payment_record_present');
  const after=f.service.get(f.payer,i.id).intent;assert.equal(after.status,'unknown');assert.equal(after.recovery,undefined);assert.equal(f.store.read().nativePaymentRequestLocks[U],i.id);
});
test('reconcile before the expiry height, or after the relay sequence moved, refuses with 409 and changes nothing',async()=>{
  const f=fixture();refuse(f);const {i}=await refusedSend(f),before=f.store.read();
  await assert.rejects(f.service.reconcile(f.payer,i.id,{}),e=>e.code==='payment_recovery_not_ready'&&e.status===409);
  f.state.height='180';await rejects(f.service.reconcile(f.payer,i.id,{}),'payment_recovery_not_ready');
  f.state.height='181';f.members[f.relay.address].sequence='8';await rejects(f.service.reconcile(f.payer,i.id,{}),'payment_recovery_not_ready');
  await rejects(f.service.reconcile(f.payer,i.id,{extra:true}),'invalid_payment_reconcile');
  assert.deepEqual(f.store.read(),before);
  const unsent=await f.prepare({clientRequestId:'unsent-request-1'});await rejects(f.service.reconcile(f.payer,unsent.id,{}),'payment_not_submitted');
});
test('not-broadcast -> proved expiry -> reconcile -> abandon is allowed',async t=>{
  const f=fixture(),req=await invoice(f),i=await f.agree(await f.prepare(req)),original=f.store.transact.bind(f.store),wall=Date.now();let offset=0;t.mock.method(Date,'now',()=>wall+offset);
  f.store.transact=async fn=>{const result=await original(fn);offset=600000;return result};
  const sent=(await f.service.submit(f.payer,i.id,f.submission(i))).intent;assert.equal(sent.status,'not-broadcast');f.store.transact=original;offset=0;
  await rejects(f.service.abandon(f.payer,i.id,{}),'payment_reconcile_required');
  f.state.height='181';assert.equal((await f.service.reconcile(f.payer,i.id,{})).intent.recovery.priorStatus,'not-broadcast');
  assert.equal((await f.service.abandon(f.payee,i.id,{})).intent.status,'abandoned');assert.equal(f.store.read().nativePaymentRequestLocks[U],undefined);assert.equal(f.sends,0);
});
test('duplicate submit or recover of the same envelope after expiry never re-broadcasts',async()=>{
  const f=fixture(),count=refuse(f),req=await invoice(f),i=await f.agree(await f.prepare(req)),submission=f.submission(i);
  await f.service.submit(f.payer,i.id,submission);f.state.height='181';await f.service.reconcile(f.payer,i.id,{});f.restart();
  await rejects(f.service.submit(f.payer,i.id,submission),'payment_intent_expired_unused');await rejects(f.service.recover(f.payer,i.id,submission),'payment_intent_expired_unused');
  await f.service.abandon(f.payer,i.id,{});await rejects(f.service.submit(f.payer,i.id,submission),'payment_intent_abandoned');
  assert.equal((await f.service.receipt(f.payer,i.id,{})).intent.status,'abandoned');assert.equal(count(),1);
});
test('a request past seven days cannot be paid, reads as expired and can be cancelled; in-flight sends are unaffected',async()=>{
  const f=fixture(),old=new Date(Date.now()-PAYMENT_REQUEST_EXPIRY_MS-1000).toISOString(),id='00000000-0000-4000-8000-000000000002';
  await f.store.transact(s=>{s.history=[];s.requests[id]={id,from:f.payee.address,to:f.payer.address,amount:'26',memo:'invoice',status:'open',currency:'AI$',createdAt:old,expiresAt:new Date(Date.parse(old)+PAYMENT_REQUEST_EXPIRY_MS).toISOString(),updatedAt:'version-1'};});
  await rejects(f.prepare({requestId:id,requestVersion:'version-1'}),'payment_request_expired');assert.equal(f.store.read().nativePaymentRequestLocks?.[id],undefined);
  const route=routes(f);await assert.rejects(route(f.payer,'POST',`/api/requests/${id}/pay`,{}),e=>e.code==='payment_request_expired'&&e.status===409);
  const listed=(await route(f.payer,'GET','/api/requests')).body.requests[0];assert.equal(listed.status,'expired');assert.equal(Date.parse(listed.expiresAt),Date.parse(old)+PAYMENT_REQUEST_EXPIRY_MS);
  assert.equal((await route(f.payer,'GET','/api/requests?status=expired')).body.count,1);assert.equal((await route(f.payer,'GET','/api/requests?status=open')).body.count,0);
  assert.equal((await route(f.payee,'POST',`/api/requests/${id}/cancel`)).body.request.status,'cancelled');
  // An intent sent before expiry keeps its recovery and receipt paths.
  const g=fixture(),req=await invoice(g,{expiresAt:new Date(Date.now()+60000).toISOString()}),i=await g.agree(await g.prepare(req));await g.service.submit(g.payer,i.id,g.submission(i));
  await g.store.transact(s=>{s.requests[U].expiresAt=old;});g.finalize(g.service.get(g.payer,i.id).intent);
  assert.equal((await routes(g)(g.payer,'GET','/api/requests')).body.requests[0].status,'expired');const recorded=(await g.service.receipt(g.payee,i.id,{})).intent;assert.equal(recorded.status,'ledger-recorded');
  assert.equal((await g.service.confirm(g.payee,i.id,g.confirmation(recorded))).intent.status,'recipient-confirmed-paid');assert.equal(g.store.read().requests[U].status,'paid');
  assert.equal(g.store.read().history.at(-1).type,'request.paid');
});
test('old request rows without expiresAt still load and pay; rows without createdAt load with no expiry',async()=>{
  const f=fixture(),route=routes(f);
  await f.store.transact(s=>{s.history=[];s.requests.A={id:'A',from:f.payee.address,to:f.payer.address,amount:'26',memo:'old',status:'open',currency:'AI$',updatedAt:'v'};s.requests.B={id:'B',from:f.payee.address,to:f.payer.address,amount:'26',memo:'old',status:'open',currency:'AI$',createdAt:new Date().toISOString(),updatedAt:'v'};});
  const rows=(await route(f.payer,'GET','/api/requests')).body.requests;assert.equal(rows.length,2);
  const a=rows.find(r=>r.id==='A'),b=rows.find(r=>r.id==='B');assert.equal(a.expiresAt,null);assert.equal(a.status,'open');assert.equal(b.status,'open');assert.ok(Date.parse(b.expiresAt)>Date.now());
  assert.equal((await f.prepare({clientRequestId:'old-row-request-b',requestId:'B',requestVersion:'v'})).requestId,'B');
  assert.equal(f.store.read().requests.B.expiresAt,undefined);
});
test('new payment requests carry a seven-day expiresAt and a history entry',async()=>{
  const f=fixture(),route=routes(f);f.store.transactRequestCreate=f.store.transact;await f.store.transact(s=>{s.history=[];});
  const r=(await route(f.payee,'POST','/api/requests',{to:f.payer.address,amount:'1',memo:'x',clientRequestId:'expiry-request-01'})).body.request;
  assert.equal(Date.parse(r.expiresAt)-Date.parse(r.createdAt),PAYMENT_REQUEST_EXPIRY_MS);assert.equal(f.store.read().history[0].type,'request.created');
});
test('a Trade payment request carries a seven-day expiresAt and a request.created history entry',async()=>{
  const {createTradePaymentService}=await import('../server/trade-payment.mjs');
  const f=fixture(),{row}=await tradeRequest(f);await f.store.transact(s=>{delete s.requests.R;s.history=[];});
  const trade=createTradeService({store:f.store}),payments=createTradePaymentService({store:f.store,trade});
  const {request}=await payments.create(f.payee,row.trade.proposal.id,{clientRequestId:'trade-expiry-request',snapshotDigest:row.trade.snapshotDigest,confirmPaymentRequest:true});
  assert.equal(Date.parse(request.expiresAt)-Date.parse(request.createdAt),PAYMENT_REQUEST_EXPIRY_MS);
  assert.deepEqual(f.store.read().history.map(h=>[h.type,h.requestId,h.actor]),[['request.created',request.id,f.payee.address]]);
});

test('legacy requests without a stored expiry stay payable until the grace date',async()=>{
  const {LEGACY_REQUEST_GRACE_UNTIL,paymentRequestExpired,paymentRequestExpiresAt}=await import('../server/native-payments.mjs');
  const legacy={status:'open',createdAt:'2026-11-01T00:00:00.000Z'};
  assert.equal(Date.parse(paymentRequestExpiresAt(legacy)),LEGACY_REQUEST_GRACE_UNTIL);
  assert.equal(paymentRequestExpired(legacy,LEGACY_REQUEST_GRACE_UNTIL-1),false);
  assert.equal(paymentRequestExpired(legacy,LEGACY_REQUEST_GRACE_UNTIL),true);
  const late={status:'open',createdAt:'2026-11-20T00:00:00.000Z'};
  assert.equal(paymentRequestExpiresAt(late),'2026-11-27T00:00:00.000Z');
});
test('/api/requests projects the payment lock and stage, so clients need not join /api/native/payments',async()=>{
  const f=fixture();refuse(f);const route=routes(f),{i}=await refusedSend(f);
  const row=async user=>(await route(user,'GET','/api/requests')).body.requests.find(r=>r.id===U);
  for(const user of [f.payer,f.payee]){const r=await row(user);assert.equal(r.status,'open');assert.deepEqual({locked:r.payment.locked,source:r.payment.source,id:r.payment.id,stage:r.payment.stage},{locked:true,source:'wallet',id:i.id,stage:'refused'});}
  // A browser send that is newer wins; a closed one stops locking.
  await f.store.transact(s=>{s.serverSendIntents={'send-1':{id:'send-1',status:'awaiting-signature',updatedAt:'2999-01-01T00:00:00.000Z'}};s.serverSendRequestLocks={[U]:'send-1'};});
  assert.deepEqual((({source,stage})=>({source,stage}))((await row(f.payer)).payment),{source:'send',stage:'awaiting-signature'});
  await f.store.transact(s=>{s.serverSendIntents['send-1'].status='cancelled';s.nativePaymentIntents[i.id].status='expired-unused';});
  assert.equal((await row(f.payer)).payment,null);
  assert.equal(requestPaymentLock({},{id:U,status:'declined'}),null);
});

test('a request a no-install send already paid refuses the wallet path, even without the lock (security review, 10 Nov)',async()=>{
  const f=fixture(),trade=await tradeRequest(f);
  // The send landed (finalized) but its lock was dropped, for example by a confirm that came after the request expired.
  await f.store.transact(s=>{s.serverSendIntents={paid:{id:'paid',status:'finalized',intent:{requestId:'R',from:f.payer.address,to:f.payee.address}}};});
  await assert.rejects(f.prepare(trade.body),e=>e.code==='payment_request_paid'&&/do not pay it again/.test(e.message));
  assert.equal(Object.keys(f.store.read().nativePaymentIntents??{}).length,0);
});

// One shared "may this request already be paid?" answer for every payment guard (request-payment-guard.mjs).
import { withRequestGuard } from '../server/native-payments-guard.mjs';
import { NativePaymentError } from '../server/native-payments.mjs';
test('a request paid on the ledger cannot be closed, even when a later refused attempt took its lock over (shared guard, 10 Nov)',async()=>{
  const f=fixture(),route=routes(f);await invoice(f);
  await f.store.transact(s=>{s.serverSendIntents={paid:{id:'paid',status:'finalized',recipientConfirmation:null,intent:{requestId:U,from:f.payer.address,to:f.payee.address}},stray:{id:'stray',status:'checker-refused',intent:{requestId:U,from:f.payer.address,to:f.payee.address}}};s.serverSendRequestLocks={[U]:'stray'};});
  await assert.rejects(route(f.payee,'POST',`/api/requests/${U}/cancel`),e=>e.code==='payment_request_paid'&&/already paid/.test(e.message));
  await assert.rejects(route(f.payer,'POST',`/api/requests/${U}/decline`),e=>e.code==='payment_request_paid');
  assert.equal(f.store.read().requests[U].status,'open');
});
test('the wallet path refuses a request another payment has paid or may still pay, whatever the lock maps say (shared guard, 10 Nov)',async()=>{
  // BAINK composes the wallet service with the shared guard in front of prepare (native-payments-guard.mjs);
  // native-payments.mjs itself is pinned into the custody and review-broker releases and gains no import.
  const f=fixture(),req=await invoice(f),guarded=withRequestGuard(f.service,f.store),prepare=(over={})=>guarded.prepare(f.payer,{...f.body,...req,...over});
  // A wallet payment recorded on the ledger whose lock is gone.
  await f.store.transact(s=>{s.nativePaymentIntents={w:{id:'w',requestId:U,payer:f.payer.address,payee:f.payee.address,clientRequestId:'other-client-request',status:'ledger-recorded',createdAt:new Date().toISOString()}};});
  await assert.rejects(prepare(),e=>e instanceof NativePaymentError&&e.code==='payment_request_paid'&&/do not pay it again/.test(e.message));
  // A relayed no-install send that does not hold the lock.
  await f.store.transact(s=>{s.nativePaymentIntents={};s.serverSendIntents={live:{id:'live',status:'submitted',intent:{requestId:U,from:f.payer.address,to:f.payee.address},attempts:[{n:1,status:'submitted',envelope:{},sendAttemptedAt:new Date().toISOString()}]}};});
  await rejects(prepare(),'payment_request_locked');
  // Proved dead: the request is payable again, and the same prepare repeated returns the same intent.
  await f.store.transact(s=>{s.serverSendIntents.live.status='expired';});
  const made=await prepare();assert.equal(made.created,true);assert.equal(made.intent.requestId,U);
  const again=await prepare();assert.equal(again.created,false);assert.equal(again.intent.id,made.intent.id);
  await rejects(prepare({clientRequestId:'a-second-payment-01'}),'payment_request_locked');
  assert.equal(guarded.enabled,f.service.enabled);
});

// P0-4 (12 November 2026): while Trade is paused a payment for terms with no signed deal does not
// start; a deal payment and an ordinary invoice start as before; open Trade changes nothing.
test('paused Trade refuses to start a terms payment, and only that',async()=>{
  const paused=createTradeAvailability({mode:'paused'});
  const f=fixture({tradeAvailability:paused}),trade=await tradeRequest(f);
  await rejects(f.prepare(trade.body),'trade_paused');
  await rejects(f.prepare(trade.body),'trade_paused');
  assert.equal(Object.keys(f.store.read().nativePaymentIntents??{}).length,0,'a refused start, retried, creates nothing');
  assert.equal(f.store.read().nativePaymentRequestLocks?.R,undefined);
  // The same request as a signed deal's payment starts.
  await f.store.transact(s=>{s.requests.R.trade={...s.requests.R.trade,schema:'baink-trade-deal-payment-v1',dealId:'00000000-0000-4000-8000-0000000000d1',dealDigest:'d'.repeat(64)};});
  const intent=await f.prepare(trade.body);
  assert.equal(intent.tradeDigest,trade.snapshotDigest);
  // An ordinary payment with no Trade link is untouched.
  const g=fixture({tradeAvailability:paused});
  const plain=await g.prepare();
  assert.equal(plain.tradeDigest,undefined);
  // Open Trade: the terms payment starts as it always did.
  const h=fixture({tradeAvailability:createTradeAvailability({mode:'open'})}),other=await tradeRequest(h);
  assert.equal((await h.prepare(other.body)).tradeDigest,other.snapshotDigest);
});
