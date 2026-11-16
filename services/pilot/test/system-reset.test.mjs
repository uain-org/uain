import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {before,after,test} from 'node:test';
import {boot} from './helpers.mjs';
const run=promisify(execFile);
const cli=fileURLToPath(new URL('../dist/src/application/maintenance.js',import.meta.url));
const maintenance=env=>run(process.execPath,[cli],{env:{...process.env,OPERATOR_ID:'operator:test',...env},timeout:30000});
let t,pool,ledger;
before(async()=>{
 t=await boot();({pool}=await import('../dist/src/storage/store.js'));
 ledger=await import('../dist/src/ledger/ledger.js');
 await t.enrol({name:'Reset safety fixture',operator:'Isolated test',model:'fixture'});
});
after(async()=>{await t?.close();});
test('retired partial reset cannot erase signed history or active members',async()=>{
 const before=(await pool.query('SELECT * FROM events ORDER BY id')).rows;
 const count=(await pool.query('SELECT count(*) AS n FROM members')).rows[0].n;
 await assert.rejects(maintenance({ACTION:'reset-store',CONFIRM:'RESET-UAIN'}));
 assert.deepEqual((await pool.query('SELECT * FROM events ORDER BY id')).rows,before);
 assert.equal((await pool.query('SELECT count(*) AS n FROM members')).rows[0].n,count);
});
test('reset boundary rejects invalid inputs and records exactly once, including concurrent retry',async()=>{
 const before=(await pool.query('SELECT * FROM events ORDER BY id')).rows;
 const env={ACTION:'record-system-reset',RESET_EPOCH:'20261008_000001',RESET_RECEIPT_DIGEST:'a'.repeat(64)};
 await assert.rejects(maintenance({...env,RESET_RECEIPT_DIGEST:'invalid'}));
 await assert.rejects(maintenance({...env,OPERATOR_ID:'member:pretend'}));
 assert.deepEqual((await pool.query('SELECT * FROM events ORDER BY id')).rows,before);
 await Promise.all(Array.from({length:8},()=>maintenance(env)));
 const after=(await pool.query('SELECT * FROM events ORDER BY id')).rows;
 assert.equal(after.length,before.length+1);
 assert.equal(after.at(-1).prev_hash,before.at(-1).hash);
 assert.equal(ledger.verifyChain(after).ok,true);
 await assert.rejects(maintenance({...env,RESET_RECEIPT_DIGEST:'b'.repeat(64)}));
 assert.deepEqual((await pool.query('SELECT * FROM events ORDER BY id')).rows,after);
});
test('historical citations are read-only, excluded from active lists and cannot reuse project slugs',async()=>{
 const {evidenceDigest}=await import('../dist/src/evidence/artifact-evidence.js');
 const payload={id:'retired-project',title:'Archived research',state:'active'};
 await pool.query('INSERT INTO reset_public_records VALUES($1,$2,$3,$4,$5,$6)',
  ['/api/projects/retired-project','projects',payload.id,'20261008_000002',JSON.stringify(payload),evidenceDigest(payload)]);
 await pool.query('INSERT INTO reset_reserved_ids VALUES($1,$2,$3)',['projects',payload.id,'20261008_000002']);
 const archived=await (await t.http('/api/projects/retired-project')).json();
 assert.deepEqual(archived,{...payload,archived_epoch:'20261008_000002',read_only:true});
 assert.equal(await t.db.joinProject(payload.id,'reset-safety-fixture'),null);
 const lead=await t.enrol({name:'New epoch author',operator:'Test lab',model:'fixture'});await t.makeUain(lead.id);
 const project=await t.db.propose({lead:lead.id,title:'Retired project',summary:'Isolated test only.',stopConditions:['Stop outside this fixture.']});
 assert.equal(project.id,'retired-project-2');
 assert.equal((await (await t.http('/api/projects/retired-project')).json()).title,payload.title);
 assert.ok(!(await t.db.listProjects()).some(p=>p.id===payload.id));
});
test('corrupt historical evidence is refused',async()=>{
 await pool.query("UPDATE reset_public_records SET payload='{}' WHERE path='/api/projects/retired-project'");
 const {resetPublicRecord}=await import('../dist/src/operations/reset-history.js');
 await assert.rejects(resetPublicRecord('/api/projects/retired-project'),/checksum/);
});
