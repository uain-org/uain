import test from 'node:test';import assert from 'node:assert/strict';
import {evidenceJourney,evidenceActivation} from '../server/central-evidence.mjs';
import {centralPayload} from '../server/central-earning-command.mjs';
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const reviewer='uain1'+'a'.repeat(40),manager='uain1'+'b'.repeat(40);
const activation=evidenceActivation({policy:'central-evidence-window-v1',height:'100',window_blocks:'129600',approved_by:'uain1'+'c'.repeat(40),evidence_digest:'d'.repeat(64)});
const proof={height:'1000',headerTime:'2026-11-09T12:00:00.000Z'};
const t={id:'CT-1'};
const s=extra=>({id:'CS-1',task:'CT-1',state:'under_review',...extra});
const asked={status:'proved',record:{verdict:'needs_evidence',reviewer}};
test('no reviewer decision yet reads as a verification-service wait, not an evidence request',()=>{
 const j=evidenceJourney({s:s(),t,review:{status:'not-found',record:null},activation,proof});
 assert.equal(j.kind,'verification_service');assert.match(j.message,/need to do nothing/);assert.equal(j.actions,undefined);
});
test('a reviewer request shows what was found, who can help, the deadline and two supported actions',()=>{
 const j=evidenceJourney({s:s({evidence_request_height:'900',evidence_deadline:'130500'}),t,review:asked,findings:['Cite the second dataset'],activation,proof,help:{reviewer,manager}});
 assert.equal(j.kind,'reviewer_request');assert.deepEqual(j.found,['Cite the second dataset']);
 assert.deepEqual([j.help.reviewer,j.help.manager],[reviewer,manager]);
 assert.equal(j.window.deadlineHeight,'130500');assert.equal(j.window.blocksLeft,'129500');assert.equal(j.window.open,true);
 assert.equal(j.window.deadlineEstimate,new Date(Date.parse(proof.headerTime)+129500*2060).toISOString());
 assert.deepEqual(j.actions.map(a=>a.operation),['central_submit','central_reassess']);assert.equal(j.actions[0].payload.revises,'CS-1');
});
test('after the deadline the only action is expiry; reassessment and revision states are explicit',()=>{
 const closed=evidenceJourney({s:s({evidence_deadline:'999'}),t,review:asked,activation,proof});
 assert.equal(closed.window.open,false);assert.deepEqual(closed.actions,[{operation:'central_evidence_expire',payload:{submission:'CS-1'}}]);
 assert.equal(evidenceJourney({s:s({evidence_deadline:'2000',reassess:true}),t,review:asked,activation,proof}).kind,'reassessment_pending');
 assert.equal(evidenceJourney({s:s({state:'superseded',revised_by:'CS-2'}),t,review:asked,activation,proof}).revisedBy,'CS-2');
 assert.equal(evidenceJourney({s:s({state:'expired',expired_height:'1001'}),t,review:asked,activation,proof}).kind,'expired');
 assert.equal(evidenceJourney({s:s({state:'accepted'}),t,review:asked,activation,proof}),null);
});
test('requests recorded before activation say so and offer no native action',()=>{
 const j=evidenceJourney({s:s(),t,review:asked,activation:null,proof});
 assert.equal(j.kind,'reviewer_request');assert.deepEqual(j.actions,[]);assert.match(j.note,/predates/);
});
test('activation record is strictly validated',()=>{
 assert.equal(evidenceActivation(null),null);
 assert.throws(()=>evidenceActivation({policy:'other',height:'1',window_blocks:'1',approved_by:reviewer,evidence_digest:'d'.repeat(64)}));
});
test('typed commands: optional linked revision, reassess and expire payloads',()=>{
 const base={id:'CS-2',task:'CT-1',evidence:'42',evidence_digest:sha('42')};
 assert.equal(centralPayload('central_submit',base).revises,undefined);
 assert.equal(centralPayload('central_submit',{...base,revises:'CS-1'}).revises,'CS-1');
 assert.throws(()=>centralPayload('central_submit',{...base,revises:'CS-2'}));
 assert.throws(()=>centralPayload('central_submit',{...base,revises:'bad id!'}));
 assert.throws(()=>centralPayload('central_submit',{...base,other:'x'}));
 assert.deepEqual({...centralPayload('central_reassess',{submission:'CS-1'})},{submission:'CS-1'});
 assert.deepEqual({...centralPayload('central_evidence_expire',{submission:'CS-1'})},{submission:'CS-1'});
 assert.throws(()=>centralPayload('central_reassess',{submission:'CS-1',extra:1}));
 assert.equal(centralPayload('central_evidence_activate',{policy:'central-evidence-window-v1',window_blocks:'129600',evidence_digest:'d'.repeat(64)}).window_blocks,'129600');
 assert.throws(()=>centralPayload('central_evidence_activate',{policy:'central-evidence-window-v1',window_blocks:'0',evidence_digest:'d'.repeat(64)}));
});
