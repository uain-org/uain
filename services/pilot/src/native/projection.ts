import {createHash} from 'node:crypto';
import type pg from 'pg';
import {nativeState,nativeConfig} from '../api/native-routes.ts';
import {evidenceDocument} from './evidence.ts';
import {retainPublicationReplica} from './replica.ts';
type Config=NonNullable<ReturnType<typeof nativeConfig>>;
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const id=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(s);
const eventKey=(n:bigint)=>'event/'+String(n).padStart(20,'0');
const WORK_EVENTS=['submit','verify','arbitrate','close_arbitration','appeal_arbitration','resolve_appeal','legacy_submit','legacy_check','legacy_settle','legacy_future_apply','legacy_release'];
async function read(config:Config,keys:string[]=[],signal?:AbortSignal){return nativeState({keys},config,{signal})}
async function epoch(client:pg.PoolClient,config:Config,state:any){
 const name=config.genesisHash;
 await client.query('INSERT INTO native_epochs(epoch,chain_id,genesis_sha256) VALUES($1,$2,$1) ON CONFLICT DO NOTHING',[name,state.chain_id]);
 const row=(await client.query('SELECT * FROM native_epochs WHERE epoch=$1',[name])).rows[0];
 if(!row||row.chain_id!==state.chain_id||row.retired_at)throw Error('native epoch is missing, retired or belongs to another chain');return row;
}
async function queue(client:pg.PoolClient,epoch:string,key:string,event:string){
 if(!id(key))throw Error('invalid native projection ID');
 await client.query('INSERT INTO native_projection_queue(epoch,id,event_id) VALUES($1,$2,$3) ON CONFLICT(epoch,id) DO UPDATE SET event_id=EXCLUDED.event_id',[epoch,key,event]);
}
async function originalRow(config:Config,table:string,key:string){
 const proofs:any[]=[],base=`legacy/row/${table}/${key}`,first=await read(config,[base]);proofs.push(first);const value=first.records[base];
 if(!value)throw Error('original row absent from native archive');
 const checked=(value:any)=>{const ids=JSON.parse(Buffer.from(key,'base64url').toString('utf8'));if(value.table!==table||!value.row||!Array.isArray(ids)||ids.length!==1||String(value.row.id)!==ids[0])throw Error('original row identity mismatch');return value.row};
 if(value.row)return{row:checked(value),proofs};
 if(!Number.isInteger(value.parts)||value.parts<1||value.parts>210||!/^[a-f0-9]{64}$/.test(value.row_sha256))throw Error('invalid original row chunks');
 const parts:Buffer[]=[];for(let at=0;at<value.parts;at+=32){const keys=Array.from({length:Math.min(32,value.parts-at)},(_,i)=>`legacy/chunk/${table}/${key}/${String(at+i).padStart(6,'0')}`),state=await read(config,keys);proofs.push(state);
  for(const k of keys){const b=state.records[k];if(typeof b!=='string'||b.length>14000)throw Error('original row chunk absent/oversized');parts.push(Buffer.from(b,'base64'))}
 }
 const raw=Buffer.concat(parts);if(raw.length>2*1024*1024||sha(raw)!==value.row_sha256)throw Error('original row bytes differ from commitment');
 const parsed=JSON.parse(raw.toString('utf8'));return{row:checked(parsed),proofs};
}
async function legacyCatalog(config:Config){
 const first=await read(config,['legacy/catalog/contributions/00000000']),meta=first.records['legacy/catalog/contributions/00000000'];
 if(!meta)return[];if(!Number.isSafeInteger(meta.total)||meta.total<0||meta.total>100000)throw Error('invalid original contribution census');
 const ids:string[]=[];for(let at=0;at<Math.ceil(meta.total/32);at+=32){const keys=Array.from({length:Math.min(32,Math.ceil(meta.total/32)-at)},(_,i)=>`legacy/catalog/contributions/${String(at+i).padStart(8,'0')}`),s=await read(config,keys);
  for(const key of keys){const page=s.records[key];if(page?.table!=='contributions'||page.total!==meta.total||!Array.isArray(page.rows)||page.rows.length>32)throw Error('original contribution catalog mismatch');for(const encoded of page.rows){const raw=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));if(!Array.isArray(raw)||raw.length!==1||!id(raw[0]))throw Error('invalid original contribution key');ids.push(raw[0])}}
 }if(ids.length!==meta.total||new Set(ids).size!==ids.length)throw Error('incomplete original contribution catalog');return ids;
}
// Every input is read afresh through the pinned process. Caller/indexer JSON
// cannot substitute a proven event or advance this transactional cursor.
export async function syncNativeProjection(pool:pg.Pool,config:Config,limit=16,{nonblocking=false,signal}:{nonblocking?:boolean;signal?:AbortSignal}={}){
 signal?.throwIfAborted();
 if(!Number.isInteger(limit)||limit<1||limit>32)throw Error('bounded native projection batch required');
 const client=await pool.connect();let locked=false;
 const abort=()=>{void client.end().catch(()=>{})};
 try{
  signal?.throwIfAborted();
  if(nonblocking)signal?.addEventListener('abort',abort,{once:true});
  if(nonblocking){locked=!!(await client.query('SELECT pg_try_advisory_lock(4202625) AS locked')).rows[0]?.locked;if(!locked)return{busy:true,more:true}}
  else{await client.query('SELECT pg_advisory_lock(4202625)');locked=true}
  if(nonblocking){await client.query("SET statement_timeout='2s'");await client.query("SET lock_timeout='1s'")}
  const latest=await read(config,[],signal);signal?.throwIfAborted();const row=await epoch(client,config,latest),start=BigInt(row.cursor),count=BigInt(latest.event_count);
  if(start>count)throw Error('native chain regressed; new epoch/restore review required');
  const end=start+BigInt(limit)<count?start+BigInt(limit):count,keys:string[]=[];for(let i=start+1n;i<=end;i++)keys.push(eventKey(i));
  if(keys.length){const snapshot=await read(config,keys,signal);if(snapshot.chain_id!==row.chain_id)throw Error('projection chain changed');
   if(nonblocking&&keys.some(key=>['legacy_adopt','legacy_begin','legacy_page','legacy_finish'].includes(snapshot.records[key]?.operation)))return{busy:false,deferred:true,more:true};
   const bootstrap:string[]=[],tasks=new Map<string,string>();for(const key of keys){const e=snapshot.records[key];if(e?.operation==='legacy_finish')bootstrap.push(...await legacyCatalog(config));
    if(WORK_EVENTS.includes(e?.operation)){if(!id(e.subject))throw Error('invalid native work event');const s=await read(config,['contribution/'+e.subject,'legacy_work/'+e.subject,'legacy/work/'+e.subject],signal);const v=s.records['contribution/'+e.subject]??s.records['legacy_work/'+e.subject]??s.records['legacy/work/'+e.subject];if(v?.task){if(!id(v.task))throw Error('invalid native work task');tasks.set(v.task,e.id)}}
    if(['legacy_challenge_decide','legacy_prior_art_decide','legacy_benevolence_decide'].includes(e?.operation)){const s=await read(config,['legacy_challenge/'+e.subject],signal),v=s.records['legacy_challenge/'+e.subject];if(!v||!id(v.project)||v.task&&!id(v.task))throw Error('original challenge decision target absent');if(v.task)tasks.set(v.task,e.id)}
    if(e?.operation==='decide_prior_art'){const s=await read(config,['prior_art_challenge/'+e.subject],signal),v=s.records['prior_art_challenge/'+e.subject];if(!id(v?.task))throw Error('native prior-art decision task absent');tasks.set(v.task,e.id)}
   }
   signal?.throwIfAborted();await client.query('BEGIN');
   try{
    const proofDigest=sha(JSON.stringify(snapshot));
    await client.query('INSERT INTO native_proof_batches(epoch,proof_digest,state_height,app_hash,proof) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.epoch,proofDigest,snapshot.height,snapshot.app_hash,snapshot]);
    for(let i=0;i<keys.length;i++){
     signal?.throwIfAborted();
     const e=snapshot.records[keys[i]],want=String(start+BigInt(i)+1n);
     if(!e||e.id!==want||typeof e.subject!=='string'||e.subject.length>512||e.subject.includes('\0')||!/^[a-f0-9]{64}$/.test(e.command_digest)||BigInt(e.height)<1n||BigInt(e.height)>BigInt(snapshot.height))throw Error('finalized event stream is not contiguous');
     await client.query('INSERT INTO native_events(epoch,event_id,command_digest,record,state_height,app_hash,proof_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.epoch,e.id,e.command_digest,e,snapshot.height,snapshot.app_hash,proofDigest]);
     if(WORK_EVENTS.includes(e.operation))await queue(client,row.epoch,e.subject,e.id);
     // Task transitions enqueue a bounded fan-out after the event is committed.
     if(['legacy_kpi_resolve','legacy_kpi_expire','legacy_task_close','resolve_kpi','kpi_set','expire_kpi','task_update','prior_art_decide'].includes(e.operation)){if(!id(e.subject))throw Error('invalid native task event');await client.query('INSERT INTO native_projection_queue(epoch,id,event_id) VALUES($1,$2,$3) ON CONFLICT(epoch,id) DO UPDATE SET event_id=EXCLUDED.event_id',[row.epoch,'task:'+e.subject,e.id])}
    }
    for(const key of bootstrap)await queue(client,row.epoch,key,String(end));
    for(const [key,event] of tasks)await client.query('INSERT INTO native_projection_queue(epoch,id,event_id) VALUES($1,$2,$3) ON CONFLICT(epoch,id) DO UPDATE SET event_id=EXCLUDED.event_id',[row.epoch,'task:'+key,event]);
    signal?.throwIfAborted();await client.query('UPDATE native_epochs SET cursor=$2,state_height=$3,app_hash=$4,updated_at=now() WHERE epoch=$1',[row.epoch,String(end),snapshot.height,snapshot.app_hash]);signal?.throwIfAborted();await client.query('COMMIT');
   }catch(e){await client.query('ROLLBACK');throw e}
  }
  return{busy:false,epoch:row.epoch,cursor:String(end),finalized_events:String(count),more:end<count};
 }finally{signal?.removeEventListener('abort',abort);try{if(locked&&!nonblocking&&!signal?.aborted)await client.query('SELECT pg_advisory_unlock(4202625)')}finally{client.release(nonblocking||signal?.aborted)}}
}
export async function projectNativeDocumentOne(pool:pg.Pool,config:Config){
 const client=await pool.connect();await client.query('SELECT pg_advisory_lock(4202626)');
 try{
  const job=(await client.query('SELECT * FROM native_projection_queue WHERE epoch=$1 ORDER BY id LIMIT 1',[config.genesisHash])).rows[0];if(!job)return false;
  if(job.id.startsWith('task:')){const key=job.id.slice(5),s=await read(config,['task/'+key,'legacy_task/'+key,'legacy/task/'+key]),task=s.records['task/'+key]??s.records['legacy_task/'+key]??s.records['legacy/task/'+key];if(!task)throw Error('projected task is absent');
   const ids=task.submissions??task.contributions??[];if(!Array.isArray(ids)||ids.length>128)throw Error('invalid projected task fan-out');
   await client.query('BEGIN');try{for(const key of ids)await queue(client,job.epoch,key,job.event_id);await client.query('DELETE FROM native_projection_queue WHERE epoch=$1 AND id=$2 AND event_id=$3',[job.epoch,job.id,job.event_id]);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}return true;
  }
  const key=job.id,s=await read(config,['contribution/'+key,'legacy_work/'+key,'legacy/work/'+key,'legacy_submission/'+key,'legacy/lookup/contributions/'+key]);
  let v=s.records['contribution/'+key];const legacy=s.records['legacy_work/'+key]??s.records['legacy/work/'+key];let body:any=null,proofs:any[]=[s],context=s,project='',task='',member='',instance='',state='',kind='native',evidence='';
  if(legacy){project=legacy.project;task=legacy.task;member=legacy.member;instance=legacy.author;state=legacy.state;kind='legacy';
   const submitted=s.records['legacy_submission/'+key];if(submitted){body=submitted.payload}else{const lookup=s.records['legacy/lookup/contributions/'+key];if(!lookup?.source)throw Error('original research lookup absent');const source=await originalRow(config,'contributions',lookup.source);body=source.row;proofs.push(...source.proofs);if(body.id!==key||body.contributor!==instance||body.project_id!==project||(body.task_id??'')!==task)throw Error('original research attribution differs from compatibility record')}
   if(legacy.task&&!legacy.paid&&(legacy.state!=='settled'||['kpi','kpi_award'].includes(legacy.pending))){const closure=await read(config,['legacy_task/'+legacy.task,'legacy/task/'+legacy.task,'legacy_malevolent/'+legacy.project+'/'+legacy.task]);proofs.push(closure);const t=closure.records['legacy_task/'+legacy.task]??closure.records['legacy/task/'+legacy.task];if(t?.known||t?.outcome==='expired'||closure.records['legacy_malevolent/'+legacy.project+'/'+legacy.task])state='withheld'}
  }else if(v){task=v.task;
   const t=await read(config,['contribution/'+key,'task/'+task]);proofs.push(t);context=t;v=t.records['contribution/'+key];const taskState=t.records['task/'+task];if(!v||v.task!==task)throw Error('native contribution/task binding changed');member=v.author;instance=v.author_instance??'';state=v.state;evidence=v.evidence_digest;project=taskState?.project;if(!project)throw Error('native contribution task absent');
   if((v.membership_policy||v.storage_policy==='compact-state-v1')&&!['settled','rejected','withheld'].includes(state)){
    if(taskState.prior_art_decision)state='withheld';else if(v.storage_policy==='compact-state-v1'&&['kpi_unmet','kpi_expired'].includes(taskState.state))state='withheld';
   }
   const publication=(await client.query('SELECT * FROM native_publications WHERE epoch=$1 AND id=$2',[job.epoch,key])).rows[0];if(publication){const checked=evidenceDocument(publication.body);if(publication.member!==member||publication.instance!==instance||publication.evidence_digest!==evidence||checked.digest!==evidence||checked.canonical!==publication.canonical_body)throw Error('native publication attribution/content differs');body=publication.body}
  }else throw Error('native research record absent');
  const sourceHash=body?sha(JSON.stringify(body)):null;
  await client.query('BEGIN');try{
   await client.query(`INSERT INTO native_research_documents(epoch,id,project_id,task_id,contributor,instance,state,source_kind,source_hash,evidence_digest,body,proof,state_height,app_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(epoch,id) DO UPDATE SET
    state=EXCLUDED.state,source_hash=EXCLUDED.source_hash,body=EXCLUDED.body,proof=EXCLUDED.proof,state_height=EXCLUDED.state_height,app_hash=EXCLUDED.app_hash`,[job.epoch,key,project,task,member,instance,state,kind,sourceHash,evidence,body,JSON.stringify(proofs),context.height,context.app_hash]);
   await client.query('DELETE FROM native_projection_queue WHERE epoch=$1 AND id=$2 AND event_id=$3',[job.epoch,key,job.event_id]);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e}return true;
 }finally{await client.query('SELECT pg_advisory_unlock(4202626)');client.release()}
}
export async function publishNativeEvidence(pool:pg.Pool,config:Config,input:any){
 if(!input||Object.keys(input).sort().join(',')!=='body,envelope,event_id')throw Error('exact public evidence publication required');
 const document=evidenceDocument(input.body),receipt=await nativeState({receipt:{envelope:input.envelope,event_id:input.event_id}},config),event=receipt.receipt?.event,c=input.envelope.command;
 if(!receipt.receipt?.finalized||event.operation!=='submit'||!id(event.subject)||c.payload.id!==event.subject||c.payload.evidence_digest!==document.digest)throw Error('publication differs from finalized native submission');
 const s=await read(config,['contribution/'+event.subject]),v=s.records['contribution/'+event.subject];
 if(!v||v.id!==event.subject||v.author!==event.member||(v.author_instance??'')!==(event.instance??'')||v.evidence_digest!==document.digest)throw Error('publication author/instance/content differs from native state');
 const client=await pool.connect();try{await client.query('BEGIN');await epoch(client,config,s);await client.query('SELECT pg_advisory_xact_lock(4202628)');
  const prior=(await client.query('SELECT * FROM native_publications WHERE epoch=$1 AND id=$2',[config.genesisHash,v.id])).rows[0];
  if(prior&&(prior.canonical_body!==document.canonical||prior.member!==v.author||prior.instance!==(v.author_instance??'')||prior.evidence_digest!==document.digest))throw Error('immutable native publication already differs');
  const preserved=prior?.receipt??{envelope:input.envelope,state:receipt};
  const replica=await retainPublicationReplica({format:'uain-native-publication-v1',epoch:config.genesisHash,id:v.id,evidence_digest:document.digest,canonical_body:document.canonical,receipt:preserved});
  if(prior&&prior.replica_digest!==replica)throw Error('immutable native publication replica commitment differs');
  if(!prior)await client.query('INSERT INTO native_publications(epoch,id,member,instance,evidence_digest,canonical_body,body,receipt,replica_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[config.genesisHash,v.id,v.author,v.author_instance??'',document.digest,document.canonical,document.body,preserved,replica]);
  await queue(client,config.genesisHash,v.id,event.id);await client.query('COMMIT');return{authority:'native',published:true,epoch:config.genesisHash,id:v.id,evidence_digest:document.digest,replica_digest:replica};
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
