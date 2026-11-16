import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm,readFile,readdir,writeFile,symlink}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomBytes}from'node:crypto';import{createSealedVault}from'./vault.mjs';
async function fixture(t,limits={}){const directory=await mkdtemp(join(tmpdir(),'baink-vault-'));t.after(()=>rm(directory,{recursive:true,force:true}));const key=randomBytes(32);return{directory,key,vault:await createSealedVault({directory,key,...limits})};}
const owner='uain1'+'a'.repeat(40),other='uain1'+'b'.repeat(40),id='c'.repeat(32);
test('sealed data persists after restart without plaintext and is owner-bound',async t=>{const f=await fixture(t);await f.vault.put(id,{privatePurpose:'DO_NOT_STORE_PLAIN'},{owner});const files=(await readdir(f.directory)).filter(p=>p.endsWith('.sealed'));assert.ok(!String(await readFile(join(f.directory,files[0]))).includes('DO_NOT_STORE_PLAIN'));const v=await createSealedVault(f);assert.deepEqual(await v.get(id,{owner}),{privatePurpose:'DO_NOT_STORE_PLAIN'});await assert.rejects(v.get(id,{owner:other}),/missing/);});
test('same exact retry is idempotent but changed body cannot replace original',async t=>{const f=await fixture(t);await f.vault.put(id,{v:1},{owner});const files=(await readdir(f.directory)).filter(p=>p.endsWith('.sealed')),before=await readFile(join(f.directory,files[0]));await f.vault.put(id,{v:1},{owner});await assert.rejects(f.vault.put(id,{v:2},{owner}),/conflict/);assert.deepEqual(await readFile(join(f.directory,files[0])),before);});
test('concurrent writers and quota account for committed blobs only',async t=>{const f=await fixture(t,{maxFiles:1});const results=await Promise.allSettled([f.vault.put(id,{v:1},{owner}),f.vault.put('d'.repeat(32),{v:2},{owner})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await readdir(f.directory)).filter(p=>p.endsWith('.sealed')).length,1);});
test('tampering, wrong key and oversized plaintext fail closed',async t=>{const f=await fixture(t,{maxValueBytes:32});await assert.rejects(f.vault.put(id,{v:'z'.repeat(40)},{owner}),/size/);await f.vault.put(id,{v:1},{owner});const file=(await readdir(f.directory)).find(p=>p.endsWith('.sealed')),path=join(f.directory,file),value=JSON.parse(await readFile(path));value.ciphertext=value.ciphertext.slice(0,-2)+'AA';await writeFile(path,JSON.stringify(value));await assert.rejects(f.vault.get(id,{owner}));await assert.rejects(createSealedVault({...f,key:randomBytes(32)}),/key_identity/);});
test('symlink root and stale lock are refused, never auto-recovered',async t=>{const f=await fixture(t);const link=f.directory+'-link';await symlink(f.directory,link);t.after(()=>rm(link,{force:true}));await assert.rejects(createSealedVault({...f,directory:link}),/directory/);const{mkdir}=await import('node:fs/promises');await mkdir(join(f.directory,'.lock'));await assert.rejects(f.vault.put(id,{v:1},{owner}),/busy/);});
test('directory fsync uncertainty never acknowledges success and retains exact encrypted bytes',async t=>{const f=await fixture(t);const{open}=await import('node:fs/promises');const probe=await open(join(f.directory,'.key-id'),'r'),prototype=Object.getPrototypeOf(probe),originalSync=prototype.sync;await probe.close();let directories=0;prototype.sync=async function(){if((await this.stat()).isDirectory()&&++directories===2)throw Error('fixture-dir-fsync-failure');return originalSync.call(this);};try{await assert.rejects(f.vault.put(id,{retained:true},{owner}),/fixture-dir-fsync/);}finally{prototype.sync=originalSync;}assert.deepEqual(await f.vault.get(id,{owner}),{retained:true});await assert.rejects(f.vault.put(id,{retained:false},{owner}),/conflict/);assert.equal((await readdir(f.directory)).filter(p=>p.endsWith('.sealed')).length,1);});
test('concurrent puts in one process serialise instead of failing busy, and a briefly held lock is waited for',async t=>{const f=await fixture(t);const owner='uain1'+'a'.repeat(40);const ids=Array.from({length:6},(_,i)=>String(i).repeat(32).slice(0,32).replace(/[^a-f0-9]/g,'a')).map((v,i)=>(i.toString(16).repeat(32)).slice(0,32));await Promise.all(ids.map((id,i)=>f.vault.put(id,{i},{owner})));for(const [i,id] of ids.entries())assert.deepEqual(await f.vault.get(id,{owner}),{i});const {mkdir,rm}=await import('node:fs/promises');const lock=f.directory+'/.lock';await mkdir(lock,{mode:0o700});setTimeout(()=>rm(lock,{recursive:true}),150);await f.vault.put('f'.repeat(32),{late:true},{owner});assert.deepEqual(await f.vault.get('f'.repeat(32),{owner}),{late:true});});

