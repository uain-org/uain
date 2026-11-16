import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readPinnedFile,parseInspectionProfile} from '../src/read-profile.mjs';
import {sha256} from '../../project-organizations/src/common.mjs';
const native={binary:'/opt/uain/uain-state',binaryHash:'a'.repeat(64),genesis:'/opt/uain/genesis.json',genesisHash:'b'.repeat(64),rpc:'http://127.0.0.1:26657',chainId:'fixture',timeoutMs:1000,maxAgeSeconds:60};
const pinned=path=>({path,sha256:'c'.repeat(64)});
const fixture=()=>({schema:'uain-fund-inspection-profile-v1',native,selection:pinned('/opt/uain/selection.json'),amendments:pinned('/opt/uain/amendments.json'),registry:pinned('/opt/uain/registry.sqlite'),projectIds:['OPP-00001'],reportDirectory:'/var/lib/uain-fund-inspection'});
test('profile accepts only public pinned local configuration and refuses capability/remote overrides',()=>{
 assert.ok(Object.isFrozen(parseInspectionProfile(fixture())));
 for(const change of [p=>p.transport={},p=>p.native={...p.native,binary:'relative'},p=>p.native={...p.native,rpc:'https://user:pass@rpc.example'},p=>p.native={...p.native,rpc:'http://outside.example'},p=>p.native={...p.native,timeoutMs:60000},p=>p.projectIds.push('OPP-00001'),p=>p.registry.sha256='bad']){const p=structuredClone(fixture());change(p);assert.throws(()=>parseInspectionProfile(p));}
});
test('protected reads enforce digest, nofollow, ownership, bounds and unwritable ancestors',async()=>{
 // A group/world-writable ancestor is unsafe: the caller cannot opt out of
 // ancestor checks. Made explicit, because TMPDIR is not always a shared /tmp
 // (the CI sandbox uses a private /cache/tmp).
 const outer=await mkdtemp(join(tmpdir(),'inspection-profile-'));await chmod(outer,0o777);
 const root=join(outer,'root');await mkdir(root);const file=join(root,'x');
 try{await chmod(root,0o700);await writeFile(file,'public',{mode:0o600});await assert.rejects(readPinnedFile(file,{sha256:sha256('public'),limit:32}));await symlink(file,join(root,'link'));await assert.rejects(readPinnedFile(join(root,'link'),{sha256:sha256('public'),limit:32}));}finally{await rm(outer,{recursive:true,force:true});}
});
test('pinned reads succeed only while exact protected bytes and safe metadata remain',async()=>{
 const {resolve}=await import('node:path');const dir=await mkdtemp(join(resolve('.superpowers'),'profile-test-'));await chmod(dir,0o700);const file=join(dir,'public');
 try{
  await writeFile(file,'public',{mode:0o600});assert.equal((await readPinnedFile(file,{sha256:sha256('public'),limit:32})).toString(),'public');
  await assert.rejects(readPinnedFile(file,{sha256:'f'.repeat(64),limit:32}));await assert.rejects(readPinnedFile(file,{sha256:sha256('public'),limit:2}));
  await chmod(file,0o622);await assert.rejects(readPinnedFile(file,{sha256:sha256('public'),limit:32}));await chmod(file,0o600);
  await symlink(file,join(dir,'link'));await assert.rejects(readPinnedFile(join(dir,'link'),{sha256:sha256('public'),limit:32}));
  await chmod(dir,0o722);await assert.rejects(readPinnedFile(file,{sha256:sha256('public'),limit:32}));
 }finally{await chmod(dir,0o700);await rm(dir,{recursive:true,force:true});}
});
