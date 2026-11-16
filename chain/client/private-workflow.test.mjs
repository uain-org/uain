import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privatePurposeCommitment, privatePartyConsent, signPrivateApproval } from './private-review.mjs';
import { coinBoundaryPurposeCommitment, signCoinBoundaryApproval } from './coin-boundary.mjs';
import { verifyPrivateTradeApproval, verifyPrivateExecutable, producePrivateTrade } from './private-workflow.mjs';
import { memberAddress } from './signing.mjs';
const raw = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({type:'spki',format:'der'})).subarray(-32);
const reviewer=generateKeyPairSync('ed25519'), sender=generateKeyPairSync('ed25519'), recipient=generateKeyPairSync('ed25519'), relay=generateKeyPairSync('ed25519');
const agreement={text:'Fictional neutral compute trade.',salt:'61'.repeat(32)};
const base={version:1,chain:'uain-fixture-workflow',expires:'100',licenceRevision:'0',effects:'62'.repeat(32),reviewer:raw(reviewer.publicKey).toString('hex')};
test('workflow verifies existing native OTC approval frame and rejects altered contexts and payload extensions',()=>{
 const context={...base,purpose:privatePurposeCommitment(agreement)}, a='63'.repeat(43), b='64'.repeat(43);
 const approval=signPrivateApproval({context,reviewerSigningKey:reviewer.privateKey,trustedRelayerKey:relay.publicKey,licensedSenderKey:sender.publicKey,licensedRecipientKey:recipient.publicKey,sender:privatePartyConsent(context,a,sender.privateKey),recipient:privatePartyConsent(context,b,recipient.privateKey),amount:'26',outputs:[{address:a,amount:'44'},{address:b,amount:'26'}],decision:{class:'neutral',checkedPurpose:context.purpose,bothLicencesChecked:true,statement:'The fixture checker verified licensed parties and the fictional purpose.'}});
 const args={approval,context,reviewerPublicKey:reviewer.publicKey};
 assert.equal(verifyPrivateTradeApproval(args),approval);
 for (const changed of [{...context,chain:context.chain+'x'},{...context,effects:'65'.repeat(32)},{...context,purpose:'66'.repeat(32)},{...context,expires:'101'},{...context,licenceRevision:'1'}]) assert.throws(()=>verifyPrivateTradeApproval({...args,context:changed}));
 for (const changed of [{...approval,class:'malevolent'},{...approval,signature:approval.signature+'='},{...approval,terms:agreement.text}]) assert.throws(()=>verifyPrivateTradeApproval({...args,approval:changed}));
 assert.throws(()=>verifyPrivateTradeApproval({...args,reviewerPublicKey:relay.publicKey}));
});
test('workflow binds Coin owner, amount and direction including lossless int64 amounts',()=>{
 const boundary={direction:'shield',member:memberAddress(raw(sender.publicKey)),amount:'9007199254740993'}, context={...base,purpose:coinBoundaryPurposeCommitment(agreement,boundary)}, address='67'.repeat(43);
 const approval=signCoinBoundaryApproval({context,boundary,agreement,reviewerSigningKey:reviewer.privateKey,licensedOwnerKey:sender.publicKey,consents:[privatePartyConsent(context,address,sender.privateKey)],outputs:[{address,amount:boundary.amount},{address,amount:'0'}],valueBalance:'-'+boundary.amount,decision:{class:'neutral',checkedPurpose:context.purpose,ownerLicenceChecked:true,statement:'The fixture checker verified current owner and the fictional purpose.'}});
 const args={approval,context,boundary,reviewerPublicKey:reviewer.publicKey};assert.equal(verifyPrivateTradeApproval(args),approval);
 for (const changed of [{...boundary,amount:'1'},{...boundary,member:memberAddress(raw(recipient.publicKey))},{...boundary,direction:'exit'}]) assert.throws(()=>verifyPrivateTradeApproval({...args,boundary:changed}));
 assert.throws(()=>verifyPrivateTradeApproval({...args,boundary:null}));
});
test('workflow refuses unpinned tools and missing explicit review before reading chain state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'uain-workflow-test-'));
 try {const executable=join(directory,'tool');await writeFile(executable,'fictional public executable');const executableSha256=createHash('sha256').update('fictional public executable').digest('hex');assert.equal(await verifyPrivateExecutable({executable,executableSha256}),executable);await assert.rejects(verifyPrivateExecutable({executable,executableSha256:'00'.repeat(32)}),/independent pin/);await assert.rejects(verifyPrivateExecutable({executable,executableSha256:'invalid'}),/pin/);await assert.rejects(producePrivateTrade({operation:'coin_shield',amount:'1'}),/providers/);await assert.rejects(producePrivateTrade({operation:'private_payment',amount:'01'}),/amount/);} finally {await rm(directory,{recursive:true,force:true});}
});
