/** Only inside an explicitly marked throwaway root filesystem; never on an
 * owning host. The pinned executable is a fixture, not scientific/native trust. */
import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm,lstat,readdir,chmod} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {loadSelection,SELECTION_PATH,AMENDMENTS_PATH} from '../../project-organizations/src/selection.mjs';
import {sha256} from '../../project-organizations/src/common.mjs';
import {openProductionInspectionReader} from '../src/production-reader.mjs';
import {e2eSkip} from '../../../ops/ci/e2e-gate.mjs';
const enabled=process.env.UAIN_FUND_INSPECTOR_ISOLATED_ROOT==='1';
test('actual fixed-profile factory has readSnapshot/close only; coherent pinned executable path and immutable registry', {skip:e2eSkip(enabled,'UAIN_FUND_INSPECTOR_ISOLATED_ROOT=1 inside a throwaway root filesystem')},async()=>{
 assert.equal(process.getuid(),0);assert.equal(process.platform,'linux');assert.equal(await readFile('/run/uain-fund-inspector-test-root','utf8'),'disposable-network-none\n');
 const root='/opt/uain-fund-inspection-fixture',profileDir='/etc/uain-fund-inspection';
 for(const p of [root,profileDir])await assert.rejects(lstat(p),{code:'ENOENT'});
 await mkdir(root,{mode:0o700});await mkdir(profileDir,{mode:0o700});
 let reader;
 try{
  const selection=await loadSelection(),project=selection.projects.find(p=>p.mainKpi.length>=20),P=project.nativeProjectId;
  const manager='uain1'+'a'.repeat(40),evaluator='uain1'+'b'.repeat(40);
  const records={
   [`project/${P}`]:{id:P},[`central_project_budget/${P}`]:{project:P,manager,round:1,closed:false,main_kpi_achieved:false},
   [`central_fund_config/${P}`]:{project:P,evaluator},[`central_fund_state/${P}`]:{revision:1,approved_revision:1,completed:0,pending:''},
   [`central_fund_plan/${P}/00000000000000000001`]:{project:P,revision:1,state:'accept',main_kpi:project.mainKpi,stages:Array.from({length:5},(_,i)=>({round:i+1,criteria:'Fixture independently verifiable criteria '+i}))},
  };
  const binary=root+'/uain-state',genesis=root+'/genesis.json';
  const code=`#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2),out=args[args.indexOf('--out')+1];let raw='';for await(const b of process.stdin)raw+=b;const selected=JSON.parse(raw);const records=${JSON.stringify(records)};if(fs.existsSync(${JSON.stringify(root+'/switch-on-proof.json')}))fs.writeFileSync(${JSON.stringify(profileDir+'/profile.json')},fs.readFileSync(${JSON.stringify(root+'/switch-on-proof.json')}),{mode:0o600});fs.writeFileSync(out,JSON.stringify({chain_id:'isolated-fund-fixture',height:'100',header_time:new Date().toISOString(),app_hash:'a'.repeat(64),signed_header:{fixture:true},records:Object.fromEntries(selected.keys.map(k=>[k,records[k]??null]))}),{mode:0o600});\n`;
  // .mjs is unnecessary when the shebang invokes Node with ESM syntax detection.
  await writeFile(binary,code,{mode:0o700});await writeFile(genesis,JSON.stringify({chain_id:'isolated-fund-fixture'}),{mode:0o600});
  const selectionPath=root+'/selection.json',amendmentsPath=root+'/amendments.json',registry=root+'/registry.sqlite';
  await writeFile(selectionPath,await readFile(SELECTION_PATH),{mode:0o600});await writeFile(amendmentsPath,await readFile(AMENDMENTS_PATH),{mode:0o600});
  const db=new DatabaseSync(registry);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE bindings(project_id TEXT PRIMARY KEY,source_digest TEXT NOT NULL,native_project_id TEXT,native_manager TEXT,native_evaluator TEXT);');db.prepare('INSERT INTO meta VALUES(?,?)').run('selection',selection.digest);for(const p of selection.projects)db.prepare('INSERT INTO bindings VALUES(?,?,?,?,?)').run(p.id,p.sourceDigest,p.nativeProjectId,manager,evaluator);db.close();await chmod(registry,0o600);
  const pin=async path=>({path,sha256:sha256(await readFile(path))});
  const profile={schema:'uain-fund-inspection-profile-v1',native:{binary,binaryHash:sha256(code),genesis,genesisHash:sha256(await readFile(genesis)),rpc:'http://127.0.0.1:26657',chainId:'isolated-fund-fixture',timeoutMs:2000,maxAgeSeconds:120},selection:await pin(selectionPath),amendments:await pin(amendmentsPath),registry:await pin(registry),projectIds:[project.id],reportDirectory:root+'/reports'};
  await mkdir(profile.reportDirectory,{mode:0o700});await writeFile(profileDir+'/profile.json',JSON.stringify(profile),{mode:0o600});
  const before=await readFile(registry),inventory=await readdir(root);
  reader=await openProductionInspectionReader();assert.ok(Object.isFrozen(reader));assert.deepEqual(Object.keys(reader),['readSnapshot','close']);
  const result=await reader.readSnapshot(project.id);assert.equal(result.available,true);assert.equal(result.proof.finalized,true);assert.equal(result.approvedPlan.main_kpi,project.mainKpi);assert.equal(result.inspection.appointment.manager,manager);assert.equal(result.tasks,null);
  await assert.rejects(reader.readSnapshot('OPP-99999'));assert.deepEqual(await readFile(registry),before);assert.deepEqual(await readdir(root),inventory);
  await chmod(binary,0o722);await assert.rejects(reader.readSnapshot(project.id));await chmod(binary,0o700);
  await writeFile(registry+'-wal','unknown',{mode:0o600});await assert.rejects(reader.readSnapshot(project.id));await rm(registry+'-wal');
  const cli=new URL('../src/check.mjs',import.meta.url).pathname;
  const report=spawnSync(process.execPath,[cli,'check'],{encoding:'utf8',timeout:15000});assert.equal(report.status,0,report.stderr);const observed=JSON.parse(report.stdout);assert.equal(observed.status,'active');assert.equal(observed.fundsReleased,false);assert.equal(observed.providerCalled,false);assert.equal(observed.custodyCalled,false);
  const reports=await readdir(profile.reportDirectory);assert.equal(reports.length,1);
  const refused=spawnSync(process.execPath,[cli,'run'],{encoding:'utf8',timeout:5000});assert.equal(refused.status,1);assert.equal(JSON.parse(refused.stdout).status,'held');assert.deepEqual(await readdir(profile.reportDirectory),reports);
  // Deterministic A/B switch after the CLI captured profile A's descriptor bytes,
  // before its separate factory loads B. Test preload changes only fixture fs.
  await rm(profile.reportDirectory,{recursive:true});await mkdir(profile.reportDirectory,{mode:0o700});
  const profilePath=profileDir+'/profile.json',otherGenesis=root+'/other-genesis.json';await writeFile(otherGenesis,JSON.stringify({chain_id:'isolated-fund-fixture',fixtureGeneration:2}),{mode:0o600});
  for(const delta of [{projectIds:[selection.projects.find(p=>p.id!==project.id).id]},{reportDirectory:root+'/other-reports'},{native:{...profile.native,genesis:otherGenesis,genesisHash:sha256(await readFile(otherGenesis))}}]){
   await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});
   const alternate={...profile,...delta};
   if(delta.reportDirectory)await mkdir(delta.reportDirectory,{mode:0o700});
   const preload=root+'/switch.mjs',marker=root+'/switch-marker';
   // 1: after original CLI read, before factory. 7: after post-snapshot guard,
   // immediately before the independent guard inside immutable holds.put.
   for(const switchAt of [1,7]){
    await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});await rm(marker,{force:true});
    await writeFile(preload,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.open;let reads=0;fs.open=async function(path,...args){const fd=await original.call(this,path,...args);if(path===${JSON.stringify(profilePath)}&&++reads===${switchAt}){const close=fd.close.bind(fd);fd.close=async()=>{await close();await fs.writeFile(${JSON.stringify(profilePath)},${JSON.stringify(JSON.stringify(alternate))},{mode:0o600});await fs.writeFile(${JSON.stringify(marker)},String(reads),{mode:0o600});};}return fd;};syncBuiltinESMExports();`,{mode:0o600});
    const switched=spawnSync(process.execPath,['--import',preload,cli,'check'],{encoding:'utf8',timeout:15000});assert.equal(switched.status,1,switched.stderr);assert.equal(JSON.parse(switched.stdout).status,'held');assert.equal(await readFile(marker,'utf8'),String(switchAt));assert.deepEqual(await readdir(profile.reportDirectory),[]);if(delta.reportDirectory)assert.deepEqual(await readdir(delta.reportDirectory),[]);
   }
   // Also change the profile from the pinned fixture verifier child itself:
   // snapshot post-read guards must refuse every semantic delta before reports.
   await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});await writeFile(root+'/switch-on-proof.json',JSON.stringify(alternate),{mode:0o600});
   const duringProof=spawnSync(process.execPath,[cli,'check'],{encoding:'utf8',timeout:15000});assert.equal(duringProof.status,1,duringProof.stderr);assert.equal(JSON.parse(duringProof.stdout).status,'held');assert.deepEqual(await readdir(profile.reportDirectory),[]);if(delta.reportDirectory)assert.deepEqual(await readdir(delta.reportDirectory),[]);await rm(root+'/switch-on-proof.json');

  }
  await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});
  await reader.close();await assert.rejects(reader.readSnapshot(project.id));
 }finally{await reader?.close();await rm(root,{recursive:true,force:true});await rm(profileDir,{recursive:true,force:true});}
});
