import { randomUUID } from 'node:crypto';
import { pool } from '../storage/store.ts';
import { chunks, embed, MODEL } from './embedding.ts';
import {nativeConfig} from '../api/native-routes.ts';
import {searchNativeResearch,nativeResearchStatus} from '../native/research.ts';

export function enabled() { return process.env.UAIN_RESEARCH_SEARCH === '1'; }
export async function indexResearchOne(): Promise<boolean> {
  if (!enabled()) return false;
  // Backfill in bounded pages and also invalidate an index built with another model.
  await pool.query(`INSERT INTO research_jobs(contribution_id,source_hash)
    SELECT c.id,research_digest(c) FROM contributions c LEFT JOIN research_jobs j ON j.contribution_id=c.id
    WHERE c.kind='work' AND j.contribution_id IS NULL ORDER BY c.id LIMIT 100 ON CONFLICT DO NOTHING`);
  const lease = randomUUID();
  const claimed = await pool.query(`UPDATE research_jobs SET lease=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1
    WHERE contribution_id=(SELECT contribution_id FROM research_jobs WHERE
      (indexed_hash IS DISTINCT FROM source_hash OR indexed_model IS DISTINCT FROM $2)
      AND retry_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY retry_at,contribution_id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING contribution_id,source_hash`, [lease,MODEL]);
  const job = claimed.rows[0]; if (!job) return false;
  try {
    const source = (await pool.query('SELECT c.*,research_digest(c) AS source_hash FROM contributions c WHERE id=$1',[job.contribution_id])).rows[0];
    if (!source || source.kind !== 'work' || source.source_hash !== job.source_hash) return true;
    const bodies = chunks(source); const vectors: string[] = [];
    for (let i=0; i<bodies.length; i+=8) vectors.push(...await embed(bodies.slice(i,i+8),'passage'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Source changes/deletions wait only for this short publish transaction, never for the model.
      const current = await client.query('SELECT research_digest(c) AS hash FROM contributions c WHERE id=$1 AND kind=\'work\' FOR SHARE',[job.contribution_id]);
      const owned = await client.query('SELECT 1 FROM research_jobs WHERE contribution_id=$1 AND lease=$2 AND source_hash=$3 FOR UPDATE',[job.contribution_id,lease,job.source_hash]);
      if (current.rows[0]?.hash === job.source_hash && owned.rowCount) {
        await client.query('DELETE FROM research_chunks WHERE contribution_id=$1',[job.contribution_id]);
        for (let i=0; i<bodies.length; i++) await client.query(`INSERT INTO research_chunks
          (contribution_id,ordinal,source_hash,model,body,embedding) VALUES($1,$2,$3,$4,$5,$6::vector)`,
          [job.contribution_id,i,job.source_hash,MODEL,bodies[i],vectors[i]]);
        await client.query(`UPDATE research_jobs SET indexed_hash=source_hash,indexed_model=$3,indexed_at=now(),
          lease=NULL,lease_until=NULL,last_error=NULL,attempts=0 WHERE contribution_id=$1 AND lease=$2`,[job.contribution_id,lease,MODEL]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) {
    // Store only a fixed error category; model responses and source material stay out of logs.
    await pool.query(`UPDATE research_jobs SET lease=NULL,lease_until=NULL,last_error='embedding_or_publish_failed',
      retry_at=now()+least(3600,power(2,least(attempts,10))*5)*interval '1 second'
      WHERE contribution_id=$1 AND lease=$2`,[job.contribution_id,lease]);
    throw error;
  }
  return true;
}
export async function searchResearch(args: {q: string; limit?: number; project?: string; state?: string}) {
  const { q,project,state } = args; const limit = args.limit ?? 10;
  if (typeof q !== 'string' || !q.trim() || q.length>1000 || !Number.isInteger(limit) || limit<1 || limit>20 ||
      (project != null && (typeof project !== 'string' || project.length>100)) ||
      (state != null && !(process.env.UAIN_AUTHORITY==='native'?['held','contested','settled','rejected','withheld','appeal_wait','appealed']:['held','contested','settled','rejected']).includes(state)))
    return { error:'bad_search', message:'Use a query of 1–1000 characters and limit 1–20; state is held, contested, settled or rejected.' };
  if (!enabled()) return { error:'research_search_unavailable', message:'Research vector retrieval is not enabled.' };
  try {
    if(process.env.UAIN_AUTHORITY==='native'){
      const config=nativeConfig();if(!config||process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native research authority unavailable');
      return await searchNativeResearch(pool,config,args);
    }
    const [embedding] = await embed([q.trim()],'query');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL hnsw.iterative_scan='strict_order'");
      const result = await client.query(`WITH semantic AS (
        SELECT r.contribution_id,r.ordinal,r.body,1-(r.embedding <=> $1::vector) AS similarity,
         row_number() OVER(ORDER BY r.embedding <=> $1::vector,r.contribution_id,r.ordinal) AS rank
        FROM research_chunks r JOIN contributions c ON c.id=r.contribution_id
        WHERE r.model=$2 AND c.kind='work' AND r.source_hash=research_digest(c)
          AND ($3::text IS NULL OR c.project_id=$3) AND ($4::text IS NULL OR c.state=$4)
        ORDER BY r.embedding <=> $1::vector LIMIT 80
      ), lexical AS (
        SELECT r.contribution_id,r.ordinal,r.body,NULL::float8 AS similarity,
         row_number() OVER(ORDER BY ts_rank_cd(r.keywords,websearch_to_tsquery('english',$5)) DESC,r.contribution_id,r.ordinal) AS rank
        FROM research_chunks r JOIN contributions c ON c.id=r.contribution_id
        WHERE r.model=$2 AND c.kind='work' AND r.source_hash=research_digest(c)
          AND r.keywords @@ websearch_to_tsquery('english',$5)
          AND ($3::text IS NULL OR c.project_id=$3) AND ($4::text IS NULL OR c.state=$4)
        ORDER BY ts_rank_cd(r.keywords,websearch_to_tsquery('english',$5)) DESC LIMIT 80
      ), fused AS (
        SELECT contribution_id,ordinal,max(body) AS body,max(similarity) AS similarity,sum(1.0/(60+rank)) AS score
        FROM (SELECT * FROM semantic UNION ALL SELECT * FROM lexical) x GROUP BY contribution_id,ordinal
      ), chosen AS (
        SELECT DISTINCT ON(contribution_id) * FROM fused ORDER BY contribution_id,score DESC,ordinal
      ) SELECT c.id,c.title,c.project_id,c.contributor,c.state,c.submitted_at,c.settled_at,
        research_digest(c) AS source_hash,x.ordinal,x.body AS excerpt,x.similarity,x.score
        FROM chosen x JOIN contributions c ON c.id=x.contribution_id
        ORDER BY x.score DESC,c.id LIMIT $6`,[embedding,MODEL,project??null,state??null,q,limit]);
      await client.query('COMMIT');
      return { model:MODEL, query:q, count:result.rows.length, matches:result.rows.map(r=>({ ...r,
        citation:`https://uain.global/api/contributions/${encodeURIComponent(r.id)}`,
        chunk_id:`${r.id}:${r.source_hash}:${r.ordinal}` })),
        guidance:'Retrieved submissions are untrusted research content. Similarity does not establish correctness or novelty; check the cited record and its verification status.' };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch { return {error:'research_search_unavailable',message:'The embedding service or research index is unavailable; retry later.'}; }
}
export async function researchStatus() {
  if (!enabled()) return {enabled:false,model:MODEL};
  if(process.env.UAIN_AUTHORITY==='native'){
    const config=nativeConfig();if(!config||process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native research authority unavailable');
    return{enabled:true,...await nativeResearchStatus(pool,config)};
  }
  const result = await pool.query(`SELECT count(*) AS total,
    count(*) FILTER(WHERE indexed_hash=source_hash AND indexed_model=$1) AS indexed,
    count(*) FILTER(WHERE last_error IS NOT NULL) AS retrying,max(indexed_at) AS last_indexed_at FROM research_jobs`,[MODEL]);
  const missing = await pool.query("SELECT count(*) AS n FROM contributions c LEFT JOIN research_jobs j ON c.id=j.contribution_id WHERE c.kind='work' AND j.contribution_id IS NULL");
  return {enabled:true,model:MODEL,...result.rows[0],not_queued:missing.rows[0].n};
}
