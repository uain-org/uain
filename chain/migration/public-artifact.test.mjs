import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,readFile,writeFile,rm,stat,lstat,symlink,link,chmod,chown,mkdir,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const m=await import('./public-artifact.mjs').catch(()=>({}));
async function fixture(run){const dir=await mkdtemp(join(process.cwd(),'.migration-artifact-'));await chmod(dir,0o700);try{await run(join(dir,'receipt.json'));}finally{await rm(dir,{recursive:true,force:true});}}
async function pending(path,value){const fd=await open(path+'.pending','wx',0o600);try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}}
const value={schema:'fixture-v1',event:'7',digest:'a'.repeat(64)};
test('fsynced interrupted pending promotes exact expected bytes and retries idempotently',async()=>{
 assert.equal(typeof m.writePublicArtifact,'function');await fixture(async path=>{
  await pending(path,value);await m.writePublicArtifact(path,value);assert.deepEqual(JSON.parse(await readFile(path)),value);
  await assert.rejects(()=>lstat(path+'.pending'),{code:'ENOENT'});assert.equal((await stat(path)).mode&0o777,0o600);
  const first=await stat(path);await m.writePublicArtifact(path,value);assert.equal((await stat(path)).ino,first.ino);
 });
});
test('new artifacts are private and conflicting final/pending bytes are retained and refused',async()=>{
 await fixture(async path=>{await m.writePublicArtifact(path,value);assert.equal((await stat(path)).mode&0o777,0o600);await assert.rejects(()=>m.writePublicArtifact(path,{...value,event:'8'}));assert.deepEqual(JSON.parse(await readFile(path)),value);});
 for(const bytes of ['{','{}\n',JSON.stringify({...value,event:'8'})+'\n',JSON.stringify(value)])await fixture(async path=>{
  await writeFile(path+'.pending',bytes,{mode:0o600});await assert.rejects(()=>m.writePublicArtifact(path,value));assert.equal(await readFile(path+'.pending','utf8'),bytes);await assert.rejects(()=>lstat(path),{code:'ENOENT'});
 });
});
test('symlink, hardlink, loose permissions and writable parent refuse without following links',async()=>{
 for(const target of ['pending','final'])for(const kind of ['symlink','hardlink','mode'])await fixture(async path=>{
  const selected=target==='pending'?path+'.pending':path,other=path+'.other';await writeFile(other,JSON.stringify(value)+'\n',{mode:0o600});
  if(kind==='symlink')await symlink(other,selected);else if(kind==='hardlink')await link(other,selected);else{await writeFile(selected,JSON.stringify(value)+'\n',{mode:0o644});}
  await assert.rejects(()=>m.writePublicArtifact(path,value));assert.equal(await readFile(other,'utf8'),JSON.stringify(value)+'\n');
 });
 await fixture(async path=>{await chmod(join(path,'..'),0o777);await assert.rejects(()=>m.writePublicArtifact(path,value));});
});
test('foreign real ownership is rejected before reading or replacing the artifact',async()=>{
 if(process.env.UAIN_TEST_FOREIGN_KEY_FILE){const path=process.env.UAIN_TEST_FOREIGN_KEY_FILE;assert.notEqual((await lstat(path)).uid,0);await assert.rejects(()=>m.writePublicArtifact(path,value));}
 else await fixture(async path=>{await pending(path,value);await chown(path+'.pending',65534,65534);await assert.rejects(()=>m.writePublicArtifact(path,value));assert.equal((await lstat(path+'.pending')).uid,65534);});
});
test('final plus exact pending reconciles, conflicting pending cannot be ignored',async()=>{
 await fixture(async path=>{await m.writePublicArtifact(path,value);await pending(path,value);await m.writePublicArtifact(path,value);await assert.rejects(()=>lstat(path+'.pending'),{code:'ENOENT'});});
 await fixture(async path=>{await m.writePublicArtifact(path,value);await pending(path,{...value,event:'9'});await assert.rejects(()=>m.writePublicArtifact(path,value));assert.equal(JSON.parse(await readFile(path+'.pending')).event,'9');});
});
test('durable receipt bytes exclude volatile proof headers and replay state',()=>{
 assert.equal(typeof m.migrationReceiptArtifact,'function');const envelope={command:{sequence:'4'},signature:'exact'},event={id:'5',command_digest:'b'.repeat(64),member:'uain1fixture',operation:'legacy_page'};
 const first=m.migrationReceiptArtifact({index:4,envelope,already_committed:false,receipt:{finalized:true,event,proof:{height:'20'}}});
 const retry=m.migrationReceiptArtifact({index:4,envelope,already_committed:true,receipt:{finalized:true,event,proof:{height:'21'}}});
 assert.deepEqual(first,retry);assert.deepEqual(first.envelope,envelope);assert.deepEqual(first.receipt.event,event);assert.equal(first.receipt.finalized,true);assert.equal(Object.hasOwn(first.receipt,'proof'),false);
 assert.throws(()=>m.migrationReceiptArtifact({index:4,envelope,receipt:{finalized:false,event}}));
});
test('offline proofs are content addressed and durable before progress, fresh retry keeps both',async()=>{
 await fixture(async path=>{
  const directory=dirname(path),item={index:4,envelope:{signature:'exact'},receipt:{finalized:true,event:{id:'5'},proof:{height:'20',queries:['fixture']}}};
  await pending(join(directory,'0004.json'),m.migrationReceiptArtifact(item));
  await m.persistMigrationReceipt(directory,item);const first=await readFile(join(directory,'0004.json')),files=await readdir(join(directory,'proofs'));assert.equal(files.length,1);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'proofs',files[0]))),m.migrationProofArtifact(item));
  item.receipt.proof.height='21';await m.persistMigrationReceipt(directory,item);assert.equal((await readdir(join(directory,'proofs'))).length,2);assert.deepEqual(await readFile(join(directory,'0004.json')),first);
 });
});
test('failed proof persistence never advances progress, legacy full proof receipt stays exact',async()=>{
 await fixture(async path=>{
  const directory=dirname(path),item={index:0,envelope:{signature:'exact'},receipt:{finalized:true,event:{id:'1'},proof:{height:'20'}}};
  await mkdir(join(directory,'proofs'),{mode:0o777});await chmod(join(directory,'proofs'),0o777);await assert.rejects(()=>m.persistMigrationReceipt(directory,item));await assert.rejects(()=>lstat(join(directory,'0000.json')),{code:'ENOENT'});
  await chmod(join(directory,'proofs'),0o700);const original=JSON.stringify(item)+'\n';await writeFile(join(directory,'0000.json'),original,{mode:0o600});item.receipt.proof.height='21';await m.persistMigrationReceipt(directory,item);assert.equal(await readFile(join(directory,'0000.json'),'utf8'),original);
  item.receipt.event.id='2';await assert.rejects(()=>m.persistMigrationReceipt(directory,item));assert.equal(await readFile(join(directory,'0000.json'),'utf8'),original);
 });
});
test('orphan v1 pending retains exact historical proof after fresh event reproof',async()=>{
 await fixture(async path=>{
  const directory=dirname(path),item={index:0,already_committed:false,envelope:{signature:'exact'},receipt:{finalized:true,event:{id:'1',command_digest:'a'.repeat(64)},proof:{height:'20'}}},original=JSON.stringify(item)+'\n';
  await pending(join(directory,'0000.json'),item);item.already_committed=true;item.receipt.proof.height='21';await m.persistMigrationReceipt(directory,item);
  assert.equal(await readFile(join(directory,'0000.json'),'utf8'),original);await assert.rejects(()=>lstat(join(directory,'0000.json.pending')),{code:'ENOENT'});assert.equal((await readdir(join(directory,'proofs'))).length,1);
 });
 for(const change of [i=>i.envelope.signature='foreign',i=>i.receipt.event.id='2',i=>i.receipt.finalized=false,i=>i.index=1])await fixture(async path=>{
  const directory=dirname(path),item={index:0,envelope:{signature:'exact'},receipt:{finalized:true,event:{id:'1'},proof:{height:'20'}}},old=structuredClone(item);change(old);await pending(join(directory,'0000.json'),old);await assert.rejects(()=>m.persistMigrationReceipt(directory,item));await assert.rejects(()=>lstat(join(directory,'0000.json')),{code:'ENOENT'});assert.deepEqual(JSON.parse(await readFile(join(directory,'0000.json.pending'))),old);
 });
});
test('interrupted no-overwrite publication recognizes only its exact final/pending inode pair',async()=>{
 await fixture(async path=>{await pending(path,value);await link(path+'.pending',path);assert.equal((await lstat(path)).nlink,2);await m.writePublicArtifact(path,value);assert.equal((await lstat(path)).nlink,1);assert.deepEqual(JSON.parse(await readFile(path)),value);await assert.rejects(()=>lstat(path+'.pending'),{code:'ENOENT'});});
});
