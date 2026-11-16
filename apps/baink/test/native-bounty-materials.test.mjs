import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const module=await import('../server/native-bounty-materials.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const sha=v=>createHash('sha256').update(v).digest('hex');
export const REVIEW_ZIP=Buffer.from('UEsDBBQAAAAAAAAAZF2FPj5iHgAAAB4AAAAkAAAAYXBwcy9iYWluay9zZXJ2ZXIvbmF0aXZlLWVhcm5pbmcubWpzZXhwb3J0IGNvbnN0IHJldmlld2VkID0gdHJ1ZTsKUEsBAhQDFAAAAAAAAABkXYU+PmIeAAAAHgAAACQAAAAAAAAAAAAAAKSBAAAAAGFwcHMvYmFpbmsvc2VydmVyL25hdGl2ZS1lYXJuaW5nLm1qc1BLBQYAAAAAAQABAFIAAABgAAAAAAA=','base64');
export async function materialsFixture(t,{cleanup=true}={}){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'baink-private-materials-')));await chmod(directory,0o700);if(cleanup)t.after(()=>rm(directory,{recursive:true,force:true}));
 const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32),user={address:'uain1'+sha(raw).slice(0,40),publicKey:raw.toString('base64')},pins={chainId:'materials-fixture',epoch:'a'.repeat(64),verifierSha256:'b'.repeat(64)};
 const stateMember={id:user.address,public_key:raw.toString('base64url'),licence:'active',sequence:'0'};let mutate=()=>{},reads=0;
 const native={configured:true,pins,timeoutMs:1000,async publicState(selection){reads++;assert.equal(selection.member,user.address);assert.deepEqual(selection.keys,['member/'+user.address]);const header=new Date().toISOString(),member=structuredClone(stateMember),value={state:{chain_id:pins.chainId,height:'100',app_hash:'c'.repeat(64),header_time:header,member,records:{['member/'+user.address]:structuredClone(member)}},proof:{authority:'native',chainId:pins.chainId,epoch:pins.epoch,genesisSha256:pins.epoch,verifierSha256:pins.verifierSha256,height:'100',appHash:'c'.repeat(64),headerTime:header,maxAgeSeconds:120}};mutate(value);return value;}};
 const artifact=join(directory,'review-source.zip'),manifestFile=join(directory,'materials.json');await writeFile(artifact,REVIEW_ZIP,{mode:0o600});
 const manifest={schema:'baink-native-bounty-materials-v1',chainId:pins.chainId,genesisSha256:pins.epoch,materials:[{taskId:'T-reviewed-boundary',projectId:'P-reviewed-boundary',filename:'review-source.zip',path:artifact,sha256:sha(REVIEW_ZIP),bytes:REVIEW_ZIP.length,files:{'apps/baink/server/native-earning.mjs':sha('export const reviewed = true;\n')}}]};
 const saveManifest=()=>writeFile(manifestFile,JSON.stringify(manifest),{mode:0o600});await saveManifest();
 return{directory,pair,native,user,pins,artifact,manifestFile,manifest,saveManifest,setMutate:fn=>{mutate=fn;},getReads:()=>reads};
}
async function create(options){assert.equal(typeof module.createNativeBountyMaterials,'function','The bounded materials service must exist');return module.createNativeBountyMaterials(options);}
test('default absent configuration returns no materials only after fresh native ownership and licence proof',async t=>{
 const f=await materialsFixture(t),service=await create({native:f.native});const answer=await service.list(f.user);assert.deepEqual(answer.materials,[]);assert.equal(f.getReads(),1);assert.equal(answer.proof.authority,'native');
 f.setMutate(v=>{v.state.member.licence='revoked';v.state.records['member/'+f.user.address].licence='revoked';});await assert.rejects(service.list(f.user),e=>e.status===403);
});
test('reviewed immutable package is served with metadata, never operator file paths or a funded-work claim',async t=>{
 const f=await materialsFixture(t),service=await create({native:f.native,manifestFile:f.manifestFile}),listed=await service.list(f.user);assert.equal(listed.materials.length,1);const m=listed.materials[0];assert.equal(m.sourceSha256,sha(REVIEW_ZIP));assert.equal(m.bytes,REVIEW_ZIP.length);assert.equal(m.taskId,'T-reviewed-boundary');assert.equal(m.projectId,'P-reviewed-boundary');assert.equal(m.fileCount,1);assert.equal(m.downloadPath,'/api/native/earning/materials/T-reviewed-boundary');assert.ok(!JSON.stringify(listed).includes(f.directory));assert.match(listed.notice,/does not establish/i);
 const item=await service.get(f.user,m.taskId);assert.deepEqual(item.bytes,REVIEW_ZIP);assert.equal(item.filename,'review-source.zip');await writeFile(f.artifact,'changed');assert.deepEqual((await service.get(f.user,m.taskId)).bytes,REVIEW_ZIP,'The checked in-memory package is immutable after startup');item.bytes.fill(0);assert.deepEqual((await service.get(f.user,m.taskId)).bytes,REVIEW_ZIP,'Callers cannot mutate cached source');
});
test('every source download rechecks licence and exact pinned state rather than reusing a prior authorized result',async t=>{
 const f=await materialsFixture(t),service=await create({native:f.native,manifestFile:f.manifestFile});await service.get(f.user,'T-reviewed-boundary');
 for(const mutate of [v=>v.proof.headerTime=new Date(0).toISOString(),v=>v.proof.epoch='d'.repeat(64),v=>v.proof.verifierSha256='d'.repeat(64),v=>v.state.app_hash='d'.repeat(64),v=>v.state.member.public_key=Buffer.alloc(32,1).toString('base64url'),v=>v.state.records['member/'+f.user.address].licence='revoked']){f.setMutate(mutate);await assert.rejects(service.get(f.user,'T-reviewed-boundary'),e=>e.status===503);}
 f.setMutate(v=>{v.state.member.licence='suspended';v.state.records['member/'+f.user.address].licence='suspended';});await assert.rejects(service.get(f.user,'T-reviewed-boundary'),e=>e.status===403);
 f.setMutate(()=>{});f.native.publicState=async()=>{throw Error('RPC unavailable')};await assert.rejects(service.get(f.user,'T-reviewed-boundary'),e=>e.status===503);
});
test('invalid identifiers and alien local keys cannot select arbitrary source paths or members',async t=>{
 const f=await materialsFixture(t),service=await create({native:f.native,manifestFile:f.manifestFile});for(const id of ['../secret','/etc/passwd','T-unknown','https://example.test'])await assert.rejects(service.get(f.user,id),e=>[400,404].includes(e.status));await assert.rejects(service.list({...f.user,publicKey:Buffer.alloc(32,7).toString('base64')}),e=>e.status===401);
});
test('unsafe operator manifest paths, permissions, hashes and declared source files fail startup',async t=>{
 const f=await materialsFixture(t);await assert.rejects(create({native:f.native,manifestFile:'relative.json'}));await chmod(f.manifestFile,0o644);await assert.rejects(create({native:f.native,manifestFile:f.manifestFile}));await chmod(f.manifestFile,0o600);await chmod(f.artifact,0o644);await assert.rejects(create({native:f.native,manifestFile:f.manifestFile}));await chmod(f.artifact,0o600);
 for(const patch of [{sha256:'0'.repeat(64)},{bytes:REVIEW_ZIP.length+1},{filename:'unsafe\r\n.zip'},{files:{'.env':sha('secret')}},{files:{'apps/baink/server/native-earning.mjs':'0'.repeat(64)}}]){const original=structuredClone(f.manifest.materials[0]);Object.assign(f.manifest.materials[0],patch);await f.saveManifest();await assert.rejects(create({native:f.native,manifestFile:f.manifestFile}));f.manifest.materials[0]=original;}
 const link=join(f.directory,'linked.zip');await symlink(f.artifact,link);f.manifest.materials[0].path=link;await f.saveManifest();await assert.rejects(create({native:f.native,manifestFile:f.manifestFile}));
});
test('ZIP symlinks, extra bytes, compression and unsafe archive metadata cannot hide unreviewed contents',async t=>{
 const f=await materialsFixture(t);for(const change of [b=>{const at=b.indexOf(Buffer.from('PK\x01\x02','binary'));b.writeUInt32LE((0o120777<<16)>>>0,at+38);return b;},b=>Buffer.concat([b,Buffer.from('hidden')]),b=>{b.writeUInt16LE(8,8);return b;}]){const bytes=change(Buffer.from(REVIEW_ZIP));await writeFile(f.artifact,bytes);Object.assign(f.manifest.materials[0],{sha256:sha(bytes),bytes:bytes.length});await f.saveManifest();await assert.rejects(create({native:f.native,manifestFile:f.manifestFile}));}
});
test('new proof, checker and runtime guard sources are explicitly reviewed while generic custody and secret paths remain excluded',async t=>{
 const f=await materialsFixture(t),content=Buffer.from('export const reviewed = true;\n');
 function archive(name){const bytes=Buffer.from(name),centralAt=REVIEW_ZIP.indexOf(Buffer.from('PK\x01\x02','binary')),local=Buffer.from(REVIEW_ZIP.subarray(0,30)),central=Buffer.from(REVIEW_ZIP.subarray(centralAt,centralAt+46)),end=Buffer.from(REVIEW_ZIP.subarray(-22));local.writeUInt16LE(bytes.length,26);central.writeUInt16LE(bytes.length,28);const start=30+bytes.length+content.length;end.writeUInt32LE(46+bytes.length,12);end.writeUInt32LE(start,16);return Buffer.concat([local,bytes,content,central,bytes,end]);}
 for(const name of ['apps/baink/holder/owned-notes.mjs','apps/baink/holder/service-health.mjs','apps/baink/holder/runtime/broker.mjs','ops/custody/private_payment_service.py','chain/client/federation-workflow.mjs','chain/privatewallet/state.go','chain/private-exchange/src/bin/uain-note-source.rs','chain/private-exchange/tests/note_source.rs','chain/private-exchange/src/wallet_files.rs','chain/private-exchange/src/lib.rs','chain/private-exchange/Cargo.toml','chain/private-exchange/Cargo.lock']){
  const bytes=archive(name);await writeFile(f.artifact,bytes);Object.assign(f.manifest.materials[0],{sha256:sha(bytes),bytes:bytes.length,files:{[name]:sha(content)}});await f.saveManifest();const service=await create({native:f.native,manifestFile:f.manifestFile});assert.deepEqual((await service.get(f.user,'T-reviewed-boundary')).bytes,bytes);
 }
 for(const name of ['ops/custody/custody.py','.env','keys/guardian.json','/var/lib/uain-custody/uain.kdbx','../private-data.json']){
  const bytes=archive(name);await writeFile(f.artifact,bytes);Object.assign(f.manifest.materials[0],{sha256:sha(bytes),bytes:bytes.length,files:{[name]:sha(content)}});await f.saveManifest();await assert.rejects(create({native:f.native,manifestFile:f.manifestFile}));
 }
});

