// A complete, isolated pilot schema with valid signed history and derived research.
import assert from 'node:assert/strict';
import {mkdirSync,copyFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {boot} from '../../services/pilot/test/helpers.mjs';
const root=process.env.UAIN_RESET_BACKEND_FIXTURE_DIR;
assert.ok(root?.startsWith('/opt/uain-test/'));
mkdirSync(root,{recursive:true,mode:0o700});
const offset=86400000;
const endpoint=createServer(async(req,res)=>{
 let body='';for await(const part of req)body+=part;
 const {texts,model}=JSON.parse(body);
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model,vectors:texts.map(()=>[1,...Array(383).fill(0)])}));
});
await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
const t=await boot({UAIN_RESEARCH_SEARCH:'1',UAIN_EMBEDDING_TOKEN:'fixture-only',UAIN_EMBEDDING_ENDPOINT:`http://127.0.0.1:${endpoint.address().port}`});
const source=new URL(process.env.DATABASE_URL).pathname.slice(1);assert.match(source,/^uain_test_/);
const {pool,close}=await import('../../services/pilot/dist/src/storage/store.js');
// Only this disposable database's insertion clock is yesterday. The hash
// formula is unchanged, every entry is hashed at insertion, and the original
// function is restored before any backup or reset. Production is never named.
const original=(await pool.query("SELECT pg_get_functiondef('append_ledger(jsonb)'::regprocedure) AS definition")).rows[0].definition;
assert.ok(original.includes("clock_timestamp() AT TIME ZONE 'UTC'"));
await pool.query(original.replace("clock_timestamp() AT TIME ZONE 'UTC'","(clock_timestamp() - interval '1 day') AT TIME ZONE 'UTC'"));
const lead=await t.enrol({name:'Reset fixture author',operator:'Isolated fixture lab',model:'fixture'});await t.makeUain(lead.id);
const project=await t.db.propose({lead:lead.id,title:'Reset fixture project',summary:'Known-answer fixture only; never production.',stopConditions:['Stop outside the isolated fixture.']});
const contribution=await t.db.contribute({contributor:lead.id,projectId:project.id,title:'Fixture research',detail:'A record to archive and reset in tests.',artifacts:[],karmaClaimed:1});
assert.ok(contribution.id);
const {indexResearchOne}=await import('../../services/pilot/dist/src/research/index.js');await indexResearchOne();
await pool.query(original);
// Named native history is retained byte for byte; only epoch liveness and
// pending work change. These explicit synthetic records never assert real proof.
const {readyNativeSchema}=await import('../../services/pilot/dist/src/native/schema.js');
const nativeEnv={UAIN_NATIVE_PROJECTION:'1',UAIN_NATIVE_STATE_BINARY:'/fixture/public-reader',UAIN_NATIVE_STATE_SHA256:'0'.repeat(64),UAIN_NATIVE_GENESIS:'/fixture/public-genesis',UAIN_NATIVE_GENESIS_SHA256:'0'.repeat(64),UAIN_NATIVE_RPC:'http://127.0.0.1:1'};
const previous=Object.fromEntries(Object.keys(nativeEnv).map(k=>[k,process.env[k]]));Object.assign(process.env,nativeEnv);
const client=await pool.connect();try{await readyNativeSchema(client)}finally{client.release();for(const [k,v] of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v}
const epoch='a'.repeat(64),retired='b'.repeat(64),proof='c'.repeat(64);
await pool.query('INSERT INTO native_epochs(epoch,chain_id,genesis_sha256,cursor,state_height,app_hash,retired_at) VALUES($1,$2,$1,$3,$4,$5,NULL),($6,$7,$6,$3,$4,$5,$8)',[epoch,'isolated-old-native','1','3','d'.repeat(64),retired,'isolated-retired-native','2026-01-01T00:00:00Z']);
await pool.query('INSERT INTO native_proof_batches VALUES($1,$2,$3,$4,$5)',[epoch,proof,'3','d'.repeat(64),{synthetic:true,records:{event:{id:'1'}}}]);
await pool.query('INSERT INTO native_events VALUES($1,$2,$3,$4,$5,$6,$7)',[epoch,'1','e'.repeat(64),{id:'1',member:lead.id,operation:'submit',subject:'native-fixture'},'3','d'.repeat(64),proof]);
await pool.query('INSERT INTO native_projection_queue VALUES($1,$2,$3)',[epoch,'pending-native-fixture','1']);
await pool.query('INSERT INTO native_journal_cursors VALUES($1,$2,$3)',[epoch,'credit','1']);
await pool.query('INSERT INTO native_journal_entries VALUES($1,$2,$3,$4,$5,$6)',[epoch,'credit','1','1',{id:'1',member:lead.id,amount:'19',contribution:'native-fixture'},proof]);
const body={title:'Historical native fixture',detail:'Preserve the exact original body and attributed proof across reset.'},canonical=JSON.stringify(body);
await pool.query('INSERT INTO native_publications(epoch,id,member,instance,evidence_digest,canonical_body,body,receipt,replica_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[epoch,'native-fixture',lead.id,'fixture-instance','f'.repeat(64),canonical,body,{synthetic:true,event_id:'1'},'f'.repeat(64)]);
await pool.query('INSERT INTO native_research_documents(epoch,id,project_id,task_id,contributor,instance,state,source_kind,source_hash,evidence_digest,body,proof,state_height,app_hash,indexed_hash,indexed_model,indexed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$9,$14,now())',[epoch,'native-fixture','fixture-project','fixture-task',lead.id,'fixture-instance','submitted','native','f'.repeat(64),body,{synthetic:true},'3','d'.repeat(64),'fixture-model']);
await pool.query('INSERT INTO native_research_chunks(epoch,contribution_id,ordinal,source_hash,model,body,embedding) VALUES($1,$2,0,$3,$4,$5,$6)',[epoch,'native-fixture','f'.repeat(64),'fixture-model',body.detail,'['+[1,...Array(383).fill(0)].join(',')+']']);
const nativeHistory={};for(const table of ['native_epochs','native_proof_batches','native_events','native_journal_cursors','native_journal_entries','native_publications','native_research_documents','native_research_chunks'])nativeHistory[table]=(await pool.query('SELECT to_jsonb(t) AS record FROM '+table+' t ORDER BY to_jsonb(t)::text COLLATE "C"')).rows.map(r=>r.record);
const completedDay=new Date(Date.now()-offset).toISOString().slice(0,10);
const ledger=await import('../../services/pilot/dist/src/ledger/ledger.js');
const daily=await ledger.dayRoot(completedDay);assert.ok(daily.count>0&&!daily.provisional&&ledger.verifyRootSignature(daily));
const events=(await pool.query('SELECT * FROM events ORDER BY id')).rows;assert.equal(ledger.verifyChain(events).ok,true);
for(const file of ['ledger.key','log.salt']){copyFileSync(join(process.env.UAIN_DATA_DIR,file),join(root,file));chmodSync(join(root,file),0o600);}
writeFileSync(join(root,'public.json'),JSON.stringify({database:source,events,root:daily,key:ledger.publicKeyInfo(),project:project.id,contribution:contribution.id,nativeHistory},null,2));
await close();endpoint.close();
console.log(JSON.stringify({database:source,event_count:events.length,root_count:daily.count,derived_index:true}));
// Deliberately retain this disposable database for the separate reset rehearsal.
process.exit(0);
