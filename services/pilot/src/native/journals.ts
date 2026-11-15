/** Derived public nonmonetary journals. Every row retains the exact proven
 * native record and its proof batch; source journals remain in the archive. */
import{createHash}from'node:crypto';import type pg from'pg';
import{nativeState,nativeConfig}from'../api/native-routes.ts';
type Config=NonNullable<ReturnType<typeof nativeConfig>>;
const counter=(value:any)=>{if(value==null)return 0n;if(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value))return BigInt(value);if(Number.isSafeInteger(value)&&value>=0)return BigInt(value);throw Error('unsafe native journal counter')};
export async function syncNativeJournals(pool:pg.Pool,config:Config,limit=32,{nonblocking=false,signal}:{nonblocking?:boolean;signal?:AbortSignal}={}){
 signal?.throwIfAborted();
 if(!Number.isInteger(limit)||limit<1||limit>32)throw Error('bounded native journal batch required');
 const client=await pool.connect();let locked=false;
 const abort=()=>{void client.end().catch(()=>{})};
 try{
  signal?.throwIfAborted();
  if(nonblocking)signal?.addEventListener('abort',abort,{once:true});
  if(nonblocking){locked=!!(await client.query('SELECT pg_try_advisory_lock(4202628) AS locked')).rows[0]?.locked;if(!locked)return{busy:true,more:true}}
  else{await client.query('SELECT pg_advisory_lock(4202628)');locked=true}
  if(nonblocking){await client.query("SET statement_timeout='2s'");await client.query("SET lock_timeout='1s'")}
  const latest=await nativeState({keys:['credit_count','karma_count']},config,{signal}),epoch=config.genesisHash;
  const current=(await client.query('SELECT * FROM native_epochs WHERE epoch=$1',[epoch])).rows[0];
  if(!current||current.retired_at||current.chain_id!==latest.chain_id)throw Error('native journal epoch missing or retired');
  const cursors:any={};let more=false;
  for(const kind of ['credit','karma']){
   signal?.throwIfAborted();
   const prior=(await client.query('SELECT cursor FROM native_journal_cursors WHERE epoch=$1 AND kind=$2',[epoch,kind])).rows[0];
   const start=counter(prior?.cursor),count=counter(latest.records[kind+'_count']);if(start>count)throw Error('native journal regressed');
   const end=start+BigInt(limit)<count?start+BigInt(limit):count,keys=[];for(let at=start+1n;at<=end;at++)keys.push(kind+'/'+String(at).padStart(20,'0'));
   if(keys.length){const proof=await nativeState({keys},config,{signal});if(proof.chain_id!==latest.chain_id)throw Error('native journal chain changed');
    const rows=keys.map((key,i)=>{const v=proof.records[key],wanted=String(start+BigInt(i)+1n).padStart(20,'0');if(!v||v.id!==wanted||typeof v.member!=='string'||counter(v.event_id)>counter(proof.event_count)||counter(v.event_id)<1n)throw Error('native journal record identity/context differs');
     if(kind==='credit'){for(const field of ['amount','minted','deferred'])if(typeof v[field]!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(v[field]))throw Error('invalid native credit journal amount');if(BigInt(v.minted)+BigInt(v.deferred)!==BigInt(v.amount))throw Error('native credit journal does not reconcile')}
     else if(!Number.isSafeInteger(v.delta))throw Error('unsafe native Karma journal delta');return v});
    signal?.throwIfAborted();await client.query('BEGIN');try{const digest=createHash('sha256').update(JSON.stringify(proof)).digest('hex');await client.query('INSERT INTO native_proof_batches(epoch,proof_digest,state_height,app_hash,proof) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[epoch,digest,proof.height,proof.app_hash,proof]);
     for(const row of rows){signal?.throwIfAborted();await client.query('INSERT INTO native_journal_entries(epoch,kind,id,event_id,record,proof_digest) VALUES($1,$2,$3,$4,$5,$6)',[epoch,kind,row.id,row.event_id,row,digest])}
     signal?.throwIfAborted();await client.query('INSERT INTO native_journal_cursors(epoch,kind,cursor) VALUES($1,$2,$3) ON CONFLICT(epoch,kind) DO UPDATE SET cursor=EXCLUDED.cursor',[epoch,kind,String(end)]);signal?.throwIfAborted();await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error}
   }cursors[kind]={cursor:String(end),finalized:String(count)};more ||= end<count;
  }return{busy:false,authority:'native',epoch,more,journals:cursors};
 }finally{signal?.removeEventListener('abort',abort);try{if(locked&&!nonblocking&&!signal?.aborted)await client.query('SELECT pg_advisory_unlock(4202628)')}finally{client.release(nonblocking||signal?.aborted)}}
}
