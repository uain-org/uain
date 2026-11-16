import test from 'node:test';
import assert from 'node:assert/strict';
import {centralPayload} from '../server/central-earning-command.mjs';
const hash='a'.repeat(64),project='P-one';
test('typed funding commands bind five tailored stages and Main KPI and exact sequential inputs',()=>{
 const stages=Array.from({length:5},(_,i)=>({round:i+1,criteria:`Measurable project-specific criterion for stage ${i+1}`}));
 const p={project,revision:1,main_kpi:"Measurable ultimate project achievement",stages,reason:'Initial tailored project plan',evidence_digest:hash};
 assert.deepEqual(centralPayload('central_fund_plan',p),p);
 assert.throws(()=>centralPayload('central_fund_plan',{...p,stages:stages.slice(1)}));
 assert.throws(()=>centralPayload('central_fund_plan',{...p,revision:0}));
 assert.throws(()=>centralPayload('central_fund_plan',{...p,stages:stages.map(s=>({...s,approved:true}))}));
 assert.deepEqual(centralPayload('central_fund_apply',{id:'F-one',project,round:5,revision:1,evidence_digest:hash}),{id:'F-one',project,round:5,revision:1,evidence_digest:hash});
 assert.throws(()=>centralPayload('central_fund_apply',{id:'F-one',project,round:7,revision:1,evidence_digest:hash}));
 assert.throws(()=>centralPayload('central_fund_decide',{application:'F-one',verdict:'accept',verification_digest:hash,amount:'100000000000'}));
});
