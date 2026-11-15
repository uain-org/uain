import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
const mod = await import('./snapshot.mjs').catch(()=>({}));
const sha = x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32),id='uain1'+sha(raw).slice(0,40);
 const tables=Object.fromEntries((mod.TABLES??[]).map(t=>[t,[]]));
 Object.assign(tables,{members:[{id,name:'Source member',public_key:raw.toString('base64url'),state:'active'}],participants:[{id:'AG-1',member_id:id,name:'First instance',operator:'Source operator',model:'Fixture',state:'active',karma:'7',credits:'9',default_verifier_at:'2026-10-01',project_creator_at:null},{id:'AG-unclaimed',member_id:null,name:'Old instance',operator:'Old operator',model:'Old',state:'active',karma:'2',credits:'3'}],credit_ledger:[{id:'1',participant:'AG-1',delta:'9',kind:'opening_balance',ref:null,at:'2026-10-01'},{id:'2',participant:'AG-unclaimed',delta:'3',kind:'opening_balance',ref:null,at:'2026-10-01'}],karma_events:[{id:'1',participant_id:'AG-1',member_id:id,delta:'7',kind:'opening_balance',event_id:null},{id:'2',participant_id:'AG-unclaimed',member_id:null,delta:'2',kind:'opening_balance',event_id:null}]});
 const event={id:'1',at:'2026-10-01T12:00:00.000Z',kind:'test',actor:'AG-1',peer:null,summary:'Original bytes < >',hash_version:'2',salt:'fixture salt',commits:'{"value":"unaltered"}',prev_hash:'0'.repeat(64),redacted:'0'};
 event.content_digest=sha(event.salt+'\n'+JSON.stringify([event.summary,event.commits]));
 event.hash=sha(event.prev_hash+'\n'+JSON.stringify([2,1,event.at,event.kind,event.actor,null,event.content_digest,null]));
 tables.events=[event];
 const payload={date:'2026-10-01',root:event.hash,head:event.hash,count:1,first_id:1,last_id:1};
 tables.ledger_roots=[{...payload,count:'1',first_id:'1',last_id:'1',signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64'),computed_at:event.at}];
 return {tables,id,pinned:publicKey.export({format:'pem',type:'spki'})};
}
test('migration reconciles both journals, preserves unclaimed attribution, and imports no Coin',()=>{
 assert.equal(typeof mod.buildSnapshot,'function','complete deterministic snapshot builder is required');
 const f=fixture(),s=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 assert.equal(s.reconciliation.members[0].id,f.id);
 assert.equal(s.reconciliation.members[0].karma,'7');assert.equal(s.reconciliation.members[0].credits,'9');
 assert.equal(s.reconciliation.unclaimed[0].id,'AG-unclaimed');
 assert.equal(s.reconciliation.unclaimed[0].credits,'3');
 assert.equal(s.reconciliation.coin_issued,'0');
 assert.equal(s.reconciliation.ledger.head,f.tables.events[0].hash);
 assert.equal(s.reconciliation.completed_roots,1);
 assert.deepEqual(s.tables.events,f.tables.events);
 assert.ok(s.records.every(r=>Buffer.byteLength(r.value)<=16384));
 const imported=s.records.filter(r=>r.key.startsWith('legacy/row/')).map(r=>JSON.parse(r.value));
 assert.ok(imported.some(r=>r.table==='participants'&&r.row.id==='AG-unclaimed'));
});
test('snapshot root and page proofs are deterministic across source row order',()=>{
 assert.equal(typeof mod.buildSnapshot,'function');
 const f=fixture(),a=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 for(const rows of Object.values(f.tables))rows.reverse();
 const b=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 assert.equal(a.manifest_digest,b.manifest_digest);assert.equal(a.records_root,b.records_root);
 for(let i=0;i<a.records.length;i++)assert.ok(mod.verifyRecord(a.records[i],i,a.proofs[i],a.records_root));
 assert.equal(mod.verifyRecord({...a.records[0],value:'altered'},0,a.proofs[0],a.records_root),false);
});
test('corrupt cache, changed original hashes, orphan checks and secret columns fail closed',()=>{
 assert.equal(typeof mod.buildSnapshot,'function');
 for(const mutation of [f=>f.tables.participants[0].credits='10',f=>f.tables.events[0].summary='changed',f=>f.tables.verifications.push({id:'1',contribution_id:'RC-absent',verifier:'AG-1'}),f=>f.tables.participants[0].token_hash='must never publish']){
  const f=fixture();mutation(f);assert.throws(()=>mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned}));
 }
});
test('outstanding obligations retain original amounts and exact source recipients',()=>{
 assert.equal(typeof mod.buildSnapshot,'function');
 const f=fixture();f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active',title:'Existing project'}];
 f.tables.tasks=[{id:'T-1',project_id:'P-1',created_by:'AG-1',closed_at:null,prize_contribution:null,kind:'future'}];
 f.tables.contributions=[{id:'RC-1',project_id:'P-1',task_id:'T-1',contributor:'AG-1',state:'settled',credits_deferred:'4',prize_due:'5',award_pending:'kpi',award_held:'{"credibility":7,"credits":11,"checks":[]}'}];
 f.tables.credit_deferrals=[{id:'1',contribution_id:'RC-1',participant:'AG-1',amount:'4',kind:'contribution',released_at:null}];
 const s=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 assert.deepEqual(s.reconciliation.obligations.map(x=>x.kind).sort(),['credit_deferral','future_award','open_task','prize_due']);
 const debt=s.reconciliation.obligations.find(x=>x.kind==='credit_deferral');
 assert.equal(debt.amount,'4');assert.equal(debt.member,f.id);assert.equal(debt.instance,'AG-1');
 assert.equal(s.reconciliation.cutoff_ready,false);
});
test('large research remains byte complete while reconciliation stays bounded',()=>{
 const f=fixture();f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active'}];f.tables.tasks=[{id:'T-1',project_id:'P-1',created_by:'AG-1',closed_at:null}];
 f.tables.contributions=Array.from({length:60},(_,n)=>({id:'RC-'+n,project_id:'P-1',task_id:'T-1',contributor:'AG-1',state:'held',detail:'Original research text '.repeat(1500),credits_deferred:'0'}));
 const s=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 assert.equal(s.reconciliation.obligations.length,61);
 assert.ok(Buffer.byteLength(s.records.find(r=>r.key==='legacy/reconciliation').value)<=16384);
 const metadata=JSON.parse(s.records.find(r=>r.key==='legacy/row/contributions/'+mod.rowID('contributions',f.tables.contributions[0])).value);
 assert.equal(metadata.parts,4);assert.equal(metadata.row_sha256.length,64);
});
test('retained historic prize_due is not a new obligation after a task has a recorded winner',()=>{
 const f=fixture();f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active'}];f.tables.tasks=[{id:'T-1',project_id:'P-1',created_by:'AG-1',closed_at:null,prize_contribution:'RC-winner'}];
 f.tables.contributions=[{id:'RC-winner',project_id:'P-1',task_id:'T-1',contributor:'AG-1',state:'settled',prize_due:'9',karma_awarded:'9',credits_awarded:'9'},{id:'RC-later',project_id:'P-1',task_id:'T-1',contributor:'AG-1',state:'settled',prize_due:'9',karma_awarded:'0',credits_awarded:null}];
 const s=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 assert.equal(s.reconciliation.obligations.length,0,'already adjudicated historical prizes cannot be paid again');
});
test('execution capsules preserve exact source checks, frozen amounts and instance-scoped roles',()=>{
 const f=fixture();f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active'}];f.tables.project_members=[{project_id:'P-1',member_id:'AG-1'}];
 f.tables.tasks=[{id:'T-1',project_id:'P-1',created_by:'AG-1',closed_at:null,karma_offered:'20'}];f.tables.contributions=[{id:'RC-1',project_id:'P-1',task_id:'T-1',contributor:'AG-1',state:'held',karma_claimed:'20',verifiers_required:'2',award_held:'{"credibility":12,"credits":12,"verifications":[7]}'}];
 f.tables.verifications=[{id:'7',contribution_id:'RC-1',verifier:'AG-unclaimed',verdict:'partial',novelty:'new',bootstrap:'0',against_claim_revision:null}];
 const s=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned}),work=JSON.parse(s.records.find(r=>r.key==='legacy/work/RC-1').value),actor=JSON.parse(s.records.find(r=>r.key==='legacy/actor/AG-1').value);
 assert.deepEqual(work.held,{credibility:12,credits:12,verifications:[7]});assert.equal(work.checks[0].id,'7');assert.equal(work.checks[0].verdict,'partial');assert.equal(work.checks[0].original,true);assert.equal(actor.default_verifier,true);assert.deepEqual(actor.projects,['P-1']);
});
test('explicit source policy preserves original rolling issuance and leaves historical snapshots unchanged',()=>{
 const f=fixture(),historical=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 const policy={version:1,daily_credit_cap:'10',bootstrap_operators:3};
 const current=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned,publicPolicy:policy});
 assert.deepEqual(current.public_policy,policy);
 const records=Object.fromEntries(current.records.map(r=>[r.key,JSON.parse(r.value)]));
 assert.equal(records['legacy/policy'].issuance_total,'12');
 assert.equal(records['legacy/issuance_time/'+String(BigInt(Date.parse('2026-10-01'))*1000000n).padStart(20,'0')],'12');
 assert.equal(JSON.parse(current.records.find(r=>r.key==='legacy/actor/AG-1').value).source_state,'active');
 assert.notEqual(current.manifest_digest,historical.manifest_digest);
 assert.deepEqual(mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned}),historical);
 for(const changed of [{...policy,daily_credit_cap:'0'},{...policy,bootstrap_operators:-1},{...policy,private_value:'forbidden'}])assert.throws(()=>mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned,publicPolicy:changed}));
});

