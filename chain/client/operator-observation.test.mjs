import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {observeOperatorClaim} from './operator-observation.mjs';
import {canonicalJSON} from './signing.mjs';

const claim={member:'uain1'+'a'.repeat(40),instance:'legacy-instance',domain:'example.org',did:'did:uain:123456789abc',event_id:'42',at:'2026-10-08T00:00:00Z'};
const checkedAt='2026-10-08T00:00:05Z';
test('DNS observer joins TXT chunks and binds an unsigned payload to the committed claim',async()=>{
 let lookedUp;
 const result=await observeOperatorClaim(claim,{checkedAt,resolver:async domain=>{lookedUp=domain;return [['unrelated=record'],['uain-operator=','did:uain:123456789abc']];}});
 assert.equal(lookedUp,claim.domain);
 assert.equal(result.operation,'operator_attest');assert.equal(result.payload.claim_event_id,'42');assert.equal(result.payload.instance,claim.instance);assert.equal(result.payload.txt,'uain-operator='+claim.did);
 assert.equal(result.payload.evidence_digest,createHash('sha256').update(canonicalJSON(result.evidence)).digest('hex'));
 assert.equal(result.evidence.trust,'guardian-dns-observation');
 assert.equal(Object.hasOwn(result,'signature'),false);
});
test('DNS observer refuses malformed claims, wrong TXT and propagated resolver errors',async()=>{
 let calls=0;
 const resolver=async()=>{calls++;return [['uain-operator='+claim.did+'-another-system']];};
 for(const bad of [{...claim,instance:123},{...claim,domain:'https://example.org'},{...claim,event_id:'18446744073709551616'},{...claim,did:'did:other:123'}])await assert.rejects(observeOperatorClaim(bad,{checkedAt,resolver}),/valid committed/);
 assert.equal(calls,0);
 await assert.rejects(observeOperatorClaim(claim,{checkedAt,resolver}),/not found/);
 await assert.rejects(observeOperatorClaim(claim,{checkedAt,resolver:async()=>{throw Error('DNS unavailable');}}),/DNS unavailable/);
 await assert.rejects(observeOperatorClaim(claim,{checkedAt:'2026-10-07T23:59:59Z',resolver:async()=>[['uain-operator='+claim.did]]}),/predates/);
});
