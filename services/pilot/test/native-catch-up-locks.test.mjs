import {test} from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
import {syncNativeProjection} from '../dist/src/native/projection.js';import {syncNativeJournals} from '../dist/src/native/journals.js';
import {createNativePublicCatchUpPool,createNativePublicCatchUp} from '../dist/src/native/public-catch-up.js';
test('dedicated catch-up pool bounds acquisition and removes a timed-out queue entry', {skip:!process.env.UAIN_TEST_PG},async()=>{
 const pool=createNativePublicCatchUpPool(process.env.UAIN_TEST_PG,{connectionTimeoutMs:50}),holder=await pool.connect();
 try{const at=Date.now();await assert.rejects(()=>syncNativeProjection(pool,{},32,{nonblocking:true,signal:AbortSignal.timeout(500)}),/timeout.*connect|connect.*timeout/i);assert.ok(Date.now()-at<300,'catch-up acquisition was not bounded');assert.equal(pool.waitingCount,0,'timed-out acquisition remained queued')}finally{holder.release();await createNativePublicCatchUp(pool).close()}
});
test('actual PostgreSQL projector locks stay nonblocking and cancellation releases SQL waits, advisory locks and timeout settings',
 {skip:!process.env.UAIN_TEST_PG,timeout:15000},async()=>{
 const admin=new pg.Client({connectionString:process.env.UAIN_TEST_PG}),name='uain_catchup_'+process.pid+'_'+Date.now(),root=await mkdtemp(join(tmpdir(),'uain-catchup-locks-'));let pool,holder,controller;
 await admin.connect();
 try{await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.UAIN_TEST_PG);url.pathname='/'+name;pool=new pg.Pool({connectionString:url.toString(),max:3,application_name:'uain-catchup-cancel-test'});holder=await pool.connect();const baselineTimeout=(await holder.query('SHOW statement_timeout')).rows[0].statement_timeout;
  for(const [key,sync]of [[4202625,syncNativeProjection],[4202628,syncNativeJournals]]){await holder.query('SELECT pg_advisory_lock($1)',[key]);const start=Date.now();assert.equal((await sync(pool,{},32,{nonblocking:true})).busy,true);assert.ok(Date.now()-start<1000,'catch-up waited behind the scheduled projector');await holder.query('SELECT pg_advisory_unlock($1)',[key])}
  await holder.query("CREATE TABLE native_epochs(epoch TEXT PRIMARY KEY,chain_id TEXT,genesis_sha256 TEXT,cursor TEXT DEFAULT '0',retired_at TIMESTAMPTZ)");
  const binary=join(root,'reader'),genesis=join(root,'genesis'),script=`#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const s=JSON.parse(input),records=Object.fromEntries((s.keys??[]).map(k=>[k,k.startsWith('event/')?{operation:'legacy_finish'}:null]));fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({chain_id:'isolated-cancel',height:'10',event_count:'1',records}),{mode:384});});\n`;
  await writeFile(binary,script,{mode:0o700});await writeFile(genesis,'{}');const config={binary,binaryHash:createHash('sha256').update(script).digest('hex'),genesis,genesisHash:createHash('sha256').update('{}').digest('hex'),rpc:'http://127.0.0.1:1'};
  await holder.query('BEGIN');await holder.query('LOCK TABLE native_epochs IN ACCESS EXCLUSIVE MODE');controller=new AbortController();
  const work=syncNativeProjection(pool,config,32,{nonblocking:true,signal:controller.signal});const rejected=assert.rejects(work,/terminat|abort|closed|connection/i);
  let blocked=false;for(let i=0;i<100;i++){const result=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO native_epochs%'",[name]);if(result.rows.length){blocked=true;break}await delay(10)}assert.equal(blocked,true,'fixture never reached an actual SQL table-lock wait');
  const abortAt=Date.now();controller.abort();await rejected;assert.ok(Date.now()-abortAt<1000,'deadline did not interrupt the active SQL wait');await holder.query('ROLLBACK');
  let released=false;for(let i=0;i<100;i++){released=(await holder.query('SELECT pg_try_advisory_lock(4202625) AS locked')).rows[0].locked;if(released)break;await delay(10)}assert.equal(released,true,'cancelled catch-up leaked its session advisory lock');assert.ok(Date.now()-abortAt<1000,'disconnected SQL session retained its lock too long');await holder.query('SELECT pg_advisory_unlock(4202625)');
  assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout,baselineTimeout,'catch-up timeout leaked into the normal pool');
  const deferred=await syncNativeProjection(pool,config,32,{nonblocking:true});assert.equal(deferred.deferred,true,'migration census must remain with the scheduled projector');assert.equal((await pool.query('SELECT cursor FROM native_epochs')).rows[0].cursor,'0');
 }finally{controller?.abort();if(holder){await holder.query('ROLLBACK').catch(()=>{});holder.release()}await pool?.end();await admin.query('DROP DATABASE IF EXISTS '+name);await admin.end();await rm(root,{recursive:true,force:true})}
});