test('new policy project capsules carry complete original claim and task censuses',()=>{
 const f=fixture();f.tables.projects=[{id:'P-1',lead:'AG-1',state:'finished',uain_budget:'10000000',budget_status:'allocated',budget_stage:'1'}];f.tables.tasks=[{id:'T-2',project_id:'P-1',created_by:'AG-1'},{id:'T-1',project_id:'P-1',created_by:'AG-1'}];f.tables.claims=[{id:'CL-2',project_id:'P-1'},{id:'CL-1',project_id:'P-1'}];f.tables.project_members=[{project_id:'P-1',member_id:'AG-unclaimed'},{project_id:'P-1',member_id:'AG-1'}];
 const historical=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned});
 const current=mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned,publicPolicy:{version:1,daily_credit_cap:'10000',bootstrap_operators:3}});
 const capsule=s=>JSON.parse(s.records.find(r=>r.key==='legacy/project/P-1').value);
 assert.deepEqual(capsule(current).task_ids,['T-1','T-2']);assert.deepEqual(capsule(current).claim_ids,['CL-1','CL-2']);assert.equal(capsule(current).budget_status,'allocated');assert.equal(capsule(current).budget_unlocked,10000);assert.equal(capsule(current).budget_total,10000000);assert.equal(capsule(current).budget_stage,1);assert.equal(capsule(historical).budget_total,undefined);assert.equal(capsule(historical).budget_stage,undefined);assert.deepEqual(capsule(current).participant_ids,['AG-1','AG-unclaimed']);assert.equal(capsule(historical).participant_ids,undefined);assert.equal(capsule(historical).task_ids,undefined);assert.equal(capsule(historical).claim_ids,undefined);
});

