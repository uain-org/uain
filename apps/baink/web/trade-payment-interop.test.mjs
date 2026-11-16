import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeProposalDigest,tradePaymentMemo as serverMemo,validateTradePaymentRequest} from '../server/trade-payment.mjs';
import { tradeSnapshotDigest, tradePaymentMemo, verifyTradeRequest } from './trade-request-review.js';
const seller='uain1'+'1'.repeat(40),buyer='uain1'+'2'.repeat(40);
function proposal(scope){return {id:'00000000-0000-4000-8000-000000000001',author:seller,enquiryId:'enquiry',kind:'nonbinding-terms-proposal',binding:false,nonbinding:true,settlementAvailable:false,acceptanceAvailable:false,enquirySnapshot:{id:'enquiry',kind:'nonbinding-enquiry',binding:false,seller,buyer},terms:{scope,price:'26.000000',priceUnits:'26000000',currency:'AI$',deliverables:'Literal <>&\u2028 and 😀'}};}
for(const scope of ['Short <>&\u2028 😀','😀'.repeat(120),'😀'.repeat(121),'A'+'😀'.repeat(130)])test(`browser/server exact digest, memo and request at ${Array.from(scope).length} Unicode codepoints`,async()=>{const p=proposal(scope),digest=tradeProposalDigest(p);assert.equal(await tradeSnapshotDigest(p),digest);assert.equal(tradePaymentMemo(p,digest),serverMemo(p,digest));const request={from:seller,to:buyer,amount:'26.000000',currency:'AI$',memo:serverMemo(p,digest),trade:{schema:'baink-trade-payment-v1',snapshotDigest:digest,proposal:p}};assert.equal(validateTradePaymentRequest(request).tradeDigest,digest);assert.equal(await verifyTradeRequest(request),digest);
for(const mutate of [r=>r.trade.proposal.terms.deliverables='Changed full terms',r=>r.amount='25.000000',r=>r.to=seller,r=>r.memo='Changed purpose']){const bad=structuredClone(request);mutate(bad);await assert.rejects(verifyTradeRequest(bad));}});

test('buyer-authored proposal bound to a signed deal can be reviewed', async () => {
  const { generateKeyPairSync, createHash, sign } = await import('node:crypto');
  const { canonical } = await import('./trade-deals-view.js');
  const keys = {};
  const parties = {};
  for (const role of ['buyer', 'seller']) {
    keys[role] = generateKeyPairSync('ed25519');
    const raw = keys[role].publicKey.export({format:'der',type:'spki'}).subarray(-32);
    parties[role] = 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0,40);
  }
  const p = proposal('Citation check');
  Object.assign(p.enquirySnapshot, parties);
  p.author = parties.buyer;
  const dealId = '12345678-0000-4000-8000-000000000001';
  const snapshotDigest = tradeProposalDigest(p);
  const digestInput = {schema:'baink-trade-deal-v1',dealId,proposalId:p.id,proposalDigest:snapshotDigest,
    ...parties,terms:p.terms,fee:{amountUnits:'0',currency:'AI$'}};
  const dealDigest = tradeProposalDigest(digestInput);
  const r = {id:'req1',clientRequestId:'deal-'+dealId,from:parties.seller,to:parties.buyer,
    currency:'AI$',amount:p.terms.price,status:'open',expiresAt:'2099-01-01T00:00:00Z',
    memo:serverMemo(p,snapshotDigest),trade:{schema:'baink-trade-deal-payment-v1',dealId,dealDigest,snapshotDigest,proposal:p}};
  const deal = {id:dealId,dealDigest,status:'agreed',digestInput,payment:{request:{...r},next:{action:'pay',actor:'buyer',requestId:r.id}},acceptances:{}};
  for (const role of ['buyer','seller']) {
    const envelope = {audience:'https://baink.money',method:'POST',path:'/api/trade/deals/'+dealId+'/accept',
      body:{dealDigest,confirmBinding:true},nonce:role,timestamp:'1'};
    deal.acceptances[role] = {...envelope,address:parties[role],role,
      publicKey:keys[role].publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),
      signature:sign(null,Buffer.from(canonical(envelope)),keys[role].privateKey).toString('base64')};
  }
  assert.equal(await verifyTradeRequest(r,deal),snapshotDigest);
  for(const change of [d=>d.acceptances.buyer.signature=d.acceptances.seller.signature,
    d=>d.payment.request.id='different',d=>d.digestInput.fee.amountUnits='1',d=>d.payment.next.action='settling']) {
    const changed=structuredClone(deal); change(changed);
    await assert.rejects(verifyTradeRequest(r,changed));
  }
  await assert.rejects(verifyTradeRequest(r));
});
