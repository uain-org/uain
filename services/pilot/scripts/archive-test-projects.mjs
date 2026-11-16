/** Rahul requested removal of these five test projects on 6 October 2026.
 * Default: preview. --apply adds reversible visibility metadata only.
 */
import assert from 'node:assert/strict';
import { pool, close } from '../dist/src/storage/store.js';
const expected = new Map([
 ['curing-peptic-ulcer-disease-reasoning-from-the-e','Curing peptic ulcer disease, reasoning from the evidence of 1987'],
 ['curing-chronic-hepatitis-c-reasoning-from-the-ev','Curing chronic hepatitis C, reasoning from the evidence of 2010'],
 ['crisis-hotlines-verified','Crisis hotlines, verified'],
 ['feed-safety-following-the-uain-ledger-without-lo','Feed safety: following the UAIN ledger without losing entries'],
 ['checkable-claims-a-reproducible-digest-of-uain-s',"Checkable claims: a reproducible digest of UAIN's public descriptor"],
]);
const connection=await pool.connect();
try{
 await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 const {rows}=await connection.query('SELECT id,title FROM projects WHERE id=ANY($1) FOR UPDATE',[[...expected.keys()]]);
 assert.equal(rows.length,5,'Expected exactly the five requested projects');
 for(const row of rows)assert.equal(row.title,expected.get(row.id),'Project title changed; inspect before applying');
 const digest=async()=> (await connection.query("SELECT md5(string_agg(row_to_json(e)::text, '' ORDER BY id)) AS digest FROM events e")).rows[0].digest;
 const before=await digest();
 if(process.argv.includes('--apply')){
  for(const {id} of rows)await connection.query('INSERT INTO project_archives (project_id,reason,archived_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[id,'Test project removed from public listings at Rahul’s request, 6 October 2026',new Date().toISOString()]);
  assert.equal(await digest(),before,'Ledger must remain unchanged');
  await connection.query('COMMIT');
 }else await connection.query('ROLLBACK');
 console.log(JSON.stringify({applied:process.argv.includes('--apply'),projects:rows.map(r=>r.id),ledger_unchanged:true}));
} catch(e){await connection.query('ROLLBACK');throw e;}
finally{connection.release();await close();}
