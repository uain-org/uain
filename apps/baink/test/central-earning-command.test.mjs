import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {centralEarningSigningBytes,verifyCentralEnvelope,centralPayload,CENTRAL_POLICY} from '../server/central-earning-command.mjs';
import {signingBytes} from '../../../chain/client/signing.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex'),d='a'.repeat(64);
const keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({format:'jwk'}).x,member='uain1'+digest(Buffer.from(pub,'base64url')).slice(0,40);
const command=(operation,payload)=>({version:1,chain_id:'fictional-central-test',member,sequence:'1',expires_height:'100',operation,payload});
const payload={id:'CT-1',project:'P-1',title:'A bounded original task',criteria:'Return a proof of the stated claim.',acceptance_digest:digest('Return a proof of the stated claim.'),eligibility:'unresolved',eligibility_digest:d,solver_amount:'100000000',reviewer_amount:'20000000',evidence_digest:d};
test('central command bytes preserve the existing native signature domain and ordering',()=>{
 const c=command('central_task_open',payload);assert.deepEqual(centralEarningSigningBytes(c),signingBytes(c));
 assert.equal(CENTRAL_POLICY,'central-earning-five-kpi-fund-v2');
});
test('only exact typed central operations can enter the new signing path',()=>{
 for(const c of [command('coin_claim',{contribution:'RC-1'}),command('central_submit',{id:'CS-1',task:'CT-1',evidence:'answer',evidence_digest:digest('answer'),private_key:'no'}),{...command('central_task_fund',{task:'CT-1',evidence_digest:d}),instance:'unexpected'}])assert.throws(()=>centralEarningSigningBytes(c));
});
test('criteria and evidence must be exact bounded UTF8 content, not an unrelated digest',()=>{
 assert.throws(()=>centralPayload('central_task_open',{...payload,acceptance_digest:d}));
 for(const evidence of ['', '   ', 'x'.repeat(16385),'\ud800'])assert.throws(()=>centralPayload('central_submit',{id:'CS-1',task:'CT-1',evidence,evidence_digest:digest(evidence)}));
 assert.equal(centralPayload('central_submit',{id:'CS-1',task:'CT-1',evidence:'é < evidence',evidence_digest:digest('é < evidence')}).evidence,'é < evidence');
});
test('both advertised rewards must be positive canonical strings within project ceiling',()=>{
 for(const amount of ['0','01','-1',100,'1000000000000001'])assert.throws(()=>centralPayload('central_task_open',{...payload,solver_amount:amount}));
 assert.throws(()=>centralPayload('central_task_open',{...payload,solver_amount:'1000000000000000',reviewer_amount:'1'}));
});
test('envelope verification binds member, chain and typed operation',()=>{
 const c=command('central_submit',{id:'CS-1',task:'CT-1',evidence:'the evidence',evidence_digest:digest('the evidence')});
 const e={command:c,public_key:pub,signature:sign(null,centralEarningSigningBytes(c),keys.privateKey).toString('base64url')};
 assert.equal(verifyCentralEnvelope(e,{chainId:c.chain_id,operations:['central_submit']}),true);
 assert.throws(()=>verifyCentralEnvelope(e,{chainId:'other',operations:['central_submit']}));
 assert.throws(()=>verifyCentralEnvelope({...e,command:{...c,payload:{...c.payload,task:'CT-2'}}},{chainId:c.chain_id,operations:['central_submit']}));
 assert.throws(()=>verifyCentralEnvelope(e,{chainId:c.chain_id,operations:['central_review']}));
});
test('central review accepts only bounded final or inconclusive decisions with all evidence bindings',()=>{
 const p={submission:'CS-1',verdict:'accept',criteria_digest:d,verification_digest:d,execution_id:'review-1',evidence_digest:d};
 assert.equal(centralPayload('central_review',p).verdict,'accept');
 for(const x of [{...p,verdict:'paid'},{...p,execution_id:'../escape'},{...p,verification_digest:'bad'},{...p,amount:'999999'}])assert.throws(()=>centralPayload('central_review',x));
});

test('typed terms permit later allowance sizes while rejecting superseded policy',()=>{
 assert.equal(CENTRAL_POLICY,'central-earning-five-kpi-fund-v2');
 assert.throws(()=>centralPayload('central_earning_activate',{policy:'central-earning-project-budget-v1',reviewer:'uain1'+'a'.repeat(40),evidence_digest:'a'.repeat(64)}));
 assert.doesNotThrow(()=>centralPayload('central_task_open',{id:'CT-round',project:'P-round',title:'Bounded first round',criteria:'Exact hard result',acceptance_digest:createHash('sha256').update('Exact hard result').digest('hex'),eligibility:'hard',eligibility_digest:'a'.repeat(64),solver_amount:'10000000000',reviewer_amount:'1',evidence_digest:'a'.repeat(64)}));
});
