import {createHash} from 'node:crypto';
import type pg from 'pg';
import {nativeConfig} from '../api/native-routes.ts';
export const NATIVE_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_epochs (
 epoch text PRIMARY KEY, chain_id text NOT NULL, genesis_sha256 text UNIQUE NOT NULL,
 cursor text NOT NULL DEFAULT '0', state_height text NOT NULL DEFAULT '0', app_hash text,
 updated_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
 CHECK(cursor ~ '^(0|[1-9][0-9]*)$'));
CREATE TABLE IF NOT EXISTS native_proof_batches (
 epoch text NOT NULL REFERENCES native_epochs(epoch), proof_digest text NOT NULL, state_height text NOT NULL,
 app_hash text NOT NULL, proof jsonb NOT NULL, PRIMARY KEY(epoch,proof_digest));
CREATE TABLE IF NOT EXISTS native_events (
 epoch text NOT NULL REFERENCES native_epochs(epoch), event_id text NOT NULL,
 command_digest text NOT NULL, record jsonb NOT NULL, state_height text NOT NULL, app_hash text NOT NULL,proof_digest text NOT NULL,
 PRIMARY KEY(epoch,event_id), UNIQUE(epoch,command_digest),FOREIGN KEY(epoch,proof_digest) REFERENCES native_proof_batches(epoch,proof_digest));
CREATE TABLE IF NOT EXISTS native_projection_queue (
 epoch text NOT NULL REFERENCES native_epochs(epoch), id text NOT NULL,
 event_id text NOT NULL, PRIMARY KEY(epoch,id));
CREATE TABLE IF NOT EXISTS native_journal_cursors (
 epoch text NOT NULL REFERENCES native_epochs(epoch),kind text NOT NULL,cursor text NOT NULL,
 PRIMARY KEY(epoch,kind),CHECK(kind IN ('credit','karma')),CHECK(cursor ~ '^(0|[1-9][0-9]*)$'));
CREATE TABLE IF NOT EXISTS native_journal_entries (
 epoch text NOT NULL REFERENCES native_epochs(epoch),kind text NOT NULL,id text NOT NULL,
 event_id text NOT NULL,record jsonb NOT NULL,proof_digest text NOT NULL,
 PRIMARY KEY(epoch,kind,id),FOREIGN KEY(epoch,proof_digest) REFERENCES native_proof_batches(epoch,proof_digest));
CREATE INDEX IF NOT EXISTS native_journal_member ON native_journal_entries(epoch,(record->>'member'));
CREATE INDEX IF NOT EXISTS native_journal_work ON native_journal_entries(epoch,(record->>'contribution'));
CREATE TABLE IF NOT EXISTS native_publications (
 epoch text NOT NULL REFERENCES native_epochs(epoch), id text NOT NULL,
 member text NOT NULL, instance text NOT NULL, evidence_digest text NOT NULL,
 canonical_body text NOT NULL, body jsonb NOT NULL, receipt jsonb NOT NULL, replica_digest text NOT NULL,
 published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(epoch,id));
CREATE TABLE IF NOT EXISTS native_research_documents (
 epoch text NOT NULL REFERENCES native_epochs(epoch), id text NOT NULL,
 project_id text NOT NULL, task_id text NOT NULL, contributor text NOT NULL, instance text NOT NULL,
 state text NOT NULL, source_kind text NOT NULL, source_hash text, evidence_digest text,
 body jsonb, proof jsonb NOT NULL, state_height text NOT NULL, app_hash text NOT NULL,
 indexed_hash text, indexed_model text, indexed_at timestamptz,
 PRIMARY KEY(epoch,id));
`;
const VECTOR_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_research_chunks (
 epoch text NOT NULL, contribution_id text NOT NULL, ordinal integer NOT NULL,
 source_hash text NOT NULL, model text NOT NULL, body text NOT NULL, embedding vector(384) NOT NULL,
 keywords tsvector GENERATED ALWAYS AS (to_tsvector('english',body)) STORED,
 PRIMARY KEY(epoch,contribution_id,ordinal),
 FOREIGN KEY(epoch,contribution_id) REFERENCES native_research_documents(epoch,id));
CREATE INDEX IF NOT EXISTS native_research_chunks_vector ON native_research_chunks USING hnsw(embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS native_research_chunks_keywords ON native_research_chunks USING gin(keywords);
`;
export async function readyNativeSchema(client:pg.PoolClient){
 if(process.env.UAIN_NATIVE_PROJECTION!=='1')return;
 if(!nativeConfig())throw Error('native projection requires independently pinned native authority');
 const sql=NATIVE_SCHEMA+(process.env.UAIN_RESEARCH_SEARCH==='1'?VECTOR_SCHEMA:''),hash=createHash('sha256').update(sql).digest('hex');
 await client.query('SELECT pg_advisory_lock(4202624)');
 try{
  if((await client.query('SELECT 1 FROM schema_applied WHERE hash=$1',[hash])).rowCount)return;
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");await client.query(sql);
  await client.query('INSERT INTO schema_applied(hash,at) VALUES($1,$2)',[hash,new Date().toISOString()]);await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e}finally{await client.query('SELECT pg_advisory_unlock(4202624)')}
}
