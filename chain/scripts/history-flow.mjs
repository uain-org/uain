// Disposable native-node fixture. These identities and journals never enter
// production; the verifier receives only public genesis, headers and records.
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';

export async function exerciseRecipientHistory({root,homes,ports,rpc,submit,actor,owners,waitFor,fullnode,proofBinary}) {
 const values=new Map();
 let signedCommands=0;
 async function query(port,key,height='0',prove=false){return (await rpc(port,'abci_query',{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:String(height),prove})).response;}
 async function read(key){const q=await query(ports[0],key);return q.value?JSON.parse(Buffer.from(q.value,'base64')):null;}
 const originalActor=await read('member/'+actor.member.id);
 async function send(op,payload){const m=await read('member/'+actor.member.id);const result=await submit(actor,m.sequence,op,payload);signedCommands++;return result;}
 const activation=await send('activate_recipient_history',{policy:'recipient-history-v1',evidence_digest:'a'.repeat(64)});
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>Number(activation.height)+1);
 for(const kind of ['credit','karma']) {
  for(let i=0;i<100;i++){
   const head=await read(kind+'_count')??0,progress=await read('recipient_history_progress/'+kind);
   if(BigInt(progress?.cursor??0)===BigInt(head))break;
   await send('recipient_history_page',{kind});
   if(i===99)throw Error('fixture history backfill did not catch up');
  }
 }
 const height=Number((await rpc(ports[0],'status')).sync_info.latest_block_height);
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>height+1,fullnode);
 const commit=await rpc(ports[0],'commit',{height:String(height+1)});
 async function pair(key){const a=await query(ports[0],key,height,true),b=await query(ports[1],key,height,true);assert.equal(a.code,0);assert.equal(b.code,0);assert.equal(a.value,b.value);values.set(key,a.value);return a;}
 async function verify(file,kind,owner,instance='',success=true){
  const args=['--genesis',join(homes[0],'config/genesis.json'),'--bundle',file,'--history-kind',kind,'--history-member',owner,'--history-page','0'];if(instance)args.push('--history-instance',instance);
  const result=await new Promise((resolve,reject)=>{const child=spawn(proofBinary,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});
  assert.equal(result.code,success?0:1,result.stderr);return success?JSON.parse(result.stdout.trim()):null;
 }
 const actorRecord=await pair('member/'+actor.member.id);
 const currentActor=JSON.parse(Buffer.from(actorRecord.value,'base64'));
 assert.equal(BigInt(currentActor.sequence),BigInt(originalActor.sequence)+BigInt(signedCommands));
 assert.deepEqual({...currentActor,sequence:originalActor.sequence},originalActor);
 let checked=0;
 for(const {member,instance=''} of owners)for(const kind of ['credit','karma']){
  const prefix='recipient_history/'+kind+'/'+(instance?'instance/'+member+'/'+instance:'member/'+member);
  const keys=['recipient_history_activation',kind+'_count','recipient_history_progress/'+kind,prefix+'/count',prefix+'/page/00000000000000000000'];
  const queries=[];for(const key of keys)queries.push(await pair(key));
  const page=queries[4].value?JSON.parse(Buffer.from(queries[4].value,'base64')):{ids:[]};
  for(const id of page.ids)queries.push(await pair(kind+'/'+id));
  const file=join(root,'history-'+checked+'.json');await writeFile(file,JSON.stringify({signed_header:commit.signed_header,queries}));
  const view=await verify(file,kind,member,instance);assert.equal(view.complete,true);assert.equal(view.entries.length,page.ids.length);assert.equal(view.indexed_through,view.journal_head);
  const omitted=join(root,'history-omitted-'+checked+'.json');await writeFile(omitted,JSON.stringify({signed_header:commit.signed_header,queries:queries.filter((_,i)=>i!==1)}));await verify(omitted,kind,member,instance,false);
  await verify(file,kind,'wrong-member',instance,false);
  await verify(file,kind,member,instance?'wrong-child':'wrong-instance',false);checked++;
 }
 return {values,receipt:{policy:'recipient-history-v1',two_nodes:true,signed_header_offline_cli:true,verified_pages:checked,verified_matching_records:values.size,missing_dependency_refused:true,cross_recipient_refused:true,backfill_caught_up:true,height}};
}
