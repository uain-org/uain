// Execute an already approved, publicly signed migration batch. No signing key
// enters this module. Native finality proofs, rather than CheckTx, advance it.
import assert from 'node:assert/strict';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {canonicalJSON,memberAddress,signingBytes} from '../client/signing.mjs';
import {readFederationState,findFederationReceipt} from '../client/federation-workflow.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const decimal=v=>{assert.ok(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v),'canonical decimal required');return BigInt(v)};
const operations=new Set(['legacy_adopt','legacy_begin','legacy_page','legacy_finish','legacy_claim_account']);
function batch(plan,approval,signed){
 assert.ok(Buffer.isBuffer(plan)&&plan.length<=64*1024*1024,'bounded exact public plan bytes required');
 assert.match(approval.epoch??'',/^[a-f0-9]{32}$/);assert.equal(sha(plan),approval.plan_sha256,'public plan changed');
 const p=JSON.parse(plan);assert.equal(p.schema,'uain-native-migration-signing-v1');assert.equal(p.epoch,approval.epoch);
 assert.equal(signed.schema,'uain-native-migration-envelopes-v1');assert.equal(signed.epoch,p.epoch);assert.equal(signed.plan_sha256,approval.plan_sha256);
 assert.ok(Array.isArray(p.commands)&&p.commands.length>=1&&p.commands.length<=1024);assert.equal(signed.envelopes?.length,p.commands.length);
 assert.match(approval.guardian_public_key??'',/^[A-Za-z0-9_-]{43}$/);
 const raw=Buffer.from(approval.guardian_public_key,'base64url');assert.equal(raw.length,32);assert.equal(raw.toString('base64url'),approval.guardian_public_key);
 assert.equal(memberAddress(raw),approval.guardian,'guardian public identity differs');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'}),start=decimal(approval.starting_sequence);
 const expiry=p.commands[0].expires_height;decimal(approval.expected_event_count);
 for(let i=0;i<p.commands.length;i++){
  const c=p.commands[i],e=signed.envelopes[i];
  assert.equal(canonicalJSON(e.command),canonicalJSON(c),'signed command differs from approved plan');
  assert.equal(c.chain_id,'uain-shadow-20261008-1');assert.equal(c.member,approval.guardian);assert.equal(c.sequence,String(start+BigInt(i)));assert.equal(c.expires_height,expiry);
  assert.ok(operations.has(c.operation)&&!Object.hasOwn(c,'instance'),'migration-only command required');
  assert.deepEqual(Object.keys(e).sort(),['command','public_key','signature']);assert.equal(e.public_key,approval.guardian_public_key);assert.match(e.signature??'',/^[A-Za-z0-9_-]{86}$/);
  const signature=Buffer.from(e.signature,'base64url');assert.equal(signature.length,64);assert.equal(signature.toString('base64url'),e.signature);
  assert.ok(verify(null,signingBytes(c),key,signature),'migration envelope signature refused');assert.ok(Buffer.byteLength(JSON.stringify(e))<=65536,'bounded signed envelope required');
 }
 return structuredClone(signed.envelopes);
}
async function broadcast(rpc,envelope){
 const url=new URL(rpc);assert.ok(!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)),'pinned HTTPS or operator loopback RPC required');
 const bytes=Buffer.from(JSON.stringify(envelope));
 const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'broadcast_tx_sync',params:{tx:bytes.toString('base64')}})});
 assert.equal(response.ok,true,'native broadcast HTTP refused');const parts=[];let size=0;
 for await(const part of response.body){size+=part.length;assert.ok(size<=65536,'bounded broadcast response required');parts.push(part);}
 const out=JSON.parse(Buffer.concat(parts).toString());assert.ok(!out.error&&out.result,'native broadcast RPC refused');return out.result;
}
export async function submitMigrationBatch({plan,approval,signed,reader,persist,maxPolls=120,deps={}}){
 assert.equal(approval.genesis_sha256,'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff','original approved genesis required');
 assert.equal(reader?.genesisSha256,approval.genesis_sha256,'receipt reader genesis differs from custody approval');
 assert.match(approval.state_binary_sha256??'',/^[a-f0-9]{64}$/);
 assert.equal(reader?.executableSha256,approval.state_binary_sha256,'receipt verifier differs from custody approval');
 const envelopes=batch(plan,approval,signed);assert.ok(Number.isInteger(maxPolls)&&maxPolls>=1&&maxPolls<=300,'bounded finality polling required');
 const read=deps.readState??(()=>readFederationState({...reader,request:{member:approval.guardian,keys:['guardians','guardian_epoch_current']}}));
 const submit=deps.broadcast??(e=>broadcast(reader.rpc,e));const find=deps.findReceipt??(args=>findFederationReceipt({reader,...args}));
 const save=deps.persist??persist;assert.equal(typeof save,'function','durable public receipt persistence required');const sleep=deps.sleep??delay;
 let cursor=approval.expected_event_count,completed=0;
 for(const envelope of envelopes){
  const command=envelope.command,state=await read(),sequence=decimal(state.member?.sequence),expected=decimal(command.sequence);
  assert.equal(state.chain_id,command.chain_id,'proved native chain differs');assert.equal(state.member.id,approval.guardian);assert.equal(state.member.public_key,approval.guardian_public_key);assert.equal(state.member.licence,'active');assert.ok(state.records.guardians.includes(approval.guardian));
  assert.ok(Object.hasOwn(state.records,'guardian_epoch_current')&&state.records.guardian_epoch_current===null,'proved original guardian epoch absence required');
  assert.ok(sequence>=expected&&sequence<=decimal(approval.starting_sequence)+BigInt(envelopes.length),'unexplained native sequence');
  const alreadyCommitted=sequence>expected;
  if(!alreadyCommitted){
   assert.ok(decimal(state.height)<decimal(command.expires_height),'signed migration batch expired');
   const result=await submit(envelope);assert.equal(result.code,0,'native CheckTx refused migration');assert.equal(result.hash?.toLowerCase(),sha(JSON.stringify(envelope)),'native broadcast hash differs');
  }
  let receipt;
  for(let poll=0;poll<maxPolls;poll++){
   receipt=await find({envelope,afterEvent:cursor,maxEvents:128});
   if(receipt.finalized)break;
   const next=decimal(receipt.scanned_through);assert.ok(next>=decimal(cursor),'receipt cursor regressed');cursor=String(next);
   if(!receipt.more)await sleep(500);
  }
  assert.equal(receipt?.finalized,true,'migration finality not proved; reconcile before retry');
  const event=receipt.event;assert.equal(event.command_digest,sha(signingBytes(command)),'finalized migration digest differs');assert.equal(event.member,command.member);assert.equal(event.operation,command.operation);
  assert.ok(decimal(event.id)>decimal(cursor),'finalized event cursor did not advance');cursor=event.id;
  await save({index:completed,already_committed:alreadyCommitted,envelope,receipt});completed++;
 }
 return {finalized:true,completed,scanned_through:cursor,epoch:approval.epoch,private_keys_accessed:false};
}
