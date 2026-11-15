import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { coinBoundaryApprovalBytes, coinBoundaryPurposeCommitment, signCoinBoundaryApproval } from './coin-boundary.mjs';
import { privatePartyConsent, reviewCertificate, encryptPrivateReview, decryptPrivateReview } from './private-review.mjs';
import { signBoundaryFromPrivateState } from './private-state.mjs';
const raw = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({ format:'der', type:'spki' })).subarray(-32);
const owner = generateKeyPairSync('ed25519'), reviewer = generateKeyPairSync('ed25519');
const member = 'uain1' + createHash('sha256').update(raw(owner.publicKey)).digest('hex').slice(0,40);
const agreement = { text:'Fictional neutral Coin withdrawal for an agreed compute service.', salt:'31'.repeat(32) };
const boundary = { direction:'shield', member, amount:'9007199254740993' };
const context = { version:1, chain:'fixture-coin-1', expires:'400', licenceRevision:'0', effects:'32'.repeat(32), reviewer:raw(reviewer.publicKey).toString('hex'), purpose:coinBoundaryPurposeCommitment(agreement,boundary) };
const address = '33'.repeat(43);
const consent = privatePartyConsent(context,address,owner.privateKey);
const review = { context,boundary,agreement,reviewerSigningKey:reviewer.privateKey, licensedOwnerKey:owner.publicKey,consents:[consent],outputs:[{address,amount:boundary.amount},{address,amount:'0'}],valueBalance:'-9007199254740993',decision:{class:'neutral',checkedPurpose:context.purpose,ownerLicenceChecked:true,statement:'The fixture checker confirmed the neutral purpose and current owner licence.'} };
test('boundary approvals and encrypted review bind lossless amount, owner, direction and agreement',()=>{
 const approval=signCoinBoundaryApproval(review);
 assert.ok(verify(null,coinBoundaryApprovalBytes(context,boundary,'neutral'),reviewer.publicKey,Buffer.from(approval.signature,'base64url')));
 for (const changed of [{...boundary,amount:'1'},{...boundary,direction:'exit'},{...boundary,member:'uain1'+'34'.repeat(20)}]) {
  assert.notEqual(coinBoundaryPurposeCommitment(agreement,changed),context.purpose);
  assert.ok(!verify(null,coinBoundaryApprovalBytes(context,changed,'neutral'),reviewer.publicKey,Buffer.from(approval.signature,'base64url')));
 }
 assert.notEqual(coinBoundaryPurposeCommitment({...agreement,text:agreement.text+' changed'},boundary),context.purpose);
 const encryption=generateKeyPairSync('x25519');const certificate=reviewCertificate(context,encryption.publicKey,reviewer.privateKey);
 const envelope=encryptPrivateReview({certificate,trustedReviewerPublicKey:reviewer.publicKey,currentHeight:1,chain:context.chain,packet:{agreement,boundary}});
 assert.ok(!JSON.stringify(envelope).includes(agreement.text));
 const mutated=structuredClone(envelope);mutated.certificate.context.purpose=coinBoundaryPurposeCommitment(agreement,{...boundary,amount:'1'});
 assert.throws(()=>decryptPrivateReview({envelope:mutated,reviewerEncryptionKey:encryption.privateKey,trustedReviewerPublicKey:reviewer.publicKey,currentHeight:1,chain:context.chain}),/certificate/);
});
test('checker rejects changed debits, third-party notes, missing licence consent and unverified snapshots',()=>{
 for (const amount of [1,0,'01','0','-1','9223372036854775808','1e3']) assert.throws(()=>coinBoundaryApprovalBytes(context,{...boundary,amount},'neutral'));
 assert.throws(()=>signCoinBoundaryApproval({...review,valueBalance:'0'}),/value balance/);
 assert.throws(()=>signCoinBoundaryApproval({...review,outputs:[{address:'44'.repeat(43),amount:boundary.amount},{address,amount:'0'}]}),/owner consent/);
 assert.throws(()=>signCoinBoundaryApproval({...review,outputs:[{address,amount:'1'},{address,amount:'0'}]}),/debited amount/);
 assert.throws(()=>signCoinBoundaryApproval({...review,consents:[]}),/owned outputs/);
 assert.throws(()=>signCoinBoundaryApproval({...review,agreement:{...agreement,text:'Changed private terms'}}),/purpose/);
 assert.throws(()=>signBoundaryFromPrivateState({state:{coin:{policy:'verified-bounties-108t-micro-v1',owner:{member}}},context,boundary}),/pinned finalized/);
});
