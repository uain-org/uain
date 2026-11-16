import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberProfiles } from '../server/profiles.mjs';

const address='uain1'+'a'.repeat(40), other='uain1'+'b'.repeat(40), third='uain1'+'c'.repeat(40);
const user={address}, otherUser={address:other};
function memoryStore(saved={}) {
  let data=structuredClone({accounts:{[address]:{displayName:'PRIVATE ACCOUNT',private:'SECRET'},[other]:{},[third]:{}},...saved}),queue=Promise.resolve();
  return {read:()=>structuredClone(data),transact(fn){const next=queue.then(()=>{const working=structuredClone(data);const out=fn(working);data=working;return structuredClone(out);});queue=next.catch(()=>{});return next;},snapshot:()=>structuredClone(data)};
}
const form=(extra={})=>({displayName:'Research system',summary:'I investigate open scientific questions.',capabilities:['research'],services:['Literature analysis'],languages:['English'],availability:'open',website:'https://example.com',publish:false,expectedVersion:0,...extra});

test('private accounts never become public profiles until holder explicitly publishes',async()=>{
  const store=memoryStore(), profiles=createMemberProfiles({store});
  assert.deepEqual(await profiles.own(user),{profile:null});
  assert.equal((await profiles.list()).count,0);
  await assert.rejects(profiles.get(address),e=>e.status===404);
  const saved=await profiles.save(user,form());
  assert.equal(saved.profile.published,false);assert.equal(saved.profile.version,1);
  assert.equal((await profiles.list()).profiles.length,0);
  await assert.rejects(profiles.get(address),e=>e.status===404);
  assert.equal(JSON.stringify(saved).includes('PRIVATE ACCOUNT'),false);
  assert.equal(JSON.stringify(saved).includes('SECRET'),false);
});

test('explicit publication exposes only holder-authored bounded claims and exact public address',async()=>{
  const store=memoryStore(), profiles=createMemberProfiles({store});
  await profiles.save(user,form({publish:true,publicContact:'https://example.com/contact'}));
  const {profile}=await profiles.get(address);
  assert.equal(profile.address,address);assert.equal(profile.published,true);assert.equal(profile.version,1);
  assert.equal(profile.provenance.kind,'self-declared');assert.equal(profile.provenance.independentlyVerified,false);
  assert.equal(profile.publicContact,'https://example.com/contact');
  assert.equal(Object.hasOwn(profile,'karma'),false);assert.equal(Object.hasOwn(profile,'achievements'),false);
  assert.equal((await profiles.list()).count,1);
});

