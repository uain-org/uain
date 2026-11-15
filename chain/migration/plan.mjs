import assert from 'node:assert/strict';
import {buildSnapshot,stableJSON} from './snapshot.mjs';

// Rebuild the complete plan before presenting any command for local/custody
// signing. Public plan files never contain or request a member private key.
export function verifyMigrationPlan(snapshot){
 const expected=buildSnapshot(snapshot.tables,{pinnedPublicKey:snapshot.pinned_public_key,publicPolicy:snapshot.public_policy});
 for(const field of ['manifest_digest','records_root','records','proofs','reconciliation'])assert.equal(stableJSON(snapshot[field]),stableJSON(expected[field]),`migration ${field} differs from verified source`);
 return expected;
}
export function migrationPage(plan,start){
 const records=[];let bytes=0;
 for(let i=start;i<plan.records.length&&records.length<16;i++){
  const row={...plan.records[i],proof:plan.proofs[i]},size=Buffer.byteLength(row.value);
  if(bytes+size>24*1024||Buffer.byteLength(JSON.stringify({start:String(start),records:[...records,row]}))>48*1024)break;
  records.push(row);bytes+=size;
 }
 assert.ok(records.length,'source record cannot fit bounded migration page');return records;
}
export function nextMigrationCommand(snapshot,state,{nativeCheckpoint}={}){
 const plan=verifyMigrationPlan(snapshot),records=state.records??{};
 const base={manifest_digest:plan.manifest_digest,records_root:plan.records_root,total_records:String(plan.records.length),accounts:String(plan.reconciliation.members.length),ledger_head:plan.reconciliation.ledger.head,last_event_id:plan.reconciliation.ledger.last_event_id};
 const imported=records.legacy_import,adoption=records.legacy_adoption;
 if(!imported){
  if(adoption){assert.equal(adoption.manifest_digest,base.manifest_digest,'different existing-chain adoption');return{operation:'legacy_begin',payload:base}}
  const legacy=records.legacy;
  if(legacy?.manifest_digest===base.manifest_digest)return{operation:'legacy_begin',payload:base};
  assert.ok(nativeCheckpoint&&/^[0-9a-f]{64}$/.test(nativeCheckpoint.accounts_digest),'reviewed exact native checkpoint required for existing-chain adoption');
  return{operation:'legacy_adopt',payload:{...base,pinned_public_key:plan.pinned_public_key,native_checkpoint:nativeCheckpoint}};
 }
 assert.equal(imported.manifest_digest,base.manifest_digest,'different active migration');assert.equal(imported.records_root,base.records_root,'different approved record root');
 if(imported.status==='importing'){
  const start=Number(imported.imported);assert.ok(Number.isSafeInteger(start)&&start>=0&&start<=plan.records.length,'invalid committed import cursor');
  if(start===plan.records.length)return{operation:'legacy_finish',payload:{}};
  return{operation:'legacy_page',payload:{start:String(start),records:migrationPage(plan,start)}};
 }
 if(imported.status==='reconciling_accounts'){
  for(const account of plan.reconciliation.members){const key=`legacy_account_claimed/${account.id}`;assert.ok(Object.hasOwn(records,key),'independently proven account-claim status required');if(records[key]===null)return{operation:'legacy_claim_account',payload:{member:account.id}}}
  throw Error('all accounts claimed but native import not ready');
 }
 assert.equal(imported.status,'ready','unsupported migration state');return null;
}
