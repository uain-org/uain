import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createPublicKey,generateKeyPairSync,verify,webcrypto } from 'node:crypto';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privatePartyConsent,verifyPrivatePartyConsent,signPrivateApproval,privatePurposeCommitment } from '../../../chain/client/private-review.mjs';
import { coinBoundaryPurposeCommitment,signCoinBoundaryApproval } from '../../../chain/client/coin-boundary.mjs';
import { signingBytes,signedEnvelope } from '../../../chain/client/signing.mjs';
import {e2eSkip} from '../../../ops/ci/e2e-gate.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const raw=k=>k.export({type:'spki',format:'der'}).subarray(-32);
const actor=()=>{const keys=generateKeyPairSync('ed25519'),pub=raw(keys.publicKey);return {...keys,member:'uain1'+hash(pub).slice(0,40),nativeKey:pub.toString('base64url')};};
async function fixture(t) {
 const api=await import('./external-signing.mjs');
 const directory=await mkdtemp(join(tmpdir(),'holder-external-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const pair=await webcrypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']);
 const pub=Buffer.from(await webcrypto.subtle.exportKey('raw',pair.publicKey));
 const identity={member:'uain1'+hash(pub).slice(0,40),publicKey:pub.toString('base64url')};
 const ownerPublic=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:identity.publicKey},format:'jwk'});
 const reviewer=actor(),relay=actor(),recipient=actor();
 const pins={chainId:'holder-external-fixture',genesisSha256:hash('{"chain_id":"holder-external-fixture"}')};
 const genesis=join(directory,'genesis.json');await writeFile(genesis,'{"chain_id":"holder-external-fixture"}');
 const snapshot={chain_id:pins.chainId,height:'100',header_time:new Date().toISOString(),app_hash:'a'.repeat(64),licence_revision:'0',root:'ae2935f1dfd8a24aed7c70df7de3a668eb7a49b1319880dde2bbd9031ae5d82f',count:'0',reviewer:{member:reviewer.member,public_key:reviewer.nativeKey,karma:132,sequence:'0'},relayer:{member:relay.member,public_key:relay.nativeKey,karma:0,sequence:'2'},identities:{[identity.member]:{member:identity.member,public_key:identity.publicKey,sequence:'7',karma:0},[recipient.member]:{member:recipient.member,public_key:recipient.nativeKey,sequence:'0',karma:0}},coin:{policy:'verified-bounties-108t-micro-v1',supply:{minted:'1000',reserved:'0',transparent:'1000',shielded:'0'},balance:'1000'},commitments:[],payments:[],boundaries:[],witness_complete:true,witness_cache:{chain_id:pins.chainId,count:'0',root:'ae2935f1dfd8a24aed7c70df7de3a668eb7a49b1319880dde2bbd9031ae5d82f',nodes:Array(32).fill(''),witnesses:[]},notes_fetched:'0'};
 const statePath=join(directory,'state.json');await writeFile(statePath,JSON.stringify(snapshot));
 // Trusted process-boundary fixture only. Consensus/IAVL and Orchard proof
 // qualification remain the responsibility of actual pinned native tools.
 const script=`#!${process.execPath}\nconst fs=require('node:fs');let data='';process.stdin.on('data',b=>data+=b);process.stdin.on('end',()=>{const r=JSON.parse(data),s=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}));s.policy_only=!!r.policy_only;s.parties=(r.parties||[]).map(id=>s.identities[id]);if(r.boundary_member)s.coin.owner=s.identities[r.boundary_member];delete s.identities;fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify(s),{mode:384,flag:'wx'});});\n`;
 const executable=join(directory,'reader');await writeFile(executable,script,{mode:0o700});
 const reader={executable,executableSha256:hash(script),genesis,genesisSha256:pins.genesisSha256,rpc:'http://127.0.0.1:1',maxAgeSeconds:120};
 const tools={coinWallet:{executable,executableSha256:hash(script)},privateWallet:{executable,executableSha256:hash(script)}};
 const requests=[];let alter=null;
 const sign=async request=>{
  requests.push(structuredClone(request));if(alter)return alter(request);
  return {publicKey:identity.publicKey,signature:Buffer.from(await webcrypto.subtle.sign('Ed25519',pair.privateKey,Buffer.from(request.signingBytesBase64,'base64'))).toString('base64url')};
 };
 const adapter=api.createExternalHolder({identity,reader,tools,pins,sign});
 const intent={id:'holder-intent-0001',operation:'coin_shield',amount:'26',agreement:{text:'Fictional neutral owned value shielding for an agreed service.',salt:'1a'.repeat(32)},reviewer:reviewer.member,owner:identity,recipient:null};
 const context=i=>({version:1,chain:pins.chainId,expires:'200',licenceRevision:'0',effects:'2b'.repeat(32),purpose:api.holderIntentPurpose(i),reviewer:raw(reviewer.publicKey).toString('hex')});
 const address='31'.repeat(43);
 async function boundaryResult(i=intent) {
  const c=context(i),consent=await adapter.signConsent(i,{context:c,address});
  const approval=signCoinBoundaryApproval({context:c,boundary:{direction:i.operation==='coin_shield'?'shield':'exit',member:i.owner.member,amount:i.amount},agreement:api.holderPrivateAgreement(i),reviewerSigningKey:reviewer.privateKey,licensedOwnerKey:ownerPublic,consents:[consent],outputs:[{address,amount:i.amount},{address,amount:'0'}],valueBalance:(i.operation==='coin_shield'?'-':'')+i.amount,decision:{class:'neutral',checkedPurpose:c.purpose,ownerLicenceChecked:true,statement:'Fixture reviewer explicitly inspected the fictional owned outputs and neutral purpose.'}});
  return {operation:i.operation,payload:{bundle:'AQ',approval},local_receipt:{effects:c.effects,outputs:[{address,amount:i.amount},{address,amount:'0'}]}};
 }
 return {api,adapter,identity,pair,reviewer,relay,recipient,ownerPublic,intent,context,address,requests,reader,tools,pins,directory,snapshot,sign,boundaryResult,setSigner(fn){alter=fn;},async patchState(update){update(snapshot);await writeFile(statePath,JSON.stringify(snapshot));}};
}