test('stale revisions and concurrent initial saves cannot overwrite accepted holder changes',async()=>{
  const profiles=createMemberProfiles({store:memoryStore()});
  const result=await Promise.allSettled([profiles.save(user,form({displayName:'First profile'})),profiles.save(user,form({displayName:'Second profile'}))]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(result.find(x=>x.status==='rejected').reason.code,'profile_version_conflict');
  const own=(await profiles.own(user)).profile;
  await assert.rejects(profiles.save(user,form({expectedVersion:0})),e=>e.status===409);
  await profiles.save(user,form({displayName:'Revised profile',expectedVersion:own.version,publish:true}));
  assert.equal((await profiles.get(address)).profile.version,2);
});

test('withdrawal immediately hides the profile and retains the holder draft across module restart',async()=>{
  const store=memoryStore();let profiles=createMemberProfiles({store});
  await profiles.save(user,form({publish:true}));
  await profiles.save(user,{publish:false,expectedVersion:1});
  await assert.rejects(profiles.get(address),e=>e.status===404);
  assert.equal((await profiles.list()).count,0);
  profiles=createMemberProfiles({store:memoryStore(store.snapshot())});
  const own=(await profiles.own(user)).profile;
  assert.equal(own.displayName,'Research system');assert.equal(own.version,2);assert.equal(own.published,false);
});

test('owner identity comes only from authenticated actor and cannot edit another member with a body field',async()=>{
  const profiles=createMemberProfiles({store:memoryStore()});
  await profiles.save(user,form());
  assert.equal((await profiles.own(otherUser)).profile,null);
  await assert.rejects(profiles.save(otherUser,form({address})),e=>e.status===400);
  await assert.rejects(profiles.save({address:'bad'},form()),e=>e.status===401);
  await assert.rejects(profiles.save({address:'uain1'+'d'.repeat(40)},form()),e=>e.status===403);
  assert.equal((await profiles.own(user)).profile.version,1);
});

test('unknown claims, secret fields, bad types and abusive field bounds are rejected atomically',async()=>{
  const store=memoryStore(),profiles=createMemberProfiles({store});
  for(const bad of [{private_key:'secret'},{karma:100},{publish:'true'},{expectedVersion:-1},{expectedVersion:'0'},{displayName:'x'.repeat(121)},{summary:'x'.repeat(2001)},{capabilities:Array(21).fill('x')},{services:['x'.repeat(201)]},{languages:['']},{availability:'verified'},{summary:'bad\u0000text'}])
    await assert.rejects(profiles.save(user,form(bad)),e=>e.status===400);
  assert.equal((await profiles.own(user)).profile,null);
  assert.equal(store.snapshot().accounts[address].private,'SECRET');
});

test('contact fields accept optional HTTPS only without triggering contact or copying credentials',async()=>{
  const profiles=createMemberProfiles({store:memoryStore()});
  for(const website of ['http://example.com','javascript:alert(1)','https://user:secret@example.com','mailto:person@example.com'])
    await assert.rejects(profiles.save(user,form({website})),e=>e.status===400);
  await assert.rejects(profiles.save(user,form({publicContact:'http://example.com'})),e=>e.status===400);
  await profiles.save(user,form({website:'',publicContact:'',publish:true}));
  assert.equal((await profiles.get(address)).profile.website,'');
});

test('published list filters and paginates only public profiles with isolated return values',async()=>{
  const store=memoryStore(),profiles=createMemberProfiles({store});
  await profiles.save(user,form({displayName:'Alpha researcher',publish:true}));
  await profiles.save(otherUser,form({displayName:'Beta translator',capabilities:['translation'],publish:true}));
  await profiles.save({address:third},form({displayName:'Hidden translator'}));
  const page=await profiles.list({page:1,pageSize:1});
  assert.equal(page.count,2);assert.equal(page.pages,2);assert.equal(page.profiles.length,1);
  const found=await profiles.list({search:'translation'});
  assert.equal(found.count,1);assert.equal(found.profiles[0].address,other);
  found.profiles[0].displayName='Edited by reader';
  assert.equal((await profiles.get(other)).profile.displayName,'Beta translator');
  for(const query of [{page:0},{page:1001},{pageSize:101},{search:'x'.repeat(121)},{url:'https://evil.test'}])
    await assert.rejects(profiles.list(query),e=>e.status===400);
});

test('profile capacity blocks only new profiles while existing holders can withdraw safely',async()=>{
  const store=memoryStore(),profiles=createMemberProfiles({store,maxProfiles:1});
  await profiles.save(user,form({publish:true}));
  await assert.rejects(profiles.save(otherUser,form({publish:true})),e=>e.code==='profile_capacity');
  await profiles.save(user,{publish:false,expectedVersion:1});
  assert.equal((await profiles.list()).count,0);
  assert.equal((await profiles.own(otherUser)).profile,null);
});

test('corrupt stored public identity fails closed rather than exposing an invalid member address',async()=>{
  const store=memoryStore(),profiles=createMemberProfiles({store});
  await profiles.save(user,form({publish:true}));
  const state=store.snapshot();
  state.memberProfiles['not-an-address']={...state.memberProfiles[address],address:'not-an-address'};
  const reopened=createMemberProfiles({store:memoryStore(state)});
  await assert.rejects(reopened.list(),e=>e.code==='profile_store_invalid');
});

test('summary preserves legitimate multiline plain text while names and list entries remain single line',async()=>{
  const profiles=createMemberProfiles({store:memoryStore()});
  const summary='Research areas:\n\tOpen questions\r\nContact me about new work.';
  await profiles.save(user,form({summary,publish:true}));
  assert.equal((await profiles.get(address)).profile.summary,summary);
  for(const bad of [{displayName:'Split\nName'},{capabilities:['Split\nCapability']},{services:['Service\tname']},{summary:'Invalid\u0001control'}])
    await assert.rejects(profiles.save(otherUser,form(bad)),e=>e.status===400);
});
