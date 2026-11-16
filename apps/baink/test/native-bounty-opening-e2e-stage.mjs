// Sixth optional stage. All artifacts and guardian custody below are fictional
// and confined to the disposable native genesis and /qualification tmpfs.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {copyFile,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createBainkServer} from '../server/app.mjs';
import {audience,signed} from './http-fixture.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const TASK='T-baink-safety-20261104',PROJECT='P-baink-safety-20261104';
const REVIEW_ZIP=Buffer.from('UEsDBBQAAAAAAAAAZF2FPj5iHgAAAB4AAAAkAAAAYXBwcy9iYWluay9zZXJ2ZXIvbmF0aXZlLWVhcm5pbmcubWpzZXhwb3J0IGNvbnN0IHJldmlld2VkID0gdHJ1ZTsKUEsBAhQDFAAAAAAAAABkXYU+PmIeAAAAHgAAACQAAAAAAAAAAAAAAKSBAAAAAGFwcHMvYmFpbmsvc2VydmVyL25hdGl2ZS1lYXJuaW5nLm1qc1BLBQYAAAAAAQABAFIAAABgAAAAAAA=','base64');

export async function exerciseNativeBountyOpening({t,network}){
 assert.equal(process.env.UAIN_FINANCIAL_E2E,'1');assert.equal(process.env.UAIN_FINANCIAL_PRIVATE_E2E,'1');assert.equal(process.env.UAIN_FINANCIAL_BOUNTY_E2E,'1');assert.match(network.config.chainId,/^baink-fictional-e2e-/);assert.equal(new URL(network.config.rpc).hostname,'127.0.0.1');
 const {guardian,relay}=network.people;assert.match(guardian.member.name,/^Fictional /);assert.equal(typeof network.daemonPid,'function');
 await network.submit('roles',{member:guardian.address,creator:true,default_verifier:true,evidence_digest:sha('FICTIONAL bounty helper qualification role only; no production permission')},guardian);
 const root='/qualification/baink-fictional-bounty-'+randomBytes(6).toString('hex');let app;await mkdir(root,{mode:0o700});t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true});});
 const artifact=async(name,value)=>{const path=join(root,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));await writeFile(path,bytes,{mode:0o600});return{path,sha256:sha(bytes)};};
 await copyFile(network.config.genesis,join(root,'genesis.json'));await chmod(join(root,'genesis.json'),0o600);await copyFile('/tools/uain-state',join(root,'uain-state'));await chmod(join(root,'uain-state'),0o700);
 const packageFile=await artifact('fictional-source.zip',REVIEW_ZIP),release='fictional-bounty-release-'+network.config.chainId.split('-').at(-1),releaseFile=await artifact('fictional-release.json',{fixtureOnly:true,release,version:'fixture-only',sourceSha256:packageFile.sha256});
 const materialsValue={schema:'baink-native-bounty-materials-v1',chainId:network.config.chainId,genesisSha256:network.config.genesisHash,materials:[{taskId:TASK,projectId:PROJECT,filename:'fictional-source.zip',path:packageFile.path,sha256:packageFile.sha256,bytes:REVIEW_ZIP.length,files:{'apps/baink/server/native-earning.mjs':sha('export const reviewed = true;\n')}}]},materialsFile=await artifact('fictional-materials.json',materialsValue);
 const priorFile=await artifact('fictional-prior-art.json',{fixtureOnly:true,notNovelResearch:true,searches:['fictional first prior-art guard query','fictional second prior-art guard query'],notice:'Known-answer qualification only, never a production prior-art finding or reward.'});
 const dataDir=join(root,'materials-app');await mkdir(dataDir,{mode:0o700});app=await createBainkServer({dataDir,publicOrigin:audience,projectsSource:null,catalogueDir:null,nativeConfig:network.config,nativeBountyMaterialsFile:materialsFile.path});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,{method='GET',body={},authenticated=true}={}){return fetch(base+path,{method,headers:{Origin:audience,'Content-Type':'application/json',...(authenticated?signed(guardian,method,path,body):{})},...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});}
 const registered=await request('/api/account',{method:'POST',body:{displayName:'Fictional private materials reader'}});assert.equal(registered.status,201);
 const denied=await request('/api/native/earning/materials/'+TASK,{authenticated:false});assert.equal(denied.status,401);await denied.arrayBuffer();
 const metadata=await request('/api/native/earning/materials'),listed=await metadata.json();assert.equal(metadata.status,200);assert.equal(listed.materials[0].sourceSha256,packageFile.sha256);assert.equal(listed.proof.authority,'native');assert.equal(listed.proof.chainId,network.config.chainId);
 const downloaded=await request('/api/native/earning/materials/'+TASK),bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(downloaded.status,200);assert.deepEqual(bytes,REVIEW_ZIP);assert.equal(downloaded.headers.get('x-baink-source-sha256'),packageFile.sha256);
 const accessFile=await artifact('fictional-authenticated-source-access.json',{fixtureOnly:true,chainId:network.config.chainId,genesisSha256:network.config.genesisHash,taskId:TASK,metadataStatus:metadata.status,downloadStatus:downloaded.status,unauthenticatedStatus:denied.status,sourceSha256:sha(bytes),materialsManifestSha256:materialsFile.sha256,nativeProof:listed.proof});
 // The fixture key is generated by this test's existing disposable identity.
 // Only the qualification custody subprocess reads the resulting private file.
 await artifact('fictional-guardian-key.json',{public_key:Buffer.from(guardian.publicKey,'base64').toString('base64url'),private_key:guardian.privateKey.export({format:'jwk'}).d});
 const state=(await network.read({})).state;assert.ok(BigInt(state.event_count)<256n);let recordedPaymentEffects;
 for(let start=1n;start<=BigInt(state.event_count)&&!recordedPaymentEffects;start+=16n){const keys=[];for(let n=start;n<=BigInt(state.event_count)&&keys.length<16;n++)keys.push('event/'+String(n).padStart(20,'0'));const records=(await network.read({keys})).state.records;recordedPaymentEffects=keys.map(k=>records[k]).find(e=>e.operation==='private_payment')?.subject;}
 assert.match(recordedPaymentEffects,/^[a-f0-9]{64}$/);
 const config=await artifact('qualification-config.json',{fixtureOnly:true,chainId:network.config.chainId,genesisSha256:network.config.genesisHash,rpc:network.config.rpc,guardian:guardian.address,guardianPublicKey:Buffer.from(guardian.publicKey,'base64').toString('base64url'),relay:relay.address,daemonPid:network.daemonPid(),daemonParentPid:process.pid,daemonHome:join(network.root,'node-0'),release,recordedPaymentEffects,artifacts:{release:releaseFile,package:packageFile,materials:materialsFile,prior:priorFile,access:accessFile}});
 const output=await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/python3',[new URL('./native-bounty-opening-harness.py',import.meta.url).pathname,config.path],{stdio:['ignore','pipe','pipe']}),parts=[],errors=[];let size=0;const timer=setTimeout(()=>child.kill('SIGKILL'),240000);for(const [stream,list]of[[child.stdout,parts],[child.stderr,errors]])stream.on('data',bytes=>{size+=bytes.length;if(size>65536)child.kill('SIGKILL');else list.push(bytes)});child.once('error',reject);child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Disposable Python bounty qualification failed: '+Buffer.concat(errors).toString().slice(-12000)));try{resolve(JSON.parse(Buffer.concat(parts).toString()))}catch{reject(Error('Invalid bounded bounty qualification result'))}});});
 assert.equal(output.fixtureOnly,true);assert.equal(output.productionWrites,false);assert.equal(output.realPinnedNativeSDK,true);assert.equal(output.sendAttempts,4);assert.equal(output.mintedUnchanged,true);assert.equal(output.reservedIncreaseUnits,'1000000');assert.equal(output.actualTwoJobInvoiceClaimGuard,true);assert.equal(output.actualExpiredNonmembershipReuse,true);assert.equal(output.actualRecordedInvoicePermanent,true);assert.equal(output.keysExported,false);
 t.diagnostic(JSON.stringify(output));
}