test('external consent bytes match the existing signed client without exporting the browser private key',async t=>{
 const f=await fixture(t);await assert.rejects(webcrypto.subtle.exportKey('jwk',f.pair.privateKey));
 const context=f.context(f.intent),consent=await f.adapter.signConsent(f.intent,{context,address:f.address});
 assert.equal(consent.publicKey,Buffer.from(f.identity.publicKey,'base64url').toString('hex'));
 assert.equal(verifyPrivatePartyConsent(context,consent,f.ownerPublic),true);
 const actorKey=actor();const reference=privatePartyConsent(context,f.address,actorKey.privateKey);
 assert.ok(verify(null,f.api.privatePartyConsentSigningBytes(context,f.address),actorKey.publicKey,Buffer.from(reference.signature,'base64url')));
 assert.equal(f.requests[0].kind,'party_consent');assert.equal(f.requests[0].intent.amount,'26');
 assert.ok(!JSON.stringify(f.requests).includes('spendingKeyFile'));
});
test('boundary native commands use external local signatures bound to exact owner, amount, purpose, effects and current sequence',async t=>{
 const f=await fixture(t),result=await f.boundaryResult();
 const envelope=await f.adapter.signBoundary(f.intent,result);
 assert.equal(envelope.command.sequence,'7');assert.equal(envelope.command.operation,'coin_shield');assert.equal(envelope.command.member,f.identity.member);
 assert.ok(verify(null,signingBytes(envelope.command),f.ownerPublic,Buffer.from(envelope.signature,'base64url')));
 assert.equal(f.requests.at(-1).kind,'boundary_command');assert.equal(f.requests.at(-1).command.payload.approval.amount,'26');
 assert.deepEqual(Object.keys(envelope).sort(),['command','public_key','signature']);
});
test('substituted key, signature, chain, amount, purpose and expired contexts fail before authority is returned',async t=>{
 const f=await fixture(t),result=await f.boundaryResult();
 for(const mutate of [r=>{r.payload.approval.amount='27';},r=>{r.payload.approval.member=f.recipient.member;},r=>{r.payload.approval.effects='99'.repeat(32);},r=>{r.payload.approval.purpose_commitment='98'.repeat(32);},r=>{r.payload.approval.expires_height='99';},r=>{r.operation='coin_exit';},r=>{r.payload.amount='26';}]){const bad=structuredClone(result);mutate(bad);await assert.rejects(f.adapter.signBoundary(f.intent,bad));}
 f.setSigner(async()=>({publicKey:f.recipient.nativeKey,signature:'A'.repeat(86)}));await assert.rejects(f.adapter.signBoundary(f.intent,result));
 f.setSigner(async()=>({publicKey:f.identity.publicKey,signature:'A'.repeat(86)}));await assert.rejects(f.adapter.signBoundary(f.intent,result));
 await f.patchState(s=>{s.chain_id='wrong-chain';});await assert.rejects(f.adapter.signBoundary(f.intent,result));
});
test('a sequence or licence revision change during browser consent prevents returning a usable signed command',async t=>{
 const f=await fixture(t),result=await f.boundaryResult();
 f.setSigner(async request=>{
  const signature=Buffer.from(await webcrypto.subtle.sign('Ed25519',f.pair.privateKey,Buffer.from(request.signingBytesBase64,'base64'))).toString('base64url');
  await f.patchState(s=>{s.identities[f.identity.member].sequence='8';});return {publicKey:f.identity.publicKey,signature};
 });
 await assert.rejects(f.adapter.signBoundary(f.intent,result));
});
test('OTC requests disclose only the public proof to the required separate licensed relay; payer cannot sign the outer command',async t=>{
 const f=await fixture(t),intent={...f.intent,operation:'private_payment',recipient:{member:f.recipient.member,publicKey:f.recipient.nativeKey,address:'41'.repeat(43)}};
 const context=f.context(intent),sender=await f.adapter.signConsent(intent,{context,address:f.address});
 const approval=signPrivateApproval({context,reviewerSigningKey:f.reviewer.privateKey,trustedRelayerKey:f.relay.publicKey,licensedSenderKey:f.ownerPublic,licensedRecipientKey:f.recipient.publicKey,sender,recipient:privatePartyConsent(context,intent.recipient.address,f.recipient.privateKey),outputs:[{address:f.address,amount:'44'},{address:intent.recipient.address,amount:'26'}],amount:'26',decision:{class:'neutral',checkedPurpose:context.purpose,bothLicencesChecked:true,statement:'Fixture checker inspected both fictional licensed outputs and their neutral private purpose.'}});
 const result={operation:'private_payment',payload:{bundle:'AQ',approval},local_receipt:{effects:context.effects,outputs:[],secret:'keep local'}};
 await assert.rejects(f.adapter.signBoundary(intent,result));
 const request=await f.adapter.relayRequest(intent,result),serialized=JSON.stringify(request);
 for(const secret of [intent.agreement.text,intent.agreement.salt,f.identity.member,f.recipient.member,intent.recipient.address,'local_receipt','keep local'])assert.ok(!serialized.includes(secret));
 assert.equal(request.signer.member,f.relay.member);
 await assert.rejects(f.adapter.relayRequest({...intent,amount:'27'},result));
 const other=actor();await assert.rejects(f.adapter.relayRequest({...intent,recipient:{member:other.member,publicKey:other.nativeKey,address:'42'.repeat(43)}},result));
 const command={version:1,chain_id:f.pins.chainId,member:f.relay.member,sequence:'2',expires_height:approval.expires_height,operation:'private_payment',payload:result.payload};
 const envelope=signedEnvelope(command,raw(f.relay.publicKey),f.relay.privateKey);
 assert.deepEqual(await f.adapter.verifyRelayEnvelope(intent,result,envelope),envelope);
 envelope.command.sequence='3';await assert.rejects(f.adapter.verifyRelayEnvelope(intent,result,envelope));
});
test('unsafe identities, extra intent fields, unreviewed recipient and hosted reader configuration fail closed',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.api.createExternalHolder({identity:{...f.identity,privateKey:'forbidden'},reader:f.reader,tools:f.tools,pins:f.pins,sign:f.sign}));
 assert.throws(()=>f.api.createExternalHolder({identity:f.identity,reader:{...f.reader,rpc:'https://host.example/'},tools:f.tools,pins:f.pins,sign:f.sign}));
 await assert.rejects(f.adapter.signConsent({...f.intent,credits:'9'},{context:f.context(f.intent),address:f.address}));
 await assert.rejects(f.adapter.signConsent(f.intent,{context:{...f.context(f.intent),chain:'other'},address:f.address}));
 await f.patchState(s=>{s.header_time=new Date(0).toISOString();});await assert.rejects(f.adapter.signConsent(f.intent,{context:f.context(f.intent),address:f.address}));
});


