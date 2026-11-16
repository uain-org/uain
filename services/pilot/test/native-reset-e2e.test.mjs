import{test}from'node:test';import assert from'node:assert/strict';
import{generateKeyPairSync,createHash}from'node:crypto';
import{mkdtemp,mkdir,readFile,writeFile,cp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{spawn}from'node:child_process';import{createServer as netServer}from'node:net';import{createServer}from'node:http';import{setTimeout as delay}from'node:timers/promises';import{boot}from'./helpers.mjs';

test('a real guardian handover survives a two-node empty reset and new proved research composes with the empty baseline',
 {skip:process.env.UAIN_NATIVE_RESET_E2E!=='1'||!process.env.UAIN_TEST_PG||process.env.UAIN_TEST_VECTOR!=='1',timeout:240000},async()=>{
 const binary=process.env.UAIN_NATIVE_CHAIN_BINARY,stateBinary=process.env.UAIN_NATIVE_STATE_BINARY,offline=process.env.UAIN_RESET_CHECKPOINT_BINARY;
 assert.ok(binary&&stateBinary&&offline);const root=await mkdtemp(join(tmpdir(),'uain-native-reset-e2e-'));let nodes=[],t,embedding;
 const execute=(file,args,input)=>new Promise((resolve,reject)=>{const p=spawn(file,args,{stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>p.kill('SIGKILL'),70000);p.stdout.on('data',b=>{out+=b;if(out.length>8*1024*1024)p.kill('SIGKILL')});p.stderr.on('data',b=>err=(err+b).slice(-2048));p.on('error',reject);p.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error('isolated public command refused: '+err))});p.stdin.on('error',()=>{});p.stdin.end(input===undefined?'':JSON.stringify(input))});
 const port=async()=>{const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
 const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
 const stop=async()=>{await Promise.all(nodes.map(p=>new Promise(r=>{if(p.exitCode!==null)return r();p.once('close',r);p.kill('SIGTERM')})));nodes=[]};
 try{
  const{memberAddress,signedEnvelope}=await import('../../../chain/client/signing.mjs');
  const identity=name=>{const keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({format:'jwk'}).x;return{...keys,pub,id:memberAddress(Buffer.from(pub,'base64url')),name}};
  const old=identity('Outgoing fixture guardian'),current=identity('Consenting incoming fixture guardian');
  const member=k=>({id:k.id,public_key:k.pub,name:k.name,operator:'Single isolated fixture operator',family:'Fixture',licence:'active',karma:1234,credits:'17',sequence:'0',default_verifier:true,creator:true,active_projects:0});
  const rpcPort=await port(),fullPort=await port(),p2pPort=await port(),fullP2p=await port(),rpc='http://127.0.0.1:'+rpcPort;
  const initialize=async(prefix,chain,state)=>{
   const a=join(root,prefix+'-app'),b=join(root,prefix+'-full'),app=join(root,prefix+'-state.json');await writeFile(app,JSON.stringify(state));
   for(const[home,r,p]of[[a,rpcPort,p2pPort],[b,fullPort,fullP2p]])await execute(binary,['init','--home',home,'--chain-id',chain,'--app-genesis',app,'--rpc','tcp://127.0.0.1:'+r,'--p2p','tcp://127.0.0.1:'+p]);
   const genesis=join(a,'config/genesis.json');await writeFile(join(b,'config/genesis.json'),await readFile(genesis));
   // These node identities are generated inside the disposable fixture only.
   const nodeKey=JSON.parse(await readFile(join(a,'config/node_key.json'),'utf8')),pub=Buffer.from(nodeKey.priv_key.value,'base64').subarray(32),nodeID=createHash('sha256').update(pub).digest('hex').slice(0,40);
   const config=join(b,'config/config.toml');await writeFile(config,(await readFile(config,'utf8')).replace(/^persistent_peers = .*$/m,'persistent_peers = "'+nodeID+'@127.0.0.1:'+p2pPort+'"').replace(/^addr_book_strict = .*$/m,'addr_book_strict = false'));
   return{a,b,genesis};
  };
  const start=async homes=>{nodes=homes.map(home=>spawn(binary,['start','--home',home],{stdio:'ignore'}));for(let i=0;i<150;i++){try{const statuses=await Promise.all([rpcPort,fullPort].map(async port=>(await(await fetch('http://127.0.0.1:'+port+'/status')).json()).result));if(statuses.every(s=>BigInt(s.sync_info.latest_block_height)>=3n)){assert.equal(statuses[0].validator_info.voting_power,'10');assert.equal(statuses[1].validator_info.voting_power,'0');return}}catch{}await delay(200)}throw Error('two isolated nodes did not synchronize')};
  let homes=await initialize('old','isolated-reset-old-current-guardian',{version:1,guardians:[old.id],members:[member(old),member(current)]});await start([homes.a,homes.b]);
  let config={binary:stateBinary,binaryHash:await hash(stateBinary),genesis:homes.genesis,genesisHash:await hash(homes.genesis),rpc};
  const{nativeState,nativeSubmit}=await import('../dist/src/api/native-routes.js');
  const transact=async(actor,operation,payload,instance)=>{
   const before=await nativeState({member:actor.id},config),event=String(BigInt(before.event_count)+1n),command={version:1,chain_id:before.chain_id,member:actor.id,sequence:before.member.sequence,expires_height:String(BigInt(before.height)+200n),operation,payload,...(instance?{instance}:{})},envelope=signedEnvelope(command,Buffer.from(actor.pub,'base64url'),actor.privateKey);
   assert.equal((await nativeSubmit(envelope,config)).accepted,true,operation+' CheckTx');
   for(let i=0;i<80;i++){try{const proof=await nativeState({receipt:{envelope,event_id:event}},config);if(proof.receipt?.finalized)return{envelope,event_id:event,proof}}catch{}await delay(100)}throw Error(operation+' did not finalize');
  };
  const oldBody={title:'Old epoch evidence',detail:'An immutable public result retained across the explicitly reviewed empty reset.'},{researchEvidence:oldEvidence}=await import('../../../chain/client/evidence-document.mjs');
  const fixturePriorArt={basis:'Synthetic isolated qualification only; never production.',searches:['https://example.org/fixture','https://example.net/fixture']};
  await transact(current,'instance_create',{id:'old-instance',name:'Old epoch instance',family:'Fixture'});
  await transact(current,'open_project',{id:'old-project',title:'Old epoch project',class:'benevolent',prior_art:fixturePriorArt},'old-instance');
  await transact(current,'open_task',{id:'old-task',project:'old-project',title:'Old epoch task',class:'benevolent',prior_art:fixturePriorArt,criteria:'Check the exact synthetic old evidence under the isolated original epoch.',kind:'instant',karma_reward:0,credit_reward:'0'},'old-instance');
  const oldSubmit=await transact(current,'submit',{id:'old-result',task:'old-task',evidence_digest:oldEvidence(oldBody).digest},'old-instance');
  const oldCapsule={format:'uain-native-publication-v1',epoch:config.genesisHash,id:'old-result',evidence_digest:oldEvidence(oldBody).digest,canonical_body:oldEvidence(oldBody).canonical,receipt:{envelope:oldSubmit.envelope,state:oldSubmit.proof}};
  const action={proposal:'fixture-handover',evidence_digest:'a'.repeat(64)},height=(await nativeState({},config)).height;
  await transact(old,'guardian_propose',{id:action.proposal,base_epoch:'',guardians:[current.id],expires_height:Number(height)+400,evidence_digest:action.evidence_digest});
  await transact(old,'guardian_vote',action);await transact(current,'guardian_consent',action);await transact(old,'guardian_execute',action);
  const proved=await nativeState({member:current.id,keys:['guardian_epoch_current','guardian_epoch/'+action.proposal]},config);assert.equal(proved.records.guardian_epoch_current,action.proposal);
  // Wait for the non-validator to contain the same finalized checkpoint.
  for(let i=0;i<80;i++){const full=await nativeState({member:current.id,keys:['guardian_epoch_current']},{...config,rpc:'http://127.0.0.1:'+fullPort});if(full.event_count===proved.event_count)break;await delay(100)}
  await stop();const copied=join(root,'public-application-copy');await mkdir(copied);await cp(join(homes.a,'data/application.db'),join(copied,'application.db'),{recursive:true});
  const checkpoint=JSON.parse(await execute(offline,['--database-dir',copied,'--genesis',homes.genesis,'--genesis-sha256',config.genesisHash]));
  assert.deepEqual(checkpoint.guardians,[current.id]);assert.deepEqual(checkpoint.members,[proved.member]);assert.equal(checkpoint.epoch,action.proposal);assert.equal(checkpoint.event_count,proved.event_count);
  const oldGenesis=JSON.parse(await readFile(homes.genesis,'utf8')),legacy={manifest_digest:'c'.repeat(64),ledger_head:'d'.repeat(64),last_event_id:42,pinned_public_key:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})};
  const state=JSON.parse(await execute('/usr/bin/python3',['-c',"import sys,json;sys.path.insert(0,'../../ops/reset');import native;v=json.load(sys.stdin);print(json.dumps(native.fresh_state(v['old'],v['legacy'],v['checkpoint'])))"],{old:oldGenesis,legacy,checkpoint}));
  assert.deepEqual(state.guardians,[current.id]);assert.equal(state.members[0].credits,'0');assert.equal(state.members[0].karma,0);assert.equal(state.members[0].sequence,'0');assert.equal(state.members[0].creator,false);assert.equal(state.members[0].default_verifier,false);
  homes=await initialize('reset','uain-reset-20261012_030405',state);await start([homes.a,homes.b]);config={...config,genesis:homes.genesis,genesisHash:await hash(homes.genesis)};
  const{readNativeBaseline}=await import('../dist/src/native/baseline.js');assert.equal((await readNativeBaseline(config)).mode,'reset_empty');
  const full=await readNativeBaseline({...config,rpc:'http://127.0.0.1:'+fullPort});assert.deepEqual(full.members,[current.id]);assert.equal(full.state.records.legacy_import,null);assert.equal(full.state.records.legacy_adoption,null);
  embedding=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const input=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'bge-small-en-v1.5:aa8f8b060edb00e03bfdd08813a2949946c8ba55:chunks-v1',vectors:input.texts.map(()=>[1,...Array(383).fill(0)])}))});await new Promise(r=>embedding.listen(0,'127.0.0.1',r));
  await mkdir(join(root,'capsules'),{mode:0o700});
  t=await boot({UAIN_AUTHORITY:'native',UAIN_NATIVE_PROJECTION:'1',UAIN_NATIVE_STATE_BINARY:stateBinary,UAIN_NATIVE_STATE_SHA256:config.binaryHash,UAIN_NATIVE_GENESIS:homes.genesis,UAIN_NATIVE_GENESIS_SHA256:config.genesisHash,UAIN_NATIVE_RPC:rpc,UAIN_NATIVE_PUBLICATION_DIR:join(root,'capsules'),UAIN_RESEARCH_SEARCH:'1',UAIN_EMBEDDING_ENDPOINT:'http://127.0.0.1:'+embedding.address().port,UAIN_EMBEDDING_TOKEN:'isolated-only'});
  const{pool}=await import('../dist/src/storage/store.js'),{syncNativeProjection,projectNativeDocumentOne,publishNativeEvidence}=await import('../dist/src/native/projection.js'),{syncNativeJournals}=await import('../dist/src/native/journals.js'),{nativeAuthorityStatus,indexNativeResearchOne,searchNativeResearch}=await import('../dist/src/native/research.js');
  await syncNativeProjection(pool,config);await syncNativeJournals(pool,config);let status=await nativeAuthorityStatus(pool,config);assert.equal(status.ready,true);assert.equal(status.expected_original_research,'0');assert.equal(status.import_status,'reset_empty');
  const get=async path=>{const r=await t.http(path);return{status:r.status,body:await r.json()}};const empty=await get('/api/stats');assert.equal(empty.status,200);assert.equal(empty.body.member_count,1);assert.equal(empty.body.contributions,0);
  await pool.query('UPDATE native_epochs SET chain_id=$2 WHERE epoch=$1',[config.genesisHash,'wrong-chain']);assert.equal((await nativeAuthorityStatus(pool,config)).ready,false);assert.equal((await t.http('/api/stats')).status,503);await pool.query('UPDATE native_epochs SET chain_id=$2 WHERE epoch=$1',[config.genesisHash,full.state.chain_id]);
  await pool.query('UPDATE native_epochs SET retired_at=now() WHERE epoch=$1',[config.genesisHash]);assert.equal((await nativeAuthorityStatus(pool,config)).ready,false);assert.equal((await t.http('/api/stats')).status,503);await pool.query('UPDATE native_epochs SET retired_at=NULL WHERE epoch=$1',[config.genesisHash]);
  // Bootstrap roles are a new explicit signed appointment, never reset carryover.
  await transact(current,'roles',{member:current.id,creator:true,default_verifier:false,evidence_digest:'e'.repeat(64)});
  await transact(current,'instance_create',{id:'reset-instance',name:'New epoch instance',family:'Fixture'});
  const prior_art={basis:'Synthetic isolated reset qualification only; never a production research claim.',searches:['https://example.org/isolated-a','https://example.net/isolated-b']};
  await transact(current,'open_project',{id:'reset-project',title:'New epoch research',class:'benevolent',prior_art},'reset-instance');
  await transact(current,'open_task',{id:'reset-task',project:'reset-project',title:'New epoch task',class:'benevolent',prior_art,criteria:'Check the exact synthetic evidence under the new epoch.',kind:'instant',karma_reward:0,credit_reward:'0'},'reset-instance');
  const body={title:'New epoch evidence',detail:'A resetuniquecheck result with independent exact evidence attribution.'},{researchEvidence}=await import('../../../chain/client/evidence-document.mjs');
  const submitted=await transact(current,'submit',{id:'reset-result',task:'reset-task',evidence_digest:researchEvidence(body).digest},'reset-instance');await publishNativeEvidence(pool,config,{body,envelope:submitted.envelope,event_id:submitted.event_id});
  await syncNativeProjection(pool,config);await syncNativeJournals(pool,config);for(let i=0;i<10&&await projectNativeDocumentOne(pool,config);i++){}await indexNativeResearchOne(pool,config);
  status=await nativeAuthorityStatus(pool,config);assert.equal(status.ready,true);assert.equal(status.total,'1');const result=(await searchNativeResearch(pool,config,{q:'resetuniquecheck',limit:1})).matches[0];assert.equal(result.id,'reset-result');assert.equal(result.contributor,current.id);assert.equal(result.instance,'reset-instance');
  const anonymous=await t.connect(),mcpResult=await anonymous.call('uain_search_research',{q:'resetuniquecheck',limit:1});assert.equal(mcpResult.matches[0].id,'reset-result');assert.equal(mcpResult.matches[0].contributor,current.id);
  const originalRows=(await pool.query('SELECT * FROM native_publications WHERE epoch=$1',[config.genesisHash])).rows;assert.equal(originalRows.length,1);const capsule=join(root,'capsules',originalRows[0].replica_digest+'.json'),originalBytes=await readFile(capsule);await rm(capsule);
  const restored=JSON.parse(await execute(process.execPath,['scripts/recover-native-publications.mjs','--epoch',config.genesisHash,'--directory',join(root,'capsules'),'--limit','1']));assert.equal(restored.restored,1);assert.equal(restored.more,false);assert.deepEqual(await readFile(capsule),originalBytes);assert.deepEqual((await pool.query('SELECT * FROM native_publications WHERE epoch=$1',[config.genesisHash])).rows,originalRows);
  const{retainPublicationReplica}=await import('../dist/src/native/replica.js'),{restorePublicationReplicas}=await import('../dist/src/native/restore-publications.js');
  const oldReplica=await retainPublicationReplica(oldCapsule,join(root,'capsules')),replayed=await restorePublicationReplicas(pool,config,join(root,'capsules'));
  for(let i=0;i<10&&await projectNativeDocumentOne(pool,config);i++){}await indexNativeResearchOne(pool,config);
  assert.equal(replayed.restored,1);assert.equal(replayed.skipped_foreign,1);assert.equal((await pool.query('SELECT count(*)::text AS n FROM native_publications WHERE epoch=$1',[oldCapsule.epoch])).rows[0].n,'0');
  assert.equal(createHash('sha256').update(await readFile(join(root,'capsules',oldReplica+'.json'))).digest('hex'),oldReplica);
  const publicResult=await get('/api/contributions/reset-result');assert.equal(publicResult.status,200);assert.equal(publicResult.body.detail,body.detail);assert.equal((await get('/api/native/public/projects')).body.count,1,'the strict twin shows new proved research at once');assert.equal(typeof (await get('/api/projects')).body.proved?.age_seconds,'number','the browse list says how old its proved copy is');
  const resetHeight=(await nativeState({},config)).height,resetAction={proposal:'reset-current-epoch',evidence_digest:'f'.repeat(64)};
  await transact(current,'guardian_propose',{id:resetAction.proposal,base_epoch:'',guardians:[current.id],expires_height:Number(resetHeight)+400,evidence_digest:resetAction.evidence_digest});await transact(current,'guardian_vote',resetAction);await transact(current,'guardian_execute',resetAction);
  assert.equal((await readNativeBaseline(config)).state.records.guardian_epoch_current,resetAction.proposal);await syncNativeProjection(pool,config);assert.equal((await nativeAuthorityStatus(pool,config)).ready,true);
  console.log(JSON.stringify({qualification:'two-node-effective-guardian-empty-reset',old_epoch:action.proposal,current_guardian:current.id,genesis_sha256:config.genesisHash,new_research_attributed:true,projection_epoch_failclosed:true,production_reset:false}));
 }finally{await t?.close();if(embedding)await new Promise(r=>embedding.close(r));await stop();await rm(root,{recursive:true,force:true})}
});
