import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createIdentity } from './identity.js';
import { signingBytes } from '../../../chain/client/signing.mjs';

const epoch = '1'.repeat(64), chainId = 'instance-browser-fixture';
async function fixture() {
  const identity = await createIdentity(), payload = { id:'owned-instance',name:'Research <AI> & team\u2028test',family:'Fixture' };
  const command = { version:1,chain_id:chainId,member:identity.address,sequence:'7',expires_height:'200',operation:'instance_create',payload };
  return { identity,intent:{status:'prepared',command,publicKey:identity.publicKeyBase64.replaceAll('+','-').replaceAll('/','_').replaceAll('=',''),signingBytesBase64:signingBytes(command).toString('base64'),proof:{authority:'native',chainId,height:'100',headerTime:new Date().toISOString(),maxAgeSeconds:120,epoch,genesisSha256:epoch,verifierSha256:'2'.repeat(64)}}, options:{chainId,genesisSha256:epoch,expectedPayload:structuredClone(payload)} };
}
test('browser signs exact reviewed instance_create locally with native-client-compatible escaping',async () => {
  const {nativeInstanceSigningBytes,signNativeInstanceIntent} = await import('./native-instance.js');
  const f = await fixture();
  assert.deepEqual(Buffer.from(nativeInstanceSigningBytes(f.intent.command)),signingBytes(f.intent.command));
  const envelope = await signNativeInstanceIntent(f.identity,f.intent,f.options);
  assert.deepEqual(Object.keys(envelope).sort(),['command','public_key','signature']);
  assert.ok(verify(null,signingBytes(envelope.command),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:envelope.public_key},format:'jwk'}),Buffer.from(envelope.signature,'base64url')));
});
test('browser refuses challenge substitution, unsafe payloads, financial operations and stale or substituted proof context',async () => {
  const {signNativeInstanceIntent} = await import('./native-instance.js');
  for (const change of [
    i => { i.command.operation='coin_transfer'; }, i => { i.command.sequence='00'; }, i => { i.command.sequence='18446744073709551615'; },
    i => { i.command.payload.id='../unsafe'; }, i => { i.command.payload.name='Unreviewed name'; }, i => { i.command.payload.family='\ud800'; },
    i => { i.command.payload.credits='9'; }, i => { i.command.member='uain1'+'a'.repeat(40); }, i => { i.command.chain_id='other'; },
    i => { i.command.expires_height='201'; }, i => { i.command.expires_height='100'; }, i => { i.command.instance='extra'; },
    i => { i.proof.epoch='3'.repeat(64); }, i => { i.proof.headerTime=new Date(0).toISOString(); },
    i => { i.signingBytesBase64=Buffer.from('not the command').toString('base64'); }, i => { i.publicKey='a'.repeat(43); },
  ]) { const f=await fixture();change(f.intent);await assert.rejects(signNativeInstanceIntent(f.identity,f.intent,f.options)); }
});

test('active genesis identities can sign exact instance creation at canonical latest sequence zero',async () => {
  const {signNativeInstanceIntent} = await import('./native-instance.js');
  const f = await fixture();
  f.intent.command.sequence = '0';
  f.intent.signingBytesBase64 = signingBytes(f.intent.command).toString('base64');
  const envelope = await signNativeInstanceIntent(f.identity,f.intent,f.options);
  assert.equal(envelope.command.sequence,'0');
  assert.equal(envelope.command.operation,'instance_create');
});
