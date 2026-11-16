import test from 'node:test';
import assert from 'node:assert/strict';
import {signingBytes} from '../../../chain/client/signing.mjs';
import {researchEvidence} from '../../../chain/client/evidence-document.mjs';
import {canonicalJSON,nativeResearchSigningBytes,researchEvidenceCanonical} from './native-research-codec.mjs';
const prior_art={basis:'An isolated fixture basis longer than forty characters for codec checks.',searches:['Fixture source one','Fixture source two']};
const payloads={open_project:{id:'pilot',title:'Pilot fixture title',class:'neutral',prior_art},open_task:{id:'pilot-task',project:'pilot',title:'Pilot fixture task',class:'neutral',prior_art,criteria:'An exact isolated criterion longer than forty characters.',kind:'instant',karma_reward:0,credit_reward:'0'},project_join:{project:'pilot'},submit:{id:'result',task:'pilot-task',evidence_digest:'a'.repeat(64)},verify:{contribution:'result',verdict:'confirm',novelty:'new',searches:['Fixture source one','Fixture source two'],evidence_digest:'a'.repeat(64)}};
for(const [operation,payload]of Object.entries(payloads))test(`portable ${operation} codec matches native CLI exact signing bytes`,()=>{const c={version:1,chain_id:'isolated-pilot',member:'uain1'+'a'.repeat(40),sequence:'0',expires_height:'100',operation,payload,instance:'pilot-instance'};assert.deepEqual(Buffer.from(nativeResearchSigningBytes(c)),signingBytes(c));assert.throws(()=>nativeResearchSigningBytes({...c,operation:'coin_reserve'}));assert.throws(()=>nativeResearchSigningBytes({...c,payload:{...payload,extra:true}}));});
test('public evidence matches canonical domain body including nested types and Unicode',()=>{const body={title:'Fixture < & >',detail:'Public fixture evidence long enough for exact canonical binding.',sources:['https://example.org/fixture'],evidence:{'𐀀':[true,false,null,1.25], '\ue000':'<>&\u2028'}};assert.equal(researchEvidenceCanonical(body),researchEvidence(body).canonical);assert.equal(canonicalJSON({'𐀀':false,'\ue000':[true,null]}),'{"":[true,null],"𐀀":false}');assert.throws(()=>researchEvidenceCanonical({...body,detail:'\0'.repeat(25)}));});
test('research validation rejects native-invalid searches and known-source URLs before signing',()=>{
 const base={version:1,chain_id:'isolated',member:'uain1'+'a'.repeat(40),sequence:'0',expires_height:'100',operation:'verify',payload:{contribution:'result',verdict:'confirm',novelty:'known',searches:['Search one','Search two'],evidence_digest:'a'.repeat(64),known_source:'https://example.org/paper'},instance:'owned'};
 for(const patch of [{searches:['Same search',' Same search ']},{searches:['x'.repeat(1001),'other search']},{known_source:'http://example.org/paper'},{known_source:'https://user:password@example.org/paper'},{known_source:'https://example.org/'+ 'a'.repeat(500)}])assert.throws(()=>nativeResearchSigningBytes({...base,payload:{...base.payload,...patch}}));
});

test('multiline admission prose keeps exact CLI bytes while titles and searches remain single line',()=>{
 const c={version:1,chain_id:'isolated-pilot',member:'uain1'+'a'.repeat(40),sequence:'0',expires_height:'100',operation:'open_task',payload:structuredClone(payloads.open_task),instance:'pilot-instance'};
 c.payload.prior_art.basis+='\nSource fixture@'+ 'a'.repeat(64);c.payload.criteria+='\nAcceptance criteria: verify the exact fixture output.';
 assert.deepEqual(Buffer.from(nativeResearchSigningBytes(c)),signingBytes(c));
 for(const mutate of [p=>{p.title+='\nInjected title';},p=>{p.prior_art.searches[0]+='\nInjected search';},p=>{p.criteria+='\0';}]){const changed=structuredClone(c);mutate(changed.payload);assert.throws(()=>nativeResearchSigningBytes(changed));}
});
