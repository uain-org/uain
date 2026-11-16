// Disposable acceptance helper only: caller-created fictional identities/keys.
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportWalletBackup, restoreWalletBackup } from '../client/wallet-backup.mjs';
import { lightScan, ownedNotes } from '../client/note-scan.mjs';
import { readPrivateState } from '../client/private-state.mjs';
import { coinBoundaryPurposeCommitment } from '../client/coin-boundary.mjs';
import { privatePurposeCommitment, privatePartyConsent } from '../client/private-review.mjs';
import { verifyPrivateTradeEnvelope } from '../client/private-workflow.mjs';
import { fixturePrivateAction as runPrivateAction } from './private-client-process.mjs';
const raw = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' })).subarray(-32).toString('hex');
export async function exerciseCoinWalletFlow({ root, reader, coinWallet, privateWallet, sender, recipient, reviewer, relay, submit, readRecord }) {
  const tools = {};
  for (const [name, executable] of [['coinWallet', coinWallet], ['privateWallet', privateWallet]]) tools[name] = { executable, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex') };
  const keys = new Map();
  for (const [name, actor] of [['sender', sender], ['recipient', recipient]]) {
    // The recipient key lives in a holder-layout wallet directory so the
    // encrypted backup/restore stage below can recover it into a clean profile.
    const file = name === 'recipient' ? join(root, 'fictional-recipient-wallet', 'orchard-key.json') : join(root, `fictional-${name}-orchard-key`);
    if (name === 'recipient') await mkdir(dirname(file), { mode: 0o700 });
    const result = await runPrivateAction('keygen', { tool: tools.coinWallet, file });
    assert.equal((await stat(file)).mode & 0o777,0o600);
    keys.set(actor.member.id,{file,address:result.address});
  }
  const read = request => readPrivateState({...reader,request});
  const identities=new Map();
  for(const actor of [sender,recipient,reviewer,relay]) {
    const file=join(root,actor.member.id+'-fictional-identity.json'),jwk=actor.privateKey.export({format:'jwk'});
    await writeFile(file,JSON.stringify({algorithm:'Ed25519',public_key:jwk.x,private_key:jwk.d,address:actor.member.id}),{mode:0o600,flag:'wx'});identities.set(actor.member.id,file);
  }
  const encryptionKeyFile=join(root,'fictional-checker-encryption.json');
  await runPrivateAction('encryption-keygen', { file: encryptionKeyFile });
  async function waitFile(file) { for(let i=0;i<1800;i++){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(r=>setTimeout(r,100));}throw new Error('fictional courier deadline'); }
  const caches=new Map();
  async function walletProof({ operation, intent, state, actor, boundary, agreement, amount, recipientAddress }) {
    const request = boundary ? { reviewer: reviewer.member.id, boundary_member: boundary.member, parties: [] } : { reviewer: reviewer.member.id, parties: [sender.member.id, recipient.member.id] };
    for (const [field, entries] of [['source_payments', state.payments], ['source_boundaries', state.boundaries]]) if (entries.length) request[field] = entries.map(entry => entry.id);
    const proven = [...state.payments.map(p => ({...p, kind:'payment'})), ...state.boundaries.map(p => ({...p, kind:'boundary'}))].find(p => Buffer.from(p.bundle,'base64url').toString('hex') === intent.source_bundle);
    const exchangeDirectory=join(root,operation+'-fictional-courier'),out=join(root,operation+'-fictional-result.json');
    const cacheOut=join(root,operation+'-fictional-witness-cache.json');
    const trade=runPrivateAction('trade',{witnessCacheFile:caches.get(actor.member.id),witnessCacheOut:cacheOut,reader:{...reader,request},tools,operation:operation==='pay'?'private_payment':'coin_'+operation,amount:boundary?.amount??amount,spendingKeyFile:intent.key_file,recipientAddress,source:proven?{kind:proven.kind,id:proven.id,position:intent.source_position}:undefined,agreement,memo:intent.memo,exchangeDirectory,out,signingKeyFile:identities.get(actor.member.id)});
    const courier=(async()=>{
      if(!boundary){const request=await waitFile(join(exchangeDirectory,'consent-request.json'));await runPrivateAction('consent',{...request,signingKeyFile:identities.get(recipient.member.id),out:join(exchangeDirectory,'recipient-consent.json')});}
      const {context}=await waitFile(join(exchangeDirectory,'certificate-request.json'));
      await runPrivateAction('certificate',{reader,context,signingKeyFile:identities.get(reviewer.member.id),encryptionKeyFile,out:join(exchangeDirectory,'certificate.json')});
      const envelope=await waitFile(join(exchangeDirectory,'review-envelope.json'));
      assert.ok(!JSON.stringify(envelope).includes(agreement.text));assert.ok(!JSON.stringify(envelope).includes('one_time_viewing_key'));
      const decisionFile=join(exchangeDirectory,'decision.json'),inspectionOut=join(exchangeDirectory,'inspection.json');
      const review=runPrivateAction('review',{reader,tools,envelopeFile:join(exchangeDirectory,'review-envelope.json'),signingKeyFile:identities.get(reviewer.member.id),encryptionKeyFile,decisionFile,inspectionOut,out:join(exchangeDirectory,'review-approval.json')});
      const inspection=await waitFile(inspectionOut);assert.deepEqual(inspection.agreement,agreement);assert.equal(inspection.amount,boundary?.amount??amount);
      const decision=JSON.stringify({class:'neutral',checkedPurpose:inspection.context.purpose,ownerLicenceChecked:true,bothLicencesChecked:true,statement:'The fixture checker verified current licences, recovered outputs, consents and the neutral fictional agreement.'});
      await writeFile(decisionFile,'{',{mode:0o600,flag:'wx'});await new Promise(resolve=>setTimeout(resolve,300));await writeFile(decisionFile,decision,{mode:0o600});await review;
    })();
    await Promise.all([trade,courier]);const result=JSON.parse(await readFile(out,'utf8'));
    caches.set(actor.member.id,cacheOut);assert.equal(result.local_receipt.witness_cache.root,state.root);assert.equal(result.local_receipt.witness_cache.count,state.count);
    const envelopeFile=join(root,operation+'-fictional-envelope.json');
    await runPrivateAction('sign',{reader,resultFile:out,signingKeyFile:identities.get(boundary?actor.member.id:relay.member.id),out:envelopeFile});
    const signed=JSON.parse(await readFile(envelopeFile,'utf8'));await verifyPrivateTradeEnvelope({reader,envelope:signed});
    assert.equal(signed.command.member,boundary?actor.member.id:relay.member.id);assert.deepEqual(signed.command.payload,result.payload);
    assert.ok(!JSON.stringify(signed).includes(agreement.text));assert.ok(!JSON.stringify(signed).includes('local_receipt'));
    return {...result.payload,inspection:{outputs:result.local_receipt.outputs},wire:Buffer.from(result.payload.bundle,'base64url'),signed,envelopeFile};
  }
  const sources={reviewer:reviewer.member.id};
  console.log('FIXTURE_STAGE earned-Coin entry');
  const entryState=await read({...sources,boundary_member:sender.member.id,parties:[]});assert.equal(entryState.coin.balance,'5000000');assert.equal(entryState.coin.supply.shielded,'0');
  const entryBoundary={direction:'shield',member:sender.member.id,amount:'70'};
  const entryAgreement={text:'Fictional neutral entry of earned Coin for a private compute trade.',salt:'61'.repeat(32)};
  const entry=await walletProof({executable:coinWallet,operation:'shield',state:entryState,actor:sender,boundary:entryBoundary,agreement:entryAgreement,intent:{chain_id:entryState.chain_id,expires_height:String(BigInt(entryState.height)+300n),licence_revision:entryState.licence_revision,key_file:keys.get(sender.member.id).file,commitments:entryState.commitments,expected_root:entryState.root,member:sender.member.id,amount:'70',purpose_commitment:coinBoundaryPurposeCommitment(entryAgreement,entryBoundary),reviewer_public_key:raw(reviewer.publicKey),memo:'fictional entry',review_file:join(root,'fictional-entry-review.json')}});
  assert.equal(entry.wire.readBigInt64LE(5),-70n);
  await submit('coin_shield',{bundle:entry.bundle,approval:{...entry.approval,amount:'71'}},sender,false);
  await submit('coin_shield',{bundle:entry.bundle,approval:entry.approval},recipient,false);
  await submit('coin_shield',{bundle:entry.bundle,approval:entry.approval},sender,true,entry.signed);
  await submit('coin_shield',{bundle:entry.bundle,approval:entry.approval},sender,false);
  console.log('FIXTURE_STAGE private OTC payment');
  const paymentState=await read({...sources,parties:[sender.member.id,recipient.member.id],source_boundaries:[entry.approval.effects]});
  assert.equal(paymentState.coin.supply.shielded,'70');assert.equal(paymentState.boundaries[0].bundle,entry.bundle);
  const entryPosition=entry.inspection.outputs.find(output=>output.amount==='70').position;
  const paymentAgreement={text:'Fictional neutral private compute service for twenty-six micro Coin.',salt:'62'.repeat(32)};
  const payment=await walletProof({executable:privateWallet,operation:'pay',state:paymentState,actor:sender,agreement:paymentAgreement,amount:'26',recipientAddress:keys.get(recipient.member.id).address,intent:{chain_id:paymentState.chain_id,expires_height:String(BigInt(paymentState.height)+300n),licence_revision:paymentState.licence_revision,key_file:keys.get(sender.member.id).file,commitments:paymentState.commitments,expected_root:paymentState.root,source_bundle:Buffer.from(paymentState.boundaries[0].bundle,'base64url').toString('hex'),source_position:Number(entryState.count)+entryPosition,recipient:keys.get(recipient.member.id).address,amount:'26',purpose_commitment:privatePurposeCommitment(paymentAgreement),reviewer_public_key:raw(reviewer.publicKey),memo:'fictional compute service',review_file:join(root,'fictional-otc-review.json')}});
  assert.equal(payment.wire.readBigInt64LE(5),0n);assert.ok(!payment.wire.toString('hex').includes(keys.get(recipient.member.id).address));
  await submit('private_payment',{bundle:payment.bundle,approval:payment.approval},relay,true,payment.signed);
  await submit('private_payment',{bundle:payment.bundle,approval:payment.approval},relay,false);
  console.log('FIXTURE_STAGE encrypted wallet backup and clean-profile restore');
  {
    const original = keys.get(recipient.member.id), walletDirectory = dirname(original.file), backup = join(root, 'fictional-recipient-wallet-backup.json'), passphrase = 'fictional devnet restore passphrase';
    const kdf = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1 };
    await exportWalletBackup({ walletDirectory, passphrase, out: backup, kdf });
    const restoredDirectory = join(root, 'fictional-recipient-restored'), started = Date.now();
    await assert.rejects(restoreWalletBackup({ file: backup, passphrase: 'a wrong fictional passphrase', walletDirectory: restoredDirectory }), error => error.code === 'WALLET_BACKUP_WRONG_PASSPHRASE');
    await assert.rejects(restoreWalletBackup({ file: backup, passphrase, walletDirectory }), error => error.code === 'WALLET_RESTORE_WOULD_OVERWRITE');
    const restored = await restoreWalletBackup({ file: backup, passphrase, walletDirectory: restoredDirectory });
    assert.equal(restored.restored, true);
    const restoredKey = join(restoredDirectory, 'orchard-key.json'), addressTool = join(dirname(coinWallet), 'uain-wallet-addresses'), noteTool = join(dirname(coinWallet), 'uain-note-source');
    const derived = JSON.parse(spawnSync(addressTool, [restoredKey], { encoding: 'utf8', timeout: 10000 }).stdout);
    assert.equal(derived.external, original.address, 'the restored key derives the original receiving address');
    // Rescan the chain with only the restored key: no courier journals exist in this profile.
    const scan = await lightScan(reader);
    const found = await ownedNotes({ scan, noteTool: { executable: noteTool, executableSha256: createHash('sha256').update(await readFile(noteTool)).digest('hex') }, spendingKeyFile: restoredKey });
    const note = found.notes.find(n => n.kind === 'payment' && n.id === payment.approval.effects && n.amountUnits === '26' && !n.spent);
    assert.ok(note, 'the chain rescan finds the received 26-unit note with the restored key alone');
    // Spend from the restored profile: the original key file is set aside.
    await rename(original.file, original.file + '.set-aside-by-restore-test');
    keys.set(recipient.member.id, { file: restoredKey, address: derived.external });
    console.log('WALLET_RESTORE_VERIFIED ' + JSON.stringify({ address: derived.external === original.address, rescanHeight: found.height, ownedNotes: found.notes.length, balanceUnits: found.balanceUnits, restoreAndRescanMs: Date.now() - started }));
  }
  console.log('FIXTURE_STAGE Coin withdrawal');
  const exitState=await read({...sources,parties:[],boundary_member:recipient.member.id,source_payments:[payment.approval.effects]});
  assert.equal(exitState.coin.balance,'0');assert.equal(exitState.coin.supply.shielded,'70');
  const exitBoundary={direction:'exit',member:recipient.member.id,amount:'26'};
  const exitAgreement={text:'Fictional neutral withdrawal of payment for the agreed compute service.',salt:'63'.repeat(32)};
  const exit=await walletProof({executable:coinWallet,operation:'exit',state:exitState,actor:recipient,boundary:exitBoundary,agreement:exitAgreement,intent:{chain_id:exitState.chain_id,expires_height:String(BigInt(exitState.height)+300n),licence_revision:exitState.licence_revision,key_file:keys.get(recipient.member.id).file,commitments:exitState.commitments,expected_root:exitState.root,source_bundle:Buffer.from(exitState.payments[0].bundle,'base64url').toString('hex'),source_position:Number(paymentState.count)+payment.inspection.outputs.find(output=>output.address===keys.get(recipient.member.id).address).position,member:recipient.member.id,amount:'26',purpose_commitment:coinBoundaryPurposeCommitment(exitAgreement,exitBoundary),reviewer_public_key:raw(reviewer.publicKey),memo:'fictional withdrawal',review_file:join(root,'fictional-exit-review.json')}});
  assert.equal(exit.wire.readBigInt64LE(5),26n);
  await submit('coin_exit',{bundle:exit.bundle,approval:exit.approval},recipient,true,exit.signed);
  await submit('coin_exit',{bundle:exit.bundle,approval:exit.approval},recipient,false);
  const final=await read({...sources,parties:[],boundary_member:recipient.member.id,source_boundaries:[exit.approval.effects],source_payments:[payment.approval.effects]});
  const cachedSender=JSON.parse(await readFile(caches.get(sender.member.id),'utf8'));
  const increment=await read({...sources,parties:[sender.member.id,recipient.member.id],compact_witness:true,witness_cache:cachedSender,witness_positions:cachedSender.witnesses.map(w=>w.position)});assert.equal(increment.notes_fetched,'4');assert.equal(increment.count,'6');assert.equal(increment.commitments.length,0);
  const warm=await read({...sources,parties:[sender.member.id,recipient.member.id],compact_witness:true,witness_cache:increment.witness_cache,witness_positions:increment.witness_cache.witnesses.map(w=>w.position)});assert.equal(warm.notes_fetched,'0');
  assert.equal(final.coin.balance,'26');assert.deepEqual(final.coin.supply,{minted:'5000000',reserved:'0',transparent:'4999956',shielded:'44'});assert.equal(final.count,'6');
  return {entry:{bundle:entry.bundle,approval:entry.approval},payment:{bundle:payment.bundle,approval:payment.approval},exit:{bundle:exit.bundle,approval:exit.approval},proven_records:['coin_supply',`coin_balance/${sender.member.id}`,`coin_balance/${recipient.member.id}`,`private_boundary/${entry.approval.effects}`,`private_payment/${payment.approval.effects}`,`private_boundary/${exit.approval.effects}`,'private_frontier'],incremental_witness:{partial_checker_decision_waited:true,compact_wallet_proofs:true,cached_append_notes:'4',warm_notes:'0'},spending_key_files:{sender:keys.get(sender.member.id).file,recipient:keys.get(recipient.member.id).file},read_compact_after_restart:()=>read({...sources,parties:[sender.member.id,recipient.member.id],compact_witness:true,witness_cache:warm.witness_cache,witness_positions:warm.witness_cache.witnesses.map(w=>w.position)}),read_after_restart:()=>read({...sources,parties:[],boundary_member:recipient.member.id,source_boundaries:[entry.approval.effects,exit.approval.effects],source_payments:[payment.approval.effects]})};
}
