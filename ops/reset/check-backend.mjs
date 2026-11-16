// Run after reset with the same isolated fixture ledger identity.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const root=process.env.UAIN_RESET_BACKEND_FIXTURE_DIR;
assert.ok(root?.startsWith('/opt/uain-test/'));
const expected=JSON.parse(readFileSync(root+'/public.json','utf8'));
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/'+expected.database);
const db=await import('../../services/pilot/dist/src/application/db.js');
const ledger=await import('../../services/pilot/dist/src/ledger/ledger.js');
const {pool,close}=await import('../../services/pilot/dist/src/storage/store.js');
const events=(await pool.query('SELECT * FROM events ORDER BY id')).rows;
assert.deepEqual(events,expected.events);assert.equal(ledger.verifyChain(events).ok,true);
assert.deepEqual(await ledger.dayRoot(expected.root.date),expected.root);
assert.equal(ledger.verifyRootSignature(expected.root,expected.key.pem),true);
for(const table of ['members','participants','projects','contributions','research_chunks','research_jobs','waitlist','device_tokens','donation_interests']){
 assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),0,table);
}
for(const [table,records] of Object.entries(expected.nativeHistory)){
 const actual=(await pool.query('SELECT to_jsonb(t) AS record FROM '+table+' t ORDER BY to_jsonb(t)::text COLLATE "C"')).rows.map(r=>r.record);
 if(table==='native_epochs')for(const row of records)if(row.retired_at===null)row.retired_at=new Date(process.env.UAIN_RESET_FIXTURE_EPOCH.slice(0,4)+'-'+process.env.UAIN_RESET_FIXTURE_EPOCH.slice(4,6)+'-'+process.env.UAIN_RESET_FIXTURE_EPOCH.slice(6,8)+'T'+process.env.UAIN_RESET_FIXTURE_EPOCH.slice(9,11)+':'+process.env.UAIN_RESET_FIXTURE_EPOCH.slice(11,13)+':'+process.env.UAIN_RESET_FIXTURE_EPOCH.slice(13,15)+'Z').toISOString().replace('.000Z','+00:00');
 assert.deepEqual(actual,records,table+' retained original bytes');
}
assert.equal(Number((await pool.query('SELECT count(*) AS n FROM native_projection_queue')).rows[0].n),0);
await db.record('system_reset','operator:fixture','Isolated reset boundary; authenticated archives verified.');
const after=(await pool.query('SELECT * FROM events ORDER BY id')).rows;
assert.equal(after.length,events.length+1);assert.equal(after.at(-1).prev_hash,events.at(-1).hash);
assert.equal(ledger.verifyChain(after).ok,true);
assert.deepEqual(await ledger.dayRoot(expected.root.date),expected.root);
const {createPilotServer}=await import('../../services/pilot/dist/src/api/server.js');
const server=createPilotServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const api=`http://127.0.0.1:${server.address().port}`;
const historical=await (await fetch(api+'/api/contributions/'+expected.contribution)).json();
assert.equal(historical.read_only,true);assert.equal(historical.id,expected.contribution);
const audit=fileURLToPath(new URL('../../services/pilot/scripts/verify-ledger.mjs',import.meta.url));
await promisify(execFile)(process.execPath,[audit],{env:{...process.env,UAIN_API:api,LEDGER_PUBLIC_KEY_PEM:expected.key.pem},timeout:60000});
server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
console.log(JSON.stringify({schema:'complete pilot',active_tables_empty:true,original_signed_root_valid:true,original_events_unchanged:true,new_boundary_chained:true,native_history_and_bodies_retained:true,prior_epochs_retired:true,pending_projection_cleared:true}));
await close();process.exit(0);