test('optional isolated genuine Orchard proof uses the external non-exportable owner and existing encrypted checker workflow', {skip:e2eSkip(Boolean(process.env.UAIN_HOLDER_FIXTURE_COIN_WALLET),'UAIN_HOLDER_FIXTURE_COIN_WALLET (a built Orchard coin wallet)')}, async t=>{
 const f=await fixture(t);
 const { runPrivateAction }=await import('../../../chain/client/private-cli.mjs');
 const { certificateForPrivateState,reviewEncryptedPrivateTrade }=await import('../../../chain/client/private-workflow.mjs');
 const executable=process.env.UAIN_HOLDER_FIXTURE_COIN_WALLET;
 const tool={executable,executableSha256:hash(await readFile(executable))};
 assert.equal(tool.executableSha256,'f3fd242f79c44b06b431a57ed94005e80a55f372d92c0c93d7a4bef9601db986');
 const tools={coinWallet:tool,privateWallet:tool};
 const adapter=f.api.createExternalHolder({identity:f.identity,reader:f.reader,tools,pins:f.pins,sign:f.sign});
 const spendingKeyFile=join(f.directory,'fictional-orchard-key.json');
 await runPrivateAction('keygen',{tool,file:spendingKeyFile});
 const encryption=generateKeyPairSync('x25519');
 const result=await adapter.produce(f.intent,{spendingKeyFile,timeoutMs:180000,
  certificate:context=>certificateForPrivateState({reader:f.reader,context,reviewerSigningKey:f.reviewer.privateKey,encryptionPublicKey:encryption.publicKey}),
  review:envelope=>reviewEncryptedPrivateTrade({reader:f.reader,envelope,tools,reviewerSigningKey:f.reviewer.privateKey,reviewerEncryptionKey:encryption.privateKey,decide:async inspected=>{
   assert.equal(inspected.amount,f.intent.amount);assert.equal(inspected.agreement.text,f.intent.agreement.text);
   return {class:'neutral',checkedPurpose:inspected.context.purpose,ownerLicenceChecked:true,statement:'Isolated fictional proof acceptance explicitly checked both owned outputs and the neutral test purpose.'};
  }}),
 });
 assert.equal(result.operation,'coin_shield');assert.equal(result.payload.approval.amount,'26');
 assert.ok(Buffer.from(result.payload.bundle,'base64url').length>1000);
 const envelope=await adapter.signBoundary(f.intent,result);
 assert.ok(verify(null,signingBytes(envelope.command),f.ownerPublic,Buffer.from(envelope.signature,'base64url')));
 assert.equal(f.pair.privateKey.extractable,false);
});
