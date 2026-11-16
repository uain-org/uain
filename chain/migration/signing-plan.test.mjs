import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {buildSnapshot,TABLES} from './snapshot.mjs';
const m=await import('./signing-plan.mjs').catch(()=>({}));
function fixture(){
 const {publicKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({type:'spki',format:'der'}).subarray(-32),id='uain1'+createHash('sha256').update(raw).digest('hex').slice(0,40);
 const tables=Object.fromEntries(TABLES.map(t=>[t,[]]));tables.members=[{id,name:'Public fixture',public_key:raw.toString('base64url'),state:'active'}];tables.participants=[{id:'AG-fixture',member_id:id,name:'Public fixture',operator:'Fixture operator',model:'Fixture',state:'active',karma:'0',credits:'0',default_verifier_at:null,project_creator_at:null}];
 const snapshot=buildSnapshot(tables,{pinnedPublicKey:publicKey.export({type:'spki',format:'pem'})});
 const state={chain_id:'uain-shadow-20261008-1',height:'100',event_count:'0',member:{id,sequence:'0',licence:'active'},records:{guardians:[id],guardian_epoch_current:null,legacy_adoption:null,legacy_import:null,['legacy_account_claimed/'+id]:null}};
 return {snapshot,state,options:{epoch:'1'.repeat(32),nativeCheckpoint:{event_count:'0',last_command_digest:'',accounts_digest:'a'.repeat(64)}}};
}
test('public complete import batch authenticates pages and includes all account claims',()=>{
 assert.equal(typeof m.buildMigrationSigningPlan,'function');const f=fixture(),out=m.buildMigrationSigningPlan(f.snapshot,f.state,f.options),ops=out.commands.map(c=>c.operation);
 assert.equal(ops[0],'legacy_adopt');assert.equal(ops[1],'legacy_begin');assert.equal(ops.at(-2),'legacy_finish');assert.equal(ops.at(-1),'legacy_claim_account');
 assert.equal(out.commands[0].payload.records_root,f.snapshot.records_root);assert.ok(out.commands.some(c=>c.operation==='legacy_page'));
 assert.deepEqual(out.commands.map(c=>c.sequence),out.commands.map((_,i)=>String(i)));assert.equal(out.commands[0].expires_height,'820');
 assert.equal(JSON.stringify(out).includes('private_key'),false);
});
test('resume starts at the exact committed page cursor and native sequence',()=>{
 const f=fixture(),full=m.buildMigrationSigningPlan(f.snapshot,f.state,f.options),first=full.commands.find(c=>c.operation==='legacy_page'),count=first.payload.records.length;
 f.state.records.legacy_adoption=full.commands[0].payload;f.state.records.legacy_import={manifest_digest:f.snapshot.manifest_digest,records_root:f.snapshot.records_root,total_records:String(f.snapshot.records.length),accounts:'1',imported:String(count),claimed_accounts:'0',status:'importing'};f.state.member.sequence='3';f.state.event_count='3';
 const out=m.buildMigrationSigningPlan(f.snapshot,f.state,f.options);assert.equal(out.commands[0].sequence,'3');assert.equal(out.commands[0].operation,count===f.snapshot.records.length?'legacy_finish':'legacy_page');if(count<f.snapshot.records.length)assert.equal(out.commands[0].payload.start,String(count));
});
test('account-only continuation has no replayed import command',()=>{
 const f=fixture(),full=m.buildMigrationSigningPlan(f.snapshot,f.state,f.options);f.state.records.legacy_adoption=full.commands[0].payload;f.state.records.legacy_import={manifest_digest:f.snapshot.manifest_digest,records_root:f.snapshot.records_root,total_records:String(f.snapshot.records.length),accounts:'1',imported:String(f.snapshot.records.length),claimed_accounts:'0',status:'reconciling_accounts'};
 const out=m.buildMigrationSigningPlan(f.snapshot,f.state,f.options);assert.deepEqual(out.commands.map(c=>c.operation),['legacy_claim_account']);
});
test('changed source, missing claim proofs, wrong guardian/chain, bad epoch and too-short expiry refuse',()=>{
 for(const change of [f=>f.snapshot.records_root='f'.repeat(64),f=>delete f.state.records['legacy_account_claimed/'+f.state.member.id],f=>f.state.records.guardians=[],f=>f.state.chain_id='other',f=>f.options.epoch='../',f=>f.options.expiresHeight='105']){const f=fixture();change(f);assert.throws(()=>m.buildMigrationSigningPlan(f.snapshot,f.state,f.options));}
});

test('original-only ceremony refuses an unproved pointer or a completed guardian handover',()=>{
 for(const mutate of [s=>delete s.records.guardian_epoch_current,s=>s.records.guardian_epoch_current='00000000000000000042']){const f=fixture();mutate(f.state);assert.throws(()=>m.buildMigrationSigningPlan(f.snapshot,f.state,f.options),/guardian epoch absence/);}
});

test('fresh approved epoch after expiry keeps adopted source and emits only uncommitted commands',()=>{
 const f=fixture(),first=m.buildMigrationSigningPlan(f.snapshot,f.state,f.options);
 f.state.records.legacy_adoption=first.commands[0].payload;
 f.state.records.legacy_import={manifest_digest:f.snapshot.manifest_digest,records_root:f.snapshot.records_root,total_records:String(f.snapshot.records.length),accounts:'1',imported:String(f.snapshot.records.length),claimed_accounts:'0',status:'reconciling_accounts'};
 f.state.height='900';f.state.member.sequence=String(first.commands.length-1);f.state.event_count=f.state.member.sequence;
 const next=m.buildMigrationSigningPlan(f.snapshot,f.state,{...f.options,epoch:'2'.repeat(32)});
 assert.equal(next.epoch,'2'.repeat(32));assert.equal(next.commands[0].expires_height,'1620');assert.equal(next.commands[0].sequence,f.state.member.sequence);
 assert.deepEqual(next.commands.map(c=>c.operation),['legacy_claim_account']);assert.equal(next.commands[0].payload.member,f.state.member.id);
 f.state.records['legacy_account_claimed/'+f.state.member.id]={claimed:true};f.state.records.legacy_import.claimed_accounts='1';
 assert.throws(()=>m.buildMigrationSigningPlan(f.snapshot,f.state,{...f.options,epoch:'3'.repeat(32)}),/nothing remains/);
});
