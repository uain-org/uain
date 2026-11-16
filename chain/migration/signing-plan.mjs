// Public import-plan construction only. This module never accepts a private key,
// signs a command, writes an approval or submits a transaction.
import assert from 'node:assert/strict';
import {verifyMigrationPlan,migrationPage} from './plan.mjs';
import {signingBytes} from '../client/signing.mjs';
const decimal=v=>{assert.ok(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v),'canonical decimal context required');return BigInt(v)};
export function buildMigrationSigningPlan(snapshot,state,{epoch,nativeCheckpoint,expiresHeight}={}){
 assert.match(epoch??'',/^[a-f0-9]{32}$/,'exact public approval epoch required');
 const source=verifyMigrationPlan(snapshot),records=structuredClone(state.records??{}),member=state.member;
 assert.equal(state.chain_id,'uain-shadow-20261008-1','original native chain required');
 assert.ok(member&&member.licence==='active'&&records.guardians?.includes(member.id),'proven original guardian required');
 assert.ok(Object.hasOwn(records,'guardian_epoch_current')&&records.guardian_epoch_current===null,'proved original guardian epoch absence required');
 const members=source.reconciliation.members.map(m=>m.id);assert.ok(members.length>=1&&members.length<=20,'reviewed keyed-account bound');
 assert.ok(members.includes(member.id),'guardian must own a keyed source account');
 for(const id of members)assert.ok(Object.hasOwn(records,'legacy_account_claimed/'+id),'explicit account claim inclusion/absence proof required');
 const base={manifest_digest:source.manifest_digest,records_root:source.records_root,total_records:String(source.records.length),accounts:String(members.length),ledger_head:source.reconciliation.ledger.head,last_event_id:source.reconciliation.ledger.last_event_id};
 const height=decimal(state.height),expiry=expiresHeight===undefined?height+720n:decimal(expiresHeight),sequence=decimal(member.sequence),commands=[];
 assert.ok(expiry>height&&expiry<=height+720n&&expiry<=9223372036854775807n,'bounded future command expiration required');
 const add=(operation,payload)=>{const command={version:1,chain_id:state.chain_id,member:member.id,sequence:String(sequence+BigInt(commands.length)),expires_height:String(expiry),operation,payload};signingBytes(command);assert.ok(Buffer.byteLength(JSON.stringify(command))<65000,'bounded public command required');commands.push(command);assert.ok(commands.length<=1024,'bounded migration batch required')};
 const adoption=records.legacy_adoption;
 if(adoption){
  for(const key of Object.keys(base))assert.equal(adoption[key],base[key],'different adopted source');
  assert.deepEqual(adoption.native_checkpoint,nativeCheckpoint,'different original native checkpoint');
 }else{
  assert.equal(records.legacy_import??null,null,'import without original-chain adoption refused');
  assert.ok(nativeCheckpoint&&/^[0-9a-f]{64}$/.test(nativeCheckpoint.accounts_digest),'reviewed native checkpoint required');
  assert.equal(nativeCheckpoint.event_count,state.event_count,'native adoption event cursor drifted');
  add('legacy_adopt',{...base,pinned_public_key:source.pinned_public_key,native_checkpoint:nativeCheckpoint});
 }
 const imported=records.legacy_import;let cursor=0,claimedCount=0,phase='importing';
 if(imported){
  for(const key of ['manifest_digest','records_root','total_records','accounts'])assert.equal(imported[key],base[key],'different active source import');
  const importedCount=decimal(imported.imported);assert.ok(importedCount<=BigInt(source.records.length),'import cursor beyond approved source');cursor=Number(importedCount);
  const claimed=decimal(imported.claimed_accounts);assert.ok(claimed<=BigInt(members.length),'claimed account count beyond source');claimedCount=Number(claimed);phase=imported.status;
  assert.ok(['importing','reconciling_accounts'].includes(phase),'ready/unsupported migration cannot be signed');
 }else add('legacy_begin',base);
 if(phase==='importing'){
  assert.equal(claimedCount,0,'accounts claimed before full import');
  while(cursor<source.records.length){const rows=migrationPage(source,cursor);add('legacy_page',{start:String(cursor),records:rows});cursor+=rows.length;}
  add('legacy_finish',{});
 }else assert.equal(cursor,source.records.length,'incomplete account reconciliation source');
 const remaining=members.filter(id=>records['legacy_account_claimed/'+id]===null);
 assert.equal(remaining.length,members.length-claimedCount,'proved account claim count differs');
 for(const id of remaining)add('legacy_claim_account',{member:id});
 assert.ok(commands.length>0,'nothing remains to sign');
 assert.ok(height+BigInt(commands.length)+10n<expiry,'insufficient command completion margin');
 assert.ok(sequence+BigInt(commands.length)<=18446744073709551615n,'native sequence overflow');
 return{schema:'uain-native-migration-signing-v1',epoch,commands};
}
