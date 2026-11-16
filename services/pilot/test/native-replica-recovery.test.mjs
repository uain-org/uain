import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,readFile,writeFile,readdir,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
const mod=await import('../dist/src/native/replica.js'),{canonical,evidenceDocument}=await import('../dist/src/native/evidence.js');
function fixture(id='result-a'){
 const body={title:'Archived public body',detail:'Restore this exact original public research evidence and receipt.'},document=evidenceDocument(body),member='uain1'+'a'.repeat(40),instance='original-instance',epoch='b'.repeat(64),event={id:'7',operation:'submit',subject:id,member,instance},command={chain_id:'old-retired-native',member,instance,operation:'submit',payload:{id,evidence_digest:document.digest}};
 const receipt={envelope:{command,public_key:'archived-public-key',signature:'archived-public-signature'},state:{chain_id:command.chain_id,receipt:{finalized:true,event}}};
 const capsule={format:'uain-native-publication-v1',epoch,id,evidence_digest:document.digest,canonical_body:document.canonical,receipt},bytes=Buffer.from(canonical(capsule)),digest=createHash('sha256').update(bytes).digest('hex');
 return{row:{epoch,id,member,instance,evidence_digest:document.digest,canonical_body:document.canonical,body,receipt,replica_digest:digest},capsule,bytes,digest};
}
test('authenticated SQL publication rows regenerate exact original immutable capsule bytes for retired epochs',async()=>{
 assert.equal(typeof mod.restorePublicationReplica,'function','bounded public capsule recovery required');const root=await mkdtemp(join(tmpdir(),'uain-replica-recovery-'));
 try{const f=fixture();assert.equal(await mod.restorePublicationReplica(f.row,root),f.digest);assert.deepEqual(await readFile(join(root,f.digest+'.json')),f.bytes);assert.equal(await mod.restorePublicationReplica(f.row,root),f.digest);assert.equal((await readdir(root)).length,1)}finally{await rm(root,{recursive:true,force:true})}
});
test('capsule recovery refuses substituted body, receipt, attribution or prior digest before creating files',async()=>{
 assert.equal(typeof mod.restorePublicationReplica,'function');const root=await mkdtemp(join(tmpdir(),'uain-replica-refusal-'));
 try{const f=fixture();for(const mutate of [r=>r.body.detail+=' changed',r=>r.canonical_body+=' ',r=>r.evidence_digest='0'.repeat(64),r=>r.replica_digest='0'.repeat(64),r=>r.member='other',r=>r.receipt.state.receipt.event.subject='other']){const row=structuredClone(f.row);mutate(row);await assert.rejects(()=>mod.restorePublicationReplica(row,root));assert.equal((await readdir(root)).length,0)}}finally{await rm(root,{recursive:true,force:true})}
});
test('capsule recovery refuses an existing corrupted file without overwriting it',async()=>{
 assert.equal(typeof mod.restorePublicationReplica,'function');const root=await mkdtemp(join(tmpdir(),'uain-replica-corrupt-'));
 try{const f=fixture(),file=join(root,f.digest+'.json');await writeFile(file,'corrupt',{mode:0o600});await assert.rejects(()=>mod.restorePublicationReplica(f.row,root),/differs/);assert.equal(await readFile(file,'utf8'),'corrupt')}finally{await rm(root,{recursive:true,force:true})}
});
test('SQL capsule recovery pages one explicitly selected epoch and writes no database state',async()=>{
 assert.equal(typeof mod.recoverNativePublicationReplicas,'function');const root=await mkdtemp(join(tmpdir(),'uain-replica-pages-'));
 try{const rows=[fixture('result-a').row,fixture('result-b').row],pool={query:async(sql,args)=>{assert.match(sql,/^SELECT /);assert.equal(args[0],rows[0].epoch);assert.equal(args[2],2);return{rows:rows.filter(r=>r.id>args[1]).slice(0,args[2])}}};
 const first=await mod.recoverNativePublicationReplicas(pool,rows[0].epoch,root,'',1);assert.equal(first.restored,1);assert.equal(first.more,true);assert.equal(first.next_after,'result-a');
 const second=await mod.recoverNativePublicationReplicas(pool,rows[0].epoch,root,first.next_after,1);assert.equal(second.restored,1);assert.equal(second.more,false);assert.equal((await readdir(root)).length,2);
 for(const args of [['bad','',1],[rows[0].epoch,'../',1],[rows[0].epoch,'',9]])await assert.rejects(()=>mod.recoverNativePublicationReplicas(pool,args[0],root,args[1],args[2]));
 }finally{await rm(root,{recursive:true,force:true})}
});

test('current epoch replay validates and skips immutable capsules from a retired epoch in the shared directory',async()=>{
 const{restorePublicationReplicas}=await import('../dist/src/native/restore-publications.js'),root=await mkdtemp(join(tmpdir(),'uain-multi-epoch-'));
 try{const old=fixture();await mod.restorePublicationReplica(old.row,root);const result=await restorePublicationReplicas({query(){throw Error('foreign epoch must never be projected')}},{genesisHash:'c'.repeat(64)},root);assert.equal(result.restored,0);assert.equal(result.skipped_foreign,1);assert.deepEqual(await readFile(join(root,old.digest+'.json')),old.bytes);
 const corrupt=structuredClone(old.capsule);corrupt.evidence_digest='0'.repeat(64);const bytes=Buffer.from(canonical(corrupt)),digest=createHash('sha256').update(bytes).digest('hex');await writeFile(join(root,digest+'.json'),bytes,{mode:0o600});await assert.rejects(()=>restorePublicationReplicas({}, {genesisHash:'c'.repeat(64)},root),/attribution/);
 }finally{await rm(root,{recursive:true,force:true})}
});