import {createBainkServer} from '../server/app.mjs';
import {signed,member as makeMember,audience} from './http-fixture.mjs';
async function materialsHTTP(t,{configured=true}={}){
 const f=await materialsFixture(t,{cleanup:false});let app;t.after(async()=>{await app?.close();await rm(f.directory,{recursive:true,force:true});});const genesis=JSON.stringify({chain_id:f.pins.chainId}),genesisFile=join(f.directory,'public-genesis.json'),binary=join(f.directory,'unit-reader'),membersFile=join(f.directory,'public-members.json');
 const records={ [f.user.address]:{id:f.user.address,public_key:Buffer.from(f.user.publicKey,'base64').toString('base64url'),licence:'active',sequence:'0'} };
 await writeFile(membersFile,JSON.stringify(records));await writeFile(genesisFile,genesis);f.manifest.genesisSha256=sha(genesis);await f.saveManifest();
 // Process-boundary HTTP fixture, not a replacement for native signature
 // verification. The separately pinned real-reader integration qualifies that.
 const script=`#!${process.execPath}\nconst fs=require('fs');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{const r=JSON.parse(text),members=JSON.parse(fs.readFileSync(${JSON.stringify(membersFile)},'utf8')),member=members[r.member]??null,records={};for(const k of r.keys??[])records[k]=k.startsWith('member/')?(members[k.slice(7)]??null):null;fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({chain_id:${JSON.stringify(f.pins.chainId)},height:'100',app_hash:'c'.repeat(64),header_time:new Date().toISOString(),member,records,event_count:'0'}),{mode:384,flag:'wx'});});\n`;
 await writeFile(binary,script,{mode:0o700});await chmod(binary,0o700);const dataDir=join(f.directory,'app-data');
 const who={...f.user,privateKey:f.pair.privateKey};const initial={version:1,accounts:{[who.address]:{address:who.address,publicKey:who.publicKey,displayName:'Fictional materials reader',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}},requests:{},nonces:{},history:[],nativeIntents:{}};
 await import('node:fs/promises').then(fs=>fs.mkdir(dataDir,{mode:0o700}));await writeFile(join(dataDir,'state.json'),JSON.stringify(initial));
 app=await createBainkServer({dataDir,publicOrigin:audience,projectsSource:null,catalogueDir:null,nativeConfig:{binary,binaryHash:sha(script),genesis:genesisFile,genesisHash:sha(genesis),chainId:f.pins.chainId,rpc:'http://127.0.0.1:1',timeoutMs:1000,maxAgeSeconds:120},nativeBountyMaterialsFile:configured?f.manifestFile:null});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,actor=who,method='GET') {const response=await fetch(base+path,{method,headers:{Origin:audience,...(actor?signed(actor,method,path,{}):{})}}),bytes=Buffer.from(await response.arrayBuffer());return{status:response.status,headers:response.headers,bytes,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(bytes.toString()):null};}
 return{...f,who,dataDir,request,async licence(value){records[who.address].licence=value;await writeFile(membersFile,JSON.stringify(records));}};
}
test('source metadata and binary downloads require signed existing account ownership before any configured material is exposed',async t=>{
 const f=await materialsHTTP(t),path='/api/native/earning/materials';assert.equal((await f.request(path,null)).status,401);assert.equal((await f.request(path,makeMember())).status,404);assert.equal((await f.request(path+'/T-reviewed-boundary',null)).status,401);
 const listed=await f.request(path);assert.equal(listed.status,200);assert.equal(listed.body.materials[0].sourceSha256,sha(REVIEW_ZIP));assert.ok(!listed.bytes.toString().includes(f.directory));const binary=await f.request(path+'/T-reviewed-boundary');assert.equal(binary.status,200);assert.deepEqual(binary.bytes,REVIEW_ZIP);assert.equal(binary.headers.get('content-type'),'application/zip');assert.equal(binary.headers.get('content-disposition'),'attachment; filename="review-source.zip"');assert.equal(binary.headers.get('x-baink-source-sha256'),sha(REVIEW_ZIP));assert.match(binary.headers.get('cache-control'),/no-store/);assert.equal(binary.headers.get('x-content-type-options'),'nosniff');
 await f.licence('revoked');assert.equal((await f.request(path)).status,403);assert.equal((await f.request(path+'/T-reviewed-boundary')).status,403);
});
test('materials routes reject query selectors, unsupported methods and unlisted identifiers and never change balances or history',async t=>{
 const f=await materialsHTTP(t),path='/api/native/earning/materials';assert.equal((await f.request(path+'?member='+f.who.address)).status,400);assert.equal((await f.request(path+'/T-unknown')).status,404);assert.equal((await f.request(path+'/T-reviewed-boundary',f.who,'POST')).status,404);assert.equal((await f.request(path+'/%2E%2E%2Fsecret')).status,404);
 const state=readPersistedState(f.dataDir);assert.deepEqual(state.history,[]);assert.equal(state.accounts[f.who.address].balance,undefined);for(const key of ['nativeEarningIntents','nativePaymentIntents','nativePaymentEffects'])assert.equal(Object.hasOwn(state,key),false);
});
test('absent operator configuration exposes an empty signed licensed metadata list and no downloadable package',async t=>{
 const f=await materialsHTTP(t,{configured:false}),listed=await f.request('/api/native/earning/materials');assert.equal(listed.status,200);assert.deepEqual(listed.body.materials,[]);assert.equal((await f.request('/api/native/earning/materials/T-reviewed-boundary')).status,404);
});
