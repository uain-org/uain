import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {memberAddress,signedEnvelope,signingBytes} from '../client/signing.mjs';
import {mkdtemp,open,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {writePublicArtifact,migrationReceiptArtifact} from './public-artifact.mjs';
const m=await import('./submit.mjs').catch(()=>({}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({type:'spki',format:'der'}).subarray(-32),member=memberAddress(raw),epoch='a'.repeat(32);
 const commands=['legacy_finish','legacy_claim_account'].map((operation,i)=>({version:1,chain_id:'uain-shadow-20261008-1',member,sequence:String(i),expires_height:'800',operation,payload:i?{member}:{}}));
 const plan=Buffer.from(JSON.stringify({schema:'uain-native-migration-signing-v1',epoch,commands}));
 const approval={epoch,guardian:member,guardian_public_key:raw.toString('base64url'),plan_sha256:sha(plan),starting_sequence:'0',expected_event_count:'0',genesis_sha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',state_binary_sha256:'b'.repeat(64)};
 const reader={genesisSha256:approval.genesis_sha256,executableSha256:approval.state_binary_sha256};
 const signed={schema:'uain-native-migration-envelopes-v1',epoch,plan_sha256:approval.plan_sha256,envelopes:commands.map(c=>signedEnvelope(c,raw,privateKey))};
 let sequence=0n,events=0n;const sent=[],persisted=[];
 const deps={readState:async()=>({chain_id:commands[0].chain_id,height:'100',event_count:String(events),member:{id:member,public_key:raw.toString('base64url'),sequence:String(sequence),licence:'active'},records:{guardians:[member],guardian_epoch_current:null}}),broadcast:async envelope=>{sent.push(envelope);return {code:0,hash:sha(JSON.stringify(envelope)).toUpperCase()}},findReceipt:async({envelope})=>{const seq=BigInt(envelope.command.sequence);if(sequence===seq){sequence++;events++;}return {finalized:true,event:{id:String(seq+1n),command_digest:sha(signingBytes(envelope.command)),member,operation:envelope.command.operation},scanned_through:String(seq+1n)}},persist:async r=>persisted.push(r),sleep:async()=>{}};
 return {plan,approval,signed,reader,deps,sent,persisted,advance:()=>{sequence=1n;events=1n;}};
}
test('presigned migration waits for exact finalized effects before the next command',async()=>{
 assert.equal(typeof m.submitMigrationBatch,'function');const f=fixture();const r=await m.submitMigrationBatch(f);
 assert.equal(r.finalized,true);assert.equal(f.sent.length,2);assert.equal(f.persisted.length,2);assert.equal(r.completed,2);
});
test('restart proves previously committed envelope without rebroadcasting it',async()=>{
 const f=fixture();f.advance();const r=await m.submitMigrationBatch(f);assert.equal(r.completed,2);assert.equal(f.sent.length,1);assert.equal(f.sent[0].command.sequence,'1');assert.equal(f.persisted[0].already_committed,true);
});
test('altered plan, signature, operation and sequence refuse before submission',async()=>{
 for(const change of [f=>f.plan=Buffer.from('{}'),f=>f.signed.envelopes[0].signature='x'.repeat(86),f=>f.signed.envelopes[0].command.operation='funding_activate',f=>f.signed.envelopes[1].command.sequence='3']){const f=fixture();change(f);await assert.rejects(()=>m.submitMigrationBatch(f));assert.equal(f.sent.length,0);}
});
test('wrong chain, expired batch and unexplained sequence refuse before submission',async()=>{
 for(const patch of [{chain_id:'elsewhere'},{height:'800'},{member:{sequence:'3'}}]){const f=fixture(),read=f.deps.readState;f.deps.readState=async()=>{const s=await read();return {...s,...patch,member:{...s.member,...patch.member}}};await assert.rejects(()=>m.submitMigrationBatch(f));assert.equal(f.sent.length,0);}
});
test('fork genesis and alternate verifier refuse before any public state or broadcast',async()=>{
 for(const field of ['genesisSha256','executableSha256']){const f=fixture();f.reader[field]='c'.repeat(64);let reads=0;f.deps.readState=async()=>{reads++;throw Error('reader must not run')};await assert.rejects(()=>m.submitMigrationBatch(f),/differs from custody approval/);assert.equal(reads,0);assert.equal(f.sent.length,0);}
});
test('CheckTx failure and substituted finality never advance or persist progress',async()=>{
 for(const mode of ['checktx','digest','pending']){const f=fixture();if(mode==='checktx')f.deps.broadcast=async()=>({code:1,hash:'0'.repeat(64)});else if(mode==='digest'){const find=f.deps.findReceipt;f.deps.findReceipt=async args=>({...await find(args),event:{command_digest:'0'.repeat(64)}});}else f.deps.findReceipt=async()=>({finalized:false,scanned_through:'0'});
 await assert.rejects(()=>m.submitMigrationBatch({...f,maxPolls:2}));assert.equal(f.persisted.length,0);assert.ok(f.sent.length<=1);}
});

test('submission requires proved original guardian epoch absence before broadcast',async()=>{
 for(const missing of [true,false]){const f=fixture(),read=f.deps.readState;f.deps.readState=async()=>{const s=await read();if(missing)delete s.records.guardian_epoch_current;else s.records.guardian_epoch_current='00000000000000000042';return s};await assert.rejects(()=>m.submitMigrationBatch(f),/guardian epoch absence/);assert.equal(f.sent.length,0);}
});

test('real fsynced receipt interruption resumes without rebroadcast and preserves exact artifact',async()=>{
 const f=fixture(),dir=await mkdtemp(join(process.cwd(),'.migration-submit-'));await chmod(dir,0o700);let interrupted=false;
 try{
  f.deps.persist=async item=>{const path=join(dir,String(item.index)+'.json'),value=migrationReceiptArtifact(item);
   if(!interrupted){interrupted=true;const fd=await open(path+'.pending','wx',0o600);try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}throw Error('simulated power loss after pending fsync');}
   await writePublicArtifact(path,value);
  };
  await assert.rejects(()=>m.submitMigrationBatch(f),/power loss/);assert.equal(f.sent.length,1);
  const expected=await readFile(join(dir,'0.json.pending'));const out=await m.submitMigrationBatch(f);
  assert.equal(out.completed,2);assert.equal(f.sent.length,2);assert.equal(f.sent[1].command.sequence,'1');assert.deepEqual(await readFile(join(dir,'0.json')),expected);
  await m.submitMigrationBatch(f);assert.equal(f.sent.length,2);assert.deepEqual(await readFile(join(dir,'0.json')),expected);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('expired partial batch re-proves committed effects but cannot broadcast its remaining suffix',async()=>{
 const f=fixture();f.advance();const read=f.deps.readState;f.deps.readState=async()=>({...await read(),height:'800'});
 await assert.rejects(()=>m.submitMigrationBatch(f),/expired/);assert.equal(f.persisted.length,1);assert.equal(f.persisted[0].already_committed,true);assert.equal(f.sent.length,0);
});