test('new policy budget continuation distinguishes null and zero and rejects unsafe inputs',()=>{
 const f=fixture(),options={pinnedPublicKey:f.pinned,publicPolicy:{version:1,daily_credit_cap:'10000',bootstrap_operators:3}};f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active',uain_budget:null,budget_stage:null,budget_basis:'  Exact original operator basis  '}];const project=()=>JSON.parse(mod.buildSnapshot(f.tables,options).records.find(r=>r.key==='legacy/project/P-1').value);
 assert.equal(project().budget_basis,'  Exact original operator basis  ');assert.equal(project().budget_total,null);assert.equal(project().budget_stage,null);f.tables.projects[0].uain_budget='0';f.tables.projects[0].budget_stage='0';assert.equal(project().budget_total,0);assert.equal(project().budget_stage,0);
 f.tables.projects[0].budget_stage='4';assert.throws(project,/budget inputs/);f.tables.projects[0].budget_stage='0';f.tables.projects[0].uain_budget='9007199254740992';assert.throws(project,/budget inputs/);
});

test('new policy task capsules preserve final original KPI outcomes without reopening or altering old snapshots',()=>{
 const f=fixture(),options={pinnedPublicKey:f.pinned,publicPolicy:{version:1,daily_credit_cap:'10000',bootstrap_operators:3}};f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active'}];f.tables.tasks=[{id:'T-1',project_id:'P-1',created_by:'AG-1',kind:'future',closed_at:'2026-10-01T00:00:00Z'}];f.tables.kpi_resolutions=[{id:'1',task_id:'T-1',outcome:'unmet'}];
 const capsule=(o)=>JSON.parse(mod.buildSnapshot(f.tables,o).records.find(r=>r.key==='legacy/task/T-1').value);assert.equal(capsule(options).outcome,'unmet');assert.equal(capsule(options).state,'closed');assert.equal(capsule({pinnedPublicKey:f.pinned}).outcome,undefined);
 f.tables.kpi_resolutions[0].outcome='invented';assert.throws(()=>capsule(options),/future resolution/);f.tables.kpi_resolutions[0].outcome='met';f.tables.kpi_resolutions.push({...f.tables.kpi_resolutions[0],id:'2'});assert.throws(()=>capsule(options),/future resolution/);f.tables.kpi_resolutions.pop();f.tables.kpi_resolutions[0].task_id='missing';assert.throws(()=>capsule(options),/missing tasks\/missing/);
});
test('explicit-policy compact task budget records preserve exact source pricing without changing old snapshots',()=>{
 const f=fixture(),options={pinnedPublicKey:f.pinned,publicPolicy:{version:1,daily_credit_cap:'10000',bootstrap_operators:3}};f.tables.projects=[{id:'P-1',lead:'AG-1',state:'active'}];f.tables.tasks=[{id:'T-1',project_id:'P-1',created_by:'AG-1',kind:'future',karma_offered:'37',prize_contribution:null,closed_at:null}];
 const current=mod.buildSnapshot(f.tables,options),find=s=>s.records.find(r=>r.key==='legacy/task_budget/T-1');assert.ok(find(current));assert.deepEqual(JSON.parse(find(current).value),{id:'T-1',project:'P-1',state:'open',price:37,winner:''});assert.equal(find(mod.buildSnapshot(f.tables,{pinnedPublicKey:f.pinned})),undefined);
 f.tables.tasks[0].karma_offered=null;f.tables.tasks[0].closed_at='2026-10-01T00:00:00Z';const closed=JSON.parse(find(mod.buildSnapshot(f.tables,options)).value);assert.equal(closed.price,null);assert.equal(closed.state,'closed');
});
