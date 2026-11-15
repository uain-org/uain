import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFundSnapshotReader} from '../src/fund-snapshot.mjs';
const now=()=>Date.parse('2026-11-09T00:00:00Z');
const project={id:'OPP-00001',nativeProjectId:'P-OPP-00001'};
const P=project.nativeProjectId,chainId='fixture';
const base=[`project/${P}`,`central_project_budget/${P}`,`central_fund_config/${P}`,`central_fund_state/${P}`];
const plan=n=>`central_fund_plan/${P}/${String(n).padStart(20,'0')}`;
function setup(change=()=>{}){
 let reads=0;const calls=[];
 const records=Object.fromEntries(base.map(k=>[k,{}]));
 records[base[3]]={revision:3,approved_revision:2,completed:0,pending:'application-1'};
 records[plan(3)]={revision:3};records[plan(2)]={revision:2};records['central_fund_application/application-1']={revision:2};
 const read=async({member,keys})=>{assert.equal(member,null);calls.push(keys);const state={chain_id:chainId,height:'100',header_time:new Date(now()).toISOString(),records:Object.fromEntries(keys.map(k=>[k,records[k]??null]))};change(state,++reads);return state;};
 const reader=createFundSnapshotReader({selection:{get:()=>project},reader:{read},chainId,now});
 return {reader,calls};
}
test('reduced snapshot reads coherent current, approved and pending keys without operational capabilities',async()=>{
 const {reader,calls}=setup();assert.deepEqual(Object.keys(reader),['snapshot']);assert.ok(Object.isFrozen(reader));
 const v=await reader.snapshot(project.id);assert.equal(v.available,true);assert.equal(v.plan.revision,3);assert.equal(v.approvedPlan.revision,2);assert.equal(v.applications['application-1'].revision,2);assert.equal(v.tasks,null);assert.equal(calls.length,2);assert.equal(calls[1].length,7);
});
test('changed pending binding and missing explicit absence remain unavailable',async()=>{
 for(const alter of [(s,n)=>{if(n===2)s.records[base[3]].pending='other';},(s,n)=>{if(n===2)delete s.records[plan(2)];}]){
 const {reader}=setup(alter);const v=await reader.snapshot(project.id);assert.equal(v.available,false);assert.equal(v.proof,null);assert.equal(v.approvedPlan,null);
 }
});
