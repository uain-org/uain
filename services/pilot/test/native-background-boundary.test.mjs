import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {boot} from './helpers.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TABLES} from '../../../chain/migration/schema.mjs';

const run=promisify(execFile);
test('queued pilot maintenance checks authority again before running', async()=>{
 const policy=await import('../dist/src/operations/background-policy.js');
 const original=process.env.UAIN_AUTHORITY,timeout=globalThis.setTimeout,interval=globalThis.setInterval,callbacks=[];
 let writes=0;
 try{
  globalThis.setTimeout=globalThis.setInterval=(fn)=>{callbacks.push(fn);return {unref(){return this}}};
  process.env.UAIN_AUTHORITY='pilot';
  policy.schedulePilotMaintenance(()=>writes++,3600000,60000);
  assert.equal(callbacks.length,2);callbacks[0]();assert.equal(writes,1);
  process.env.UAIN_AUTHORITY='native';
  for(const callback of callbacks)callback();
  policy.schedulePilotMaintenance(()=>writes++,3600000,60000);
  assert.equal(writes,1);assert.equal(callbacks.length,2);
  assert.throws(()=>policy.assertPilotSourceWritable(),/native authority.*frozen/);
  process.env.UAIN_AUTHORITY='misspelled-native';
  assert.throws(()=>policy.pilotSourceWritable(),/explicit pilot or native/);
 }finally{
  globalThis.setTimeout=timeout;globalThis.setInterval=interval;
  if(original===undefined)delete process.env.UAIN_AUTHORITY;else process.env.UAIN_AUTHORITY=original;
 }
});
test('native server imports, maintenance callbacks and stale pilot writes preserve every captured source table', {timeout:120000}, async()=>{
 const t=await boot();
 let fixtureDir;
 try {
  const member=await t.member('Frozen source operator','frozen-source');
  const {pool}=await import('../dist/src/storage/store.js');
  // Old-source shapes deliberately exercise startup migrations, including an
  // otherwise legitimate expired future task and unclassified resources.
  await pool.query('UPDATE participants SET resources=NULL, last_seen_at=$1 WHERE id=$2',['2000-01-01T00:00:00.000Z',member.id]);
  await pool.query('UPDATE device_tokens SET last_used_at=$1',[new Date(Date.now()-2*3600000).toISOString()]);
  await pool.query("INSERT INTO projects(id,title,summary,lead,opened_at) VALUES('P-freeze','Frozen','Frozen original source',$1,$2)",[member.id,new Date().toISOString()]);
  const kpi=JSON.stringify({statement:'Original unresolved trial',metric:'response',comparator:'>=',threshold:40,unit:'%',source:'NCT01234567',resolves_by:'2000-01-01'});
  await pool.query("INSERT INTO tasks(id,project_id,title,question,done_when,how_to_check,created_by,created_at,kind,kpi,resolves_by) VALUES('T-freeze','P-freeze','Frozen future','Question','Done','Check',$1,$2,'future',$3,'2000-01-01')",[member.id,new Date().toISOString(),kpi]);
  await pool.query("INSERT INTO participants(id,did,name,operator,reachability,region,lon,lat,karma,enrolled_at,last_seen_at) VALUES('legacy-unadopted','did:fixture:frozen','Original legacy instance','Original operator','outbound','earth',0,0,7,$1,$1)",[new Date().toISOString()]);
  const snapshot=async()=>{
   const result={};
   for(const table of TABLES)result[table]=(await pool.query(`SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows.map(x=>x.row);
   return result;
  };
  const before=await snapshot();
  const sessionsBefore=(await pool.query('SELECT row_to_json(t)::text AS row FROM device_tokens t ORDER BY hash')).rows;
  const source=`
   const callbacks=[];
   const originalTimeout=globalThis.setTimeout,originalInterval=globalThis.setInterval;
   globalThis.setTimeout=(fn,ms,...args)=>{if([5000,60000,3600000].includes(ms)){callbacks.push({fn,ms,args});return {unref(){return this}}}return originalTimeout(fn,ms,...args)};
   globalThis.setInterval=(fn,ms,...args)=>{if([5000,60000,3600000].includes(ms)){callbacks.push({fn,ms,args});return {unref(){return this}}}return originalInterval(fn,ms,...args)};
   await import('./dist/src/api/server.js');
   await (await import('./dist/src/ledger/ledger.js')).dayRoot('2000-01-01');
   const db=await import('./dist/src/application/db.js'),kpi=await import('./dist/src/application/kpi.js'),writer=await import('./dist/src/runtime/writer.js');
   const rejected=async(fn)=>{try{await fn();return false}catch(e){return /native authority.*frozen/.test(e.message)}};
   await writer.startWriter();
   const running=writer.writerRunning();
   const blocked={expiry:await rejected(()=>kpi.expireKpis()),record:await rejected(()=>db.record('task','stale-pilot','Must not append')),migration:await rejected(()=>db.migrateRejected()),write:await rejected(()=>db.setUainRole({participant:process.env.FIXTURE_MEMBER,role:'default-verifier',on:false,by:'operator:stale'}))};
   if(!(await db.authenticate(process.env.FIXTURE_TOKEN)))throw Error('fixture session did not authenticate');await db.flushSeen();
   // Invoke any import-created source-maintenance callbacks immediately.
   for(const c of callbacks)await c.fn(...c.args);
   await new Promise(resolve=>originalTimeout(resolve,150));
   await writer.stopWriter();await (await import('./dist/src/storage/store.js')).close();
   console.log('BOUNDARY_RESULT='+JSON.stringify({running,blocked,maintenance:callbacks.filter(c=>c.fn.name!=='prune').length,operationalPrunes:callbacks.filter(c=>c.fn.name==='prune').length}));
  `;
  fixtureDir=await mkdtemp(join(tmpdir(),'uain-background-child-'));
  const fixture=join(fixtureDir,'child.mjs');
  await writeFile(fixture,source.replace(/'\.\/dist\/([^']+)'/g,(_,path)=>JSON.stringify(new URL('../dist/'+path,import.meta.url).href)));
  const result=await run(process.execPath,[fixture],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,UAIN_AUTHORITY:'native',UAIN_NATIVE_PROJECTION:'1',UAIN_WRITE_THREAD:'1',UAIN_NATIVE_STATE_BINARY:'/fixture/not-executed/state',UAIN_NATIVE_STATE_SHA256:'a'.repeat(64),UAIN_NATIVE_GENESIS:'/fixture/not-executed/genesis',UAIN_NATIVE_GENESIS_SHA256:'b'.repeat(64),UAIN_NATIVE_RPC:'http://127.0.0.1:1',FIXTURE_TOKEN:member.token,FIXTURE_MEMBER:member.id},timeout:60000,maxBuffer:1024*1024});
  await rm(fixtureDir,{recursive:true,force:true});
  const report=JSON.parse(result.stdout.split('\n').find(x=>x.startsWith('BOUNDARY_RESULT=')).slice('BOUNDARY_RESULT='.length));
  assert.deepEqual(await snapshot(),before,'native startup/maintenance changed captured source rows');
  assert.deepEqual((await pool.query('SELECT row_to_json(t)::text AS row FROM device_tokens t ORDER BY hash')).rows,sessionsBefore,'native authentication touched frozen sessions');
  assert.deepEqual(report.blocked,{expiry:true,record:true,migration:true,write:true},'stale pilot execution must fail closed');
  assert.equal(report.running,false,'native authority started the pilot writer thread');
  assert.equal(report.maintenance,0,'native authority registered source-maintenance timers');
  assert.equal(report.operationalPrunes,2,'native authority disabled operational access-log retention');
 }finally{if(fixtureDir)await rm(fixtureDir,{recursive:true,force:true});await t.close()}
});