// Archive (P1-2, 12 November 2026): the active directory's 10,000-file quota counted every value ever written.
async function archived(t,limits={}){const directory=await mkdtemp(join(tmpdir(),'baink-vault-'));const{mkdir}=await import('node:fs/promises');const archiveDirectory=directory+'-archive';await mkdir(archiveDirectory,{mode:0o700});t.after(()=>Promise.all([rm(directory,{recursive:true,force:true}),rm(archiveDirectory,{recursive:true,force:true})]));const key=randomBytes(32);const options={directory,key,archiveDirectory,...limits};return{...options,options,vault:await createSealedVault(options)};}
const sealed=async d=>(await readdir(d)).filter(p=>p.endsWith('.sealed')).sort();
const idOf=i=>i.toString(16).padStart(32,'0');
test('a full active vault takes new values once finished values are archived; archived values keep their exact bytes and stay readable',async t=>{
 const f=await archived(t,{maxFiles:2});await f.vault.put(idOf(1),{v:1},{owner});await f.vault.put(idOf(2),{v:2},{owner});
 await assert.rejects(f.vault.put(idOf(3),{v:3},{owner}),/quota/,'the old boundary: a full active directory refuses');
 const before=await Promise.all((await sealed(f.directory)).map(n=>readFile(join(f.directory,n))));
 assert.deepEqual(await f.vault.archive([{id:idOf(1),owner},{id:idOf(2),owner}]),{moved:2,already:0,absent:0,conflicts:0});
 assert.deepEqual(await sealed(f.directory),[]);const after=await Promise.all((await sealed(f.archiveDirectory)).map(n=>readFile(join(f.archiveDirectory,n))));
 assert.deepEqual(after.map(String).sort(),before.map(String).sort(),'archived files are the exact sealed bytes');
 await f.vault.put(idOf(3),{v:3},{owner});await f.vault.put(idOf(4),{v:4},{owner});
 const restarted=await createSealedVault(f.options);for(const i of[1,2,3,4])assert.deepEqual(await restarted.get(idOf(i),{owner}),{v:i});
 await assert.rejects(restarted.get(idOf(1),{owner:other}),/missing/,'the archive keeps the owner binding');
});
test('an archived value stays write-once: the same put is idempotent, a changed one conflicts, and no second copy appears',async t=>{
 const f=await archived(t);await f.vault.put(id,{v:1},{owner});await f.vault.archive([{id,owner}]);
 await f.vault.put(id,{v:1},{owner});await assert.rejects(f.vault.put(id,{v:2},{owner}),/conflict/);
 assert.equal((await sealed(f.directory)).length,0);assert.equal((await sealed(f.archiveDirectory)).length,1);
 assert.deepEqual(await f.vault.archive([{id,owner},{id:'d'.repeat(32),owner}]),{moved:0,already:1,absent:1,conflicts:0});
});
test('a crash between the archive copy and the active removal is settled by the next archive pass; a different copy never removes the active file',async t=>{
 const f=await archived(t);await f.vault.put(id,{v:1},{owner});await f.vault.put('d'.repeat(32),{v:2},{owner});
 const[a,b]=await sealed(f.directory);await writeFile(join(f.archiveDirectory,a),await readFile(join(f.directory,a)),{mode:0o600});
 await writeFile(join(f.archiveDirectory,b),'{"schema":"other"}',{mode:0o600});
 const r=await f.vault.archive([{id,owner},{id:'d'.repeat(32),owner}]);assert.equal(r.already+r.conflicts,2);assert.equal(r.conflicts,1);
 assert.deepEqual(await sealed(f.directory),[b],'the conflicting value stays active');assert.deepEqual(await f.vault.get('d'.repeat(32),{owner}),{v:2});assert.deepEqual(await f.vault.get(id,{owner}),{v:1});
});
test('a full archive refuses the move and leaves every active file in place',async t=>{
 const f=await archived(t,{archiveMaxFiles:1});await f.vault.put(idOf(1),{v:1},{owner});await f.vault.put(idOf(2),{v:2},{owner});
 await assert.rejects(f.vault.archive([{id:idOf(1),owner},{id:idOf(2),owner}]),/archive_quota/);
 assert.equal((await sealed(f.directory)).length,1);assert.equal((await sealed(f.archiveDirectory)).length,1);for(const i of[1,2])assert.deepEqual(await f.vault.get(idOf(i),{owner}),{v:i});
 const plain=await fixture(t);await assert.rejects(plain.vault.archive([{id,owner}]),/archive_unavailable/);
});
