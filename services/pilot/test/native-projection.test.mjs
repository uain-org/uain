import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {before,after} from 'node:test';
import {mkdtemp,writeFile,chmod,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import {boot} from './helpers.mjs';
const mod=await import('../dist/src/native/evidence.js').catch(()=>({}));
test('native publication replica is durable, immutable and contains public evidence only',async()=>{
 const replica=await import('../dist/src/native/replica.js').catch(()=>({}));
 assert.equal(typeof replica.retainPublicationReplica,'function','durable native publication copy required');
 const dir=await mkdtemp(join(tmpdir(),'uain-native-replica-'));
 try{
  const capsule={format:'uain-native-publication-v1',canonical_body:'public evidence',receipt:{envelope:{signature:'public'}}};
  const digest=await replica.retainPublicationReplica(capsule,dir);
  assert.equal(await replica.retainPublicationReplica(capsule,dir),digest);
  assert.deepEqual(JSON.parse(await readFile(join(dir,digest+'.json'),'utf8')),capsule);
  assert.equal((await stat(join(dir,digest+'.json'))).mode&0o777,0o600);
  assert.deepEqual(await readdir(dir),[digest+'.json']);
  await writeFile(join(dir,digest+'.json'),'changed');
  await assert.rejects(()=>replica.retainPublicationReplica(capsule,dir),/differs/);
  await chmod(dir,0o755);await assert.rejects(()=>replica.retainPublicationReplica(capsule,dir),/private/);
  await assert.rejects(()=>replica.retainPublicationReplica(capsule,'relative'),/absolute/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('native evidence publication has a bounded deterministic content commitment',()=>{
 assert.equal(typeof mod.evidenceDocument,'function','native evidence commitment required');
 const body={detail:'A complete independently checkable research body.',title:'Original research',sources:['https://example.org/source']};
 const first=mod.evidenceDocument(body),second=mod.evidenceDocument({sources:body.sources,title:body.title,detail:body.detail});
 assert.equal(first.digest,second.digest);assert.equal(first.digest,createHash('sha256').update('uain:research-evidence:v1\n'+first.canonical).digest('hex'));
 assert.throws(()=>mod.evidenceDocument({...body,private_key:'secret'}),/fields/);
 assert.throws(()=>mod.evidenceDocument({...body,detail:'x'.repeat(49000)}),/bound/);
});

test('native evidence preserves finite probabilities and reproducibility metrics across client and server',async()=>{
 const {researchEvidence}=await import('../../../chain/client/evidence-document.mjs');
 const body={title:'Measured research',detail:'An independently reproducible result with fractional metrics.',forecast:{probability:0.125},reproduction:{expected:{accuracy:0.9875},tolerance:{accuracy:0.0001}}};
 assert.deepEqual(mod.evidenceDocument(body),researchEvidence(body));
 for(const bad of [NaN,Infinity,-Infinity,9007199254740992]){
  assert.throws(()=>mod.evidenceDocument({...body,forecast:{probability:bad}}));
  assert.throws(()=>researchEvidence({...body,forecast:{probability:bad}}));
 }
});

test('complete public source projects into a separate native epoch, publishes exact evidence and rebuilds retrieval',
 {skip:!process.env.UAIN_MIGRATION_SNAPSHOT||!process.env.UAIN_TEST_PG||process.env.UAIN_TEST_VECTOR!=='1',timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'uain-native-projection-'));let t,embedding;
 try{
  const source=JSON.parse(await readFile(process.env.UAIN_MIGRATION_SNAPSHOT,'utf8'));
  const {memberAddress,signedEnvelope}=await import('../../../chain/client/signing.mjs');
  const {researchEvidence}=await import('../../../chain/client/evidence-document.mjs');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({type:'spki',format:'der'}).subarray(-32),member=memberAddress(raw);
  const body={title:'Unique projection fixture',detail:'A uniqueprojectionfixture research result with an independently checkable complete body.'},document=mod.evidenceDocument(body);
  assert.deepEqual(document,researchEvidence(body),'client and publication commitments differ');
  const envelope=signedEnvelope({version:1,chain_id:'isolated-projection',member,instance:'projection-fixture',sequence:'0',expires_height:'100',operation:'submit',payload:{id:'native-projection-fixture',task:'native-task',evidence_digest:document.digest}},raw,privateKey);
  const records=Object.fromEntries(source.records.map(r=>[r.key,JSON.parse(r.value)]));
  records.legacy_import={status:'ready'};
  records['contribution/native-projection-fixture']={id:'native-projection-fixture',task:'native-task',author:member,author_instance:'projection-fixture',state:'held',storage_policy:'compact-state-v1',evidence_digest:document.digest};
  records['task/native-task']={id:'native-task',project:'native-project',state:'open',submissions:['native-projection-fixture']};
  for(let i=1;i<=3;i++)records['event/'+String(i).padStart(20,'0')]={id:String(i),height:String(i),member,instance:'projection-fixture',operation:i===1?'legacy_finish':i===2?'submit':'verify',subject:i===1?source.manifest_digest:'native-projection-fixture',command_digest:String(i).repeat(64)};
  const fixture=join(dir,'public.json'),executable=join(dir,'reader'),genesis=join(dir,'genesis.json');
  await writeFile(fixture,JSON.stringify({records,event_count:'3'}));await writeFile(genesis,'{}');
  // Explicit process-boundary fixture only. Signed-header/IAVL and envelope
  // verification are separately covered by SDK and real-node client tests.
  const script=`#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const r=JSON.parse(input),s=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}));const args=process.argv.slice(2),records={legacy_import:s.records.legacy_import};for(const k of r.keys||[])records[k]=s.records[k]??null;const out={chain_id:'isolated-projection',height:'10',header_time:new Date().toISOString(),app_hash:'a'.repeat(64),event_count:s.event_count,records};if(r.receipt){if(r.receipt.envelope.signature!==${JSON.stringify(envelope.signature)})process.exit(2);out.receipt={finalized:true,event:s.records['event/'+r.receipt.event_id.padStart(20,'0')]};}fs.writeFileSync(args[args.indexOf('--out')+1],JSON.stringify(out),{mode:384,flag:'wx'});});\n`;
  await writeFile(executable,script);await chmod(executable,0o700);
  embedding=createServer(async(req,res)=>{let data='';for await(const part of req)data+=part;const input=JSON.parse(data);res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'bge-small-en-v1.5:aa8f8b060edb00e03bfdd08813a2949946c8ba55:chunks-v1',vectors:input.texts.map(text=>{const v=Array(384).fill(0);v[text.includes('uniqueprojectionfixture')?0:1]=1;return v})}))});
  await new Promise(r=>embedding.listen(0,'127.0.0.1',r));
  t=await boot({UAIN_NATIVE_PUBLICATION_DIR:join(dir,'replicas'),UAIN_AUTHORITY:'native',UAIN_NATIVE_PROJECTION:'1',UAIN_NATIVE_STATE_BINARY:executable,UAIN_NATIVE_STATE_SHA256:createHash('sha256').update(script).digest('hex'),UAIN_NATIVE_GENESIS:genesis,UAIN_NATIVE_GENESIS_SHA256:createHash('sha256').update('{}').digest('hex'),UAIN_NATIVE_RPC:'http://127.0.0.1:1',UAIN_RESEARCH_SEARCH:'1',UAIN_EMBEDDING_ENDPOINT:`http://127.0.0.1:${embedding.address().port}`,UAIN_EMBEDDING_TOKEN:'isolated-test-only'});
  const {pool}=await import('../dist/src/storage/store.js'),{nativeConfig}=await import('../dist/src/api/native-routes.js');
  const {syncNativeProjection,projectNativeDocumentOne,publishNativeEvidence}=await import('../dist/src/native/projection.js');
  const {indexNativeResearchOne,searchNativeResearch,nativeAuthorityStatus}=await import('../dist/src/native/research.js'),config=nativeConfig();
  const ledgerBefore=(await pool.query('SELECT count(*)::text AS n FROM events')).rows[0].n;
  const mcp=await t.connect(),tools=(await mcp.client.listTools()).tools.map(x=>x.name);assert.ok(tools.includes('uain_guide'));assert.ok(!tools.includes('uain_native_submit'),'native-client tools are callable but not listed');assert.ok(!tools.includes('uain_contribute'));
  assert.equal((await t.http('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,409,'native authority accepted a stale pilot write');
  const first=await syncNativeProjection(pool,config);assert.equal(first.cursor,'3');assert.equal((await syncNativeProjection(pool,config)).cursor,'3');
  for(let i=0;i<100&&await projectNativeDocumentOne(pool,config);i++){}
  assert.equal((await pool.query("SELECT count(*)::text AS n FROM native_research_documents WHERE source_kind='legacy'")).rows[0].n,'82');
  assert.equal((await nativeAuthorityStatus(pool,config)).ready,false);
  await assert.rejects(()=>publishNativeEvidence(pool,config,{envelope,event_id:'2',body:{...body,detail:body.detail+' changed'}}),/differs/);
  await assert.rejects(()=>publishNativeEvidence(pool,config,{envelope:{...envelope,signature:'forged'},event_id:'2',body}),/refused/);
  const published=await publishNativeEvidence(pool,config,{envelope,event_id:'2',body});assert.equal(published.evidence_digest,document.digest);
  const capsule=JSON.parse(await readFile(join(dir,'replicas',published.replica_digest+'.json'),'utf8'));assert.equal(capsule.canonical_body,document.canonical);assert.deepEqual(capsule.receipt.envelope,envelope);
  assert.equal((await publishNativeEvidence(pool,config,{envelope,event_id:'2',body})).replica_digest,published.replica_digest);assert.equal((await pool.query('SELECT count(*)::text AS n FROM native_publications')).rows[0].n,'1');
  await projectNativeDocumentOne(pool,config);
  for(let i=0;i<100&&await indexNativeResearchOne(pool,config);i++){}
  assert.equal((await nativeAuthorityStatus(pool,config)).ready,true);
  const {syncNativeJournals}=await import('../dist/src/native/journals.js');
  records.credit_count=2;records.karma_count=1;
  records['credit/00000000000000000001']={id:'00000000000000000001',event_id:'3',member,instance:'projection-fixture',contribution:'native-projection-fixture',kind:'work',amount:'10',minted:'7',deferred:'3',at:'2026-10-12T00:00:00Z'};
  records['credit/00000000000000000002']={id:'00000000000000000002',event_id:'3',member,instance:'projection-fixture',contribution:'native-projection-fixture',kind:'release',amount:'3',minted:'3',deferred:'0',at:'2026-10-12T00:00:00Z'};
  records['karma/00000000000000000001']={id:'00000000000000000001',event_id:'3',member,instance:'projection-fixture',ref:'native-projection-fixture',kind:'verified',delta:10,at:'2026-10-12T00:00:00Z'};
  await writeFile(fixture,JSON.stringify({records,event_count:'3'}));assert.equal((await nativeAuthorityStatus(pool,config)).ready,false,'authority ignored unprojected native financial journals');
  assert.equal((await syncNativeJournals(pool,config,1)).more,true);assert.equal((await syncNativeJournals(pool,config,1)).more,false);
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM native_journal_entries')).rows[0].n,'3');assert.equal((await syncNativeJournals(pool,config)).more,false);
  assert.equal((await nativeAuthorityStatus(pool,config)).ready,true);
  const publicStart=Date.now();
  const publicTasks=await t.http('/api/tasks?page_size=200');assert.equal(publicTasks.status,200);const publicTaskBody=await publicTasks.json();console.log('Cold native task HTTP read milliseconds:',Date.now()-publicStart);assert.ok(Date.now()-publicStart<8000,'cold native task read missed browser deadline');assert.equal(publicTaskBody.authority,'native');assert.equal(publicTaskBody.tasks.length,48);assert.equal((await (await t.http('/api/tasks/native-task')).json()).project_id,'native-project');
  const publicProjectID=source.records.find(r=>r.key.startsWith('legacy/project/')).key.slice('legacy/project/'.length);
  const publicProject=await t.http('/api/projects/'+publicProjectID);assert.equal(publicProject.status,200);const publicProjectBody=await publicProject.json();assert.equal(publicProjectBody.authority,'native');assert.ok(publicProjectBody.contributions.length>0);
  const publicContribution=await t.http('/api/contributions/native-projection-fixture');assert.equal(publicContribution.status,200);assert.equal((await publicContribution.json()).detail,body.detail);
  const activity=await t.http('/api/activity?limit=2');assert.equal(activity.status,200);const nativeActivity=await activity.json();assert.equal(nativeActivity.events[0].id,'3');assert.equal(nativeActivity.events[0].at,null);assert.equal(nativeActivity.events[0].height,'3');
  assert.equal((await t.http('/api/events?limit=2')).headers.get('x-uain-authority'),'legacy-archive');
  for(const name of ['uain_find_tasks','uain_tasks','uain_projects','uain_directory','uain_contributions'])assert.ok(tools.includes(name),'selected native MCP read missing '+name);
  const mcpRead=async(name,args)=>JSON.parse((await mcp.client.callTool({name,arguments:args})).content[0].text);
  assert.equal((await mcpRead('uain_tasks',{task_id:'native-task'})).project_id,'native-project');
  assert.equal((await mcpRead('uain_contributions',{contribution_id:'native-projection-fixture'})).detail,body.detail);
  assert.equal((await mcpRead('uain_projects',{project_id:publicProjectID})).authority,'native');
  assert.equal((await mcpRead('uain_find_tasks',{status:'all',page_size:100})).authority,'native');
  console.log('Complete-source native public HTTP reads milliseconds:',Date.now()-publicStart);
  const cachedStart=Date.now();assert.equal((await t.http('/api/native/public/tasks?page_size=200')).status,200);assert.ok(Date.now()-cachedStart<8000,'checkpoint-cached native read missed browser deadline');
  console.log('Checkpoint-cached native task read milliseconds:',Date.now()-cachedStart);
  records.credit_count=3;records['credit/00000000000000000003']={...records['credit/00000000000000000002'],id:'00000000000000000003',amount:'4'};
  await writeFile(fixture,JSON.stringify({records,event_count:'3'}));assert.equal((await t.http('/api/native/public/tasks?page_size=200')).status,503,'stale cached read survived changed journal checkpoint');await assert.rejects(()=>syncNativeJournals(pool,config),/reconcile/);assert.equal((await pool.query("SELECT cursor FROM native_journal_cursors WHERE kind='credit'")).rows[0].cursor,'2');
  records.credit_count=1;await writeFile(fixture,JSON.stringify({records,event_count:'3'}));await assert.rejects(()=>syncNativeJournals(pool,config),/regressed/);
  records.credit_count=2;delete records['credit/00000000000000000003'];await writeFile(fixture,JSON.stringify({records,event_count:'3'}));

  const replicaDirectory=process.env.UAIN_NATIVE_PUBLICATION_DIR;delete process.env.UAIN_NATIVE_PUBLICATION_DIR;
  assert.equal((await nativeAuthorityStatus(pool,config)).ready,false,'readiness ignored missing durable publication storage');process.env.UAIN_NATIVE_PUBLICATION_DIR=replicaDirectory;
  const search=await searchNativeResearch(pool,config,{q:'uniqueprojectionfixture',limit:1});assert.equal(search.matches[0].id,'native-projection-fixture');assert.equal(search.matches[0].state,'held');
  records['task/native-task'].state='kpi_expired';records['event/00000000000000000004']={id:'4',height:'4',operation:'expire_kpi',origin:'consensus',subject:'native-task',command_digest:'4'.repeat(64)};
  await writeFile(fixture,JSON.stringify({records,event_count:'4'}));await syncNativeProjection(pool,config);
  for(let i=0;i<10&&await projectNativeDocumentOne(pool,config);i++){}
  const expired=await searchNativeResearch(pool,config,{q:'uniqueprojectionfixture',limit:1,state:'withheld'});assert.equal(expired.matches[0].state,'withheld','task-wide expiry did not update derived research status');
  const originalWorkID=source.records.find(r=>r.key.startsWith('legacy/work/')&&JSON.parse(r.value).task).key.slice('legacy/work/'.length),originalWork={...records['legacy/work/'+originalWorkID],state:'held',paid:false};
  records['legacy_work/'+originalWorkID]=originalWork;records['legacy_task/'+originalWork.task]={...records['legacy/task/'+originalWork.task],known:true,state:'closed'};
  records['event/00000000000000000005']={id:'5',height:'5',operation:'legacy_future_apply',origin:'member',subject:originalWorkID,command_digest:'5'.repeat(64)};
  await writeFile(fixture,JSON.stringify({records,event_count:'5'}));await syncNativeProjection(pool,config);for(let i=0;i<10&&await projectNativeDocumentOne(pool,config);i++){}
  assert.equal((await pool.query('SELECT state FROM native_research_documents WHERE id=$1',[originalWorkID])).rows[0].state,'withheld','original final future materialization did not update derived retrieval state');
  const batches=await pool.query('SELECT record,proof FROM native_events e JOIN native_proof_batches p ON p.epoch=e.epoch AND p.proof_digest=e.proof_digest');
  for(const batch of batches.rows)assert.ok(batch.proof.records['event/'+batch.record.id.padStart(20,'0')],'projected event lost its exact proof batch');
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM events')).rows[0].n,ledgerBefore,'projection mutated pilot ledger');
  await pool.query('DELETE FROM native_research_chunks');await pool.query('UPDATE native_research_documents SET indexed_hash=NULL,indexed_model=NULL');
  for(let i=0;i<100&&await indexNativeResearchOne(pool,config);i++){}
  assert.equal((await nativeAuthorityStatus(pool,config)).indexed,'83','immutable native documents did not rebuild retrieval');
  const {restorePublicationReplicas}=await import('../dist/src/native/restore-publications.js');
  await pool.query('DELETE FROM native_publications');await pool.query("UPDATE native_research_documents SET body=NULL WHERE source_kind='native'");
  assert.equal((await restorePublicationReplicas(pool,config)).restored,1);
  await projectNativeDocumentOne(pool,config);
  assert.equal((await pool.query("SELECT body FROM native_research_documents WHERE source_kind='native'")).rows[0].body.detail,body.detail,'app-host replica did not restore the native publication');
  await writeFile(fixture,JSON.stringify({records,event_count:'2'}));await assert.rejects(()=>syncNativeProjection(pool,config),/regressed/);
  assert.equal((await pool.query('SELECT cursor FROM native_epochs')).rows[0].cursor,'5');
 }finally{await t?.close();if(embedding)await new Promise(r=>embedding.close(r));await rm(dir,{recursive:true,force:true})}
});
