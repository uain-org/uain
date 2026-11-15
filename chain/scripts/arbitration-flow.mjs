// Fictional two-node arbitration qualification. Keys stay in this process.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function exerciseArbitration({root,homes,ports,rpc,submit,envelope,author,arbiter,guardian,waitFor,fullnode,proofBinary}) {
 const values=new Map(),evidence='a'.repeat(64),project='compact-project',task='arbitration-task',answer='arbitration-answer';
 const searches=['isolated arbitration prior-art search one','isolated arbitration prior-art search two'];
 async function query(port,key,height='0',prove=false){return (await rpc(port,'abci_query',{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:String(height),prove})).response;}
 async function read(key){const q=await query(ports[0],key);assert.ok(q.value,'missing '+key);return JSON.parse(Buffer.from(q.value,'base64'));}
 async function send(actor,op,payload){const m=await read('member/'+actor.member.id);return submit(actor,m.sequence,op,payload);}
 async function refuse(actor,op,payload){const before=await read('member/'+actor.member.id),result=await rpc(ports[0],'broadcast_tx_sync',{tx:envelope(before.sequence,op,payload,actor)});assert.notEqual(result.code,0,'forbidden '+op+' accepted');assert.deepEqual(await read('member/'+actor.member.id),before);}
 const activation=await send(guardian,'activate_arbitration',{policy:'bounded-research-arbitration-v1',evidence_digest:evidence});
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>Number(activation.height)+1);
 await send(guardian,'arbiter_appoint',{member:arbiter.member.id,active:true,evidence_digest:evidence});
 await send(guardian,'allocate_budget',{project,credits:'100',evidence_digest:evidence});
 await send(author,'open_task',{id:task,project,title:'Fictional arbitration research',class:'benevolent',prior_art:{basis:'This is a disposable fictional research and arbitration qualification.',searches},criteria:'Independently resolve this fictional result and retain all ruling evidence.',kind:'instant',karma_reward:100,credit_reward:'100',verifiers_required:2});
 await send(author,'submit',{id:answer,task,evidence_digest:evidence});
 const check={contribution:answer,verdict:'dispute',novelty:'new',searches,evidence_digest:evidence};
 await send(guardian,'verify',check);
 const contested=await read('contribution/'+answer),oldCheck=contested.verifications[0];assert.equal(contested.state,'contested');
 const ruling={...check,verdict:'confirm',known_source:'',no_effort:false};
 await refuse(author,'arbitrate',ruling);await refuse(guardian,'arbitrate',ruling);
 const verdict=await send(arbiter,'arbitrate',ruling);
 const awaiting=await read('contribution/'+answer);assert.equal(awaiting.state,'held');assert.equal(awaiting.settlement,undefined);
 await refuse(arbiter,'arbitrate',ruling);
 const originalGuardian=await read('member/'+guardian.member.id);
 const settled=await send(guardian,'verify',{...check,verdict:'confirm'});
 const current=await read('contribution/'+answer);assert.equal(current.state,'settled');assert.equal(current.verifications.length,3);assert.equal(current.verifications[2].reconsiders,oldCheck.record_digest);assert.equal(current.settlement.paid,true);
 assert.equal((await read('member/'+guardian.member.id)).karma,originalGuardian.karma);
 const finalization=await read('arbitration_finalization/'+answer);assert.equal(finalization.penalized.length,0);assert.equal(finalization.reconsidered.length,1);
 const height=Number(settled.height)+1;
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>height+1,fullnode);
 const commit=await rpc(ports[0],'commit',{height:String(height+1)});
 const keys=['arbitration_activation','arbitration/'+answer,'arbitration_finalization/'+answer,'contribution/'+answer,'task/'+task,'task_metadata/'+task,'project/'+project,'project_metadata/'+project,...current.verifications.flatMap(v=>['verification_evidence/'+answer+'/'+v.record_digest,'verification_summary/'+answer+'/'+v.record_digest])];
 let verified=0;
 for(const key of keys){
  const a=await query(ports[0],key,height,true),b=await query(ports[1],key,height,true);assert.equal(a.code,0);assert.equal(b.code,0);assert.equal(a.value,b.value);values.set(key,a.value);
  const file=join(root,'arbitration-proof-'+verified+'.json');await writeFile(file,JSON.stringify({signed_header:commit.signed_header,query:a}));
  const result=await new Promise((resolve,reject)=>{const child=spawn(proofBinary,['--genesis',join(homes[0],'config/genesis.json'),'--bundle',file,'--key',key],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});
  assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes('STATE_PROOF_VERIFIED'));verified++;
 }
 const decisionBytes=Buffer.from(values.get('arbitration/'+answer),'base64');assert.equal(createHash('sha256').update(decisionBytes).digest('hex'),current.arbitration_digest);
 assert.equal(JSON.parse(decisionBytes).height,verdict.height);
 return {values,receipt:{policy:'bounded-research-arbitration-v1',two_nodes:true,verified_signed_header_records:verified,author_and_disputer_refused:true,repeated_ruling_refused:true,default_oversight_required:true,original_dispute_retained:true,default_reconsideration_unpenalized:true,decision_digest_verified:true,height,production_activated:false}};
}
