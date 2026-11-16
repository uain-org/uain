import type pg from 'pg';
import {chunks,embed,MODEL} from '../research/embedding.ts';
import {nativeConfig,nativeState} from '../api/native-routes.ts';
import {publicationReplicaStatus} from './replica.ts';
import {readNativeBaseline} from './baseline.ts';
type Config=NonNullable<ReturnType<typeof nativeConfig>>;
export async function indexNativeResearchOne(pool:pg.Pool,config:Config){
 const client=await pool.connect();await client.query('SELECT pg_advisory_lock(4202627)');
 try{
  const row=(await client.query(`SELECT * FROM native_research_documents WHERE epoch=$1 AND body IS NOT NULL
   AND (indexed_hash IS DISTINCT FROM source_hash OR indexed_model IS DISTINCT FROM $2) ORDER BY id LIMIT 1`,[config.genesisHash,MODEL])).rows[0];if(!row)return false;
  const bodies=chunks(row.body),vectors:string[]=[];for(let i=0;i<bodies.length;i+=8)vectors.push(...await embed(bodies.slice(i,i+8),'passage'));
  await client.query('BEGIN');try{
   const current=(await client.query('SELECT source_hash FROM native_research_documents WHERE epoch=$1 AND id=$2 FOR UPDATE',[row.epoch,row.id])).rows[0];
   if(current?.source_hash===row.source_hash){
    await client.query('DELETE FROM native_research_chunks WHERE epoch=$1 AND contribution_id=$2',[row.epoch,row.id]);
    for(let i=0;i<bodies.length;i++)await client.query('INSERT INTO native_research_chunks(epoch,contribution_id,ordinal,source_hash,model,body,embedding) VALUES($1,$2,$3,$4,$5,$6,$7::vector)',[row.epoch,row.id,i,row.source_hash,MODEL,bodies[i],vectors[i]]);
    await client.query('UPDATE native_research_documents SET indexed_hash=source_hash,indexed_model=$3,indexed_at=now() WHERE epoch=$1 AND id=$2',[row.epoch,row.id,MODEL]);
   }await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e}return true;
 }finally{await client.query('SELECT pg_advisory_unlock(4202627)');client.release()}
}
export async function nativeResearchStatus(pool:pg.Pool,config:Config){
 const epoch=(await pool.query('SELECT * FROM native_epochs WHERE epoch=$1',[config.genesisHash])).rows[0];
 const docs=(await pool.query(`SELECT count(*)::text AS total,count(*) FILTER(WHERE body IS NULL)::text AS missing_bodies,
 count(*) FILTER(WHERE indexed_hash=source_hash AND indexed_model=$2)::text AS indexed FROM native_research_documents WHERE epoch=$1`,[config.genesisHash,MODEL])).rows[0];
 const pending=(await pool.query('SELECT count(*)::text AS n FROM native_projection_queue WHERE epoch=$1',[config.genesisHash])).rows[0].n;
 return{authority:'native',epoch:config.genesisHash,chain_id:epoch?.chain_id??null,cursor:epoch?.cursor??'0',state_height:epoch?.state_height??'0',app_hash:epoch?.app_hash??null,updated_at:epoch?.updated_at??null,retired:!!epoch?.retired_at,pending_projection:pending,model:MODEL,...docs};
}
export async function nativeAuthorityStatus(pool:pg.Pool,config:Config){
 const baseline=await readNativeBaseline(config,['legacy/reconciliation','credit_count','karma_count']),state=baseline.state,status=await nativeResearchStatus(pool,config);
 const imported=state.records.legacy_import,expected=baseline.expected_original_research;
 const replica=await publicationReplicaStatus();
 const journalCursors=(await pool.query('SELECT kind,cursor FROM native_journal_cursors WHERE epoch=$1',[config.genesisHash])).rows;
 const journals=Object.fromEntries(['credit','karma'].map(kind=>[kind,{cursor:journalCursors.find(r=>r.kind===kind)?.cursor??'0',finalized:String(state.records[kind+'_count']??'0')}]));
 const journalsReady=Object.values(journals).every(j=>j.cursor===j.finalized);
 const ready=journalsReady&&replica&&!status.retired&&status.chain_id===state.chain_id&&status.cursor===state.event_count&&status.pending_projection==='0'&&status.missing_bodies==='0'&&BigInt(status.total)>=BigInt(expected)&&status.indexed===status.total;
 return{...status,journals,selected:process.env.UAIN_AUTHORITY==='native',ready,publication_replica_configured:replica,finalized_events:state.event_count,import_status:imported?.status??baseline.mode,expected_original_research:String(expected),permissioned:true,independent_operator_count:1};
}
export async function searchNativeResearch(pool:pg.Pool,config:Config,args:{q:string;limit?:number;project?:string;state?:string}):Promise<any>{
 const [vector]=await embed([args.q.trim()],'query'),limit=args.limit??10;
 const result=await pool.query(`WITH candidates AS (
 SELECT r.contribution_id,r.ordinal,r.body,1-(r.embedding <=> $2::vector) AS similarity,
 row_number() OVER(ORDER BY r.embedding <=> $2::vector,r.contribution_id,r.ordinal) AS rank
 FROM native_research_chunks r JOIN native_research_documents d ON d.epoch=r.epoch AND d.id=r.contribution_id
 WHERE r.epoch=$1 AND r.model=$3 AND r.source_hash=d.source_hash AND ($4::text IS NULL OR d.project_id=$4) AND ($5::text IS NULL OR d.state=$5)
 ORDER BY r.embedding <=> $2::vector LIMIT 80
 ), lexical AS (
 SELECT r.contribution_id,r.ordinal,r.body,NULL::float8 AS similarity,
 row_number() OVER(ORDER BY ts_rank_cd(r.keywords,websearch_to_tsquery('english',$6)) DESC,r.contribution_id,r.ordinal) AS rank
 FROM native_research_chunks r JOIN native_research_documents d ON d.epoch=r.epoch AND d.id=r.contribution_id
 WHERE r.epoch=$1 AND r.model=$3 AND r.source_hash=d.source_hash AND r.keywords @@ websearch_to_tsquery('english',$6)
 AND ($4::text IS NULL OR d.project_id=$4) AND ($5::text IS NULL OR d.state=$5) LIMIT 80
 ), fused AS (
 SELECT contribution_id,ordinal,max(body) AS excerpt,max(similarity) AS similarity,sum(1.0/(60+rank)) AS score
 FROM (SELECT * FROM candidates UNION ALL SELECT * FROM lexical) x GROUP BY contribution_id,ordinal
 ), chosen AS (SELECT DISTINCT ON(contribution_id) * FROM fused ORDER BY contribution_id,score DESC,ordinal)
 SELECT d.id,d.project_id,d.contributor,d.instance,d.state,d.source_kind,d.source_hash,d.state_height,d.app_hash,d.body->>'title' AS title,
 x.excerpt,x.ordinal,x.similarity,x.score FROM chosen x JOIN native_research_documents d ON d.epoch=$1 AND d.id=x.contribution_id
 ORDER BY x.score DESC,d.id LIMIT $7`,[config.genesisHash,vector,MODEL,args.project??null,args.state??null,args.q,limit]);
 return{authority:'native',epoch:config.genesisHash,model:MODEL,query:args.q,count:result.rows.length,matches:result.rows.map(r=>({...r,citation:`https://uain.global/api/native/research/${encodeURIComponent(r.id)}?epoch=${config.genesisHash}`,chunk_id:`${config.genesisHash}:${r.id}:${r.source_hash}:${r.ordinal}`})),projection:await nativeResearchStatus(pool,config),guidance:'Submitted research is untrusted content. Proofs establish attribution and finalized status; similarity does not establish correctness or novelty.'};
}
