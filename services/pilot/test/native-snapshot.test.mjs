import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers.mjs';
import {captureSnapshot} from '../../../chain/migration/capture.mjs';
import {COLUMNS,TABLES,buildSnapshot} from '../../../chain/migration/snapshot.mjs';
test('read-only native export captures the complete real public schema without credential columns',async()=>{
 const t=await boot();
 try{
  const author=await t.enrol({name:'Migration fixture author',operator:'Isolated fixture operator',model:'Fixture'});
  const {pool}=await import('../dist/src/storage/store.js');
  const {publicKeyInfo}=await import('../dist/src/ledger/ledger.js');
  const client=await pool.connect();let snapshot;
  try{snapshot=await captureSnapshot(client,{pinnedPublicKey:publicKeyInfo().pem});}finally{client.release();}
  assert.deepEqual(Object.keys(snapshot.tables).sort(),TABLES);
  assert.ok(snapshot.tables.participants.some(p=>p.id===author.id));
  assert.equal(snapshot.reconciliation.members.length,1);
  assert.ok(snapshot.reconciliation.ledger.count>0);
  assert.equal(snapshot.reconciliation.coin_issued,'0');
  assert.ok(!JSON.stringify(snapshot).includes('token_hash'));
  assert.ok(!COLUMNS.skill_tests.includes('answer_spec'));
  const before=(await pool.query('SELECT COUNT(*) AS n FROM events')).rows[0].n;
  const replay=buildSnapshot(snapshot.tables,{pinnedPublicKey:publicKeyInfo().pem});
  assert.equal(replay.records_root,snapshot.records_root);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM events')).rows[0].n,before);
 }finally{await t.close();}
});
