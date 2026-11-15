import { createHash } from 'node:crypto';
import type pg from 'pg';

// Derived records only. No ledger mutation or change to historical hash rules.
export const RESEARCH_SCHEMA = `
CREATE OR REPLACE FUNCTION research_digest(c contributions) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(c.title,c.detail,c.artifacts,
 c.claim_statement,c.evidence,c.sources,c.forecast,c.reproduction,c.kind)::text,'UTF8')),'hex')
$$;
CREATE TABLE IF NOT EXISTS research_jobs (
 contribution_id text PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
 source_hash text NOT NULL, indexed_hash text, indexed_model text,
 lease text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz NOT NULL DEFAULT now(), indexed_at timestamptz, last_error text
);
CREATE TABLE IF NOT EXISTS research_chunks (
 contribution_id text NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
 ordinal integer NOT NULL, source_hash text NOT NULL, model text NOT NULL,
 body text NOT NULL, embedding vector(384) NOT NULL,
 keywords tsvector GENERATED ALWAYS AS (to_tsvector('english',body)) STORED,
 PRIMARY KEY(contribution_id,ordinal)
);
CREATE INDEX IF NOT EXISTS research_chunks_vector ON research_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS research_chunks_keywords ON research_chunks USING gin (keywords);
CREATE OR REPLACE FUNCTION enqueue_research() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind <> 'work' THEN
   DELETE FROM research_jobs WHERE contribution_id=NEW.id;
   DELETE FROM research_chunks WHERE contribution_id=NEW.id;
 ELSIF TG_OP='INSERT' OR research_digest(NEW) IS DISTINCT FROM research_digest(OLD) THEN
   INSERT INTO research_jobs(contribution_id,source_hash) VALUES(NEW.id,research_digest(NEW))
   ON CONFLICT(contribution_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,
    lease=NULL,lease_until=NULL,attempts=0,retry_at=now(),last_error=NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS research_enqueue ON contributions;
CREATE TRIGGER research_enqueue AFTER INSERT OR UPDATE OF title,detail,artifacts,
 claim_statement,evidence,sources,forecast,reproduction,kind ON contributions
 FOR EACH ROW EXECUTE FUNCTION enqueue_research();
`;
const hash = createHash('sha256').update(RESEARCH_SCHEMA).digest('hex');
export async function readyResearchSchema(client: pg.PoolClient) {
  if (process.env.UAIN_RESEARCH_SEARCH !== '1') return;
  await client.query('SELECT pg_advisory_lock(4202618)');
  try {
    const applied = await client.query('SELECT 1 FROM schema_applied WHERE hash=$1', [hash]);
    if (applied.rowCount) return;
    const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
    if (!extension.rowCount) throw new Error('Research search requires operator-installed pgvector');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(RESEARCH_SCHEMA);
    await client.query('INSERT INTO schema_applied(hash,at) VALUES($1,$2)', [hash,new Date().toISOString()]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.query('SELECT pg_advisory_unlock(4202618)'); }
}
