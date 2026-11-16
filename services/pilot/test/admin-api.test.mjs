import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { boot } from './helpers.mjs';
const pair=await generateKeyPair('EdDSA',{extractable:true});
const system=await boot({ADMIN_DELEGATION_KEYS:JSON.stringify({'https://master.test':await exportSPKI(pair.publicKey)})});
after(()=>system.close());
const {pool}=await import('../dist/src/storage/store.js');
async function token() { return new SignJWT({actor:{issuer:'https://id.test',subject:'operator'},product:'uain',capability:'overview:read',grantVersion:1}).setProtectedHeader({alg:'EdDSA',typ:'admin-delegation+jwt'}).setIssuer('https://master.test').setAudience('uain-admin').setSubject('operator').setIssuedAt().setExpirationTime('90s').sign(pair.privateKey); }
test('UAIN read API checks local binding, projects aggregate source truth and revocation', async()=>{
 const headers={authorization:`Bearer ${await token()}`};
 assert.equal((await system.http('/api/admin/v1/overview',{headers})).status,403);
 await pool.query("INSERT INTO portal_admin_grants VALUES('https://id.test','operator','overview:read',NULL)");
 const response=await system.http('/api/admin/v1/overview',{headers}), data=await response.json();
 assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/);
 assert.equal(data.product,'uain'); assert.equal(data.metrics.find(m=>m.id==='projects').value,(await system.db.stats()).projects);
 assert.deepEqual(data.capabilities,['overview:read']);
 for(const key of ['email','private_key','session_token','agents','byAction']) assert.equal(JSON.stringify(data).includes(`"${key}"`),false);
 await pool.query('UPDATE portal_admin_grants SET revoked_at=now()');
 assert.equal((await system.http('/api/admin/v1/overview',{headers})).status,403);
 assert.equal((await system.http('/api/admin/v1/overview',{headers:{authorization:'Bearer ordinary-member-token'}})).status,401);
});

test('UAIN preserves the observation time of stale aggregates while another server refreshes',async()=>{
 const old=new Date(Date.now()-10*60_000).toISOString();
 const value=await system.db.stats();system.db.forgetStats();
 await pool.query("UPDATE shared_results SET at=$1,value=$2 WHERE key='stats'",[old,JSON.stringify(value)]);
 const holder=await pool.connect();await holder.query('SELECT pg_advisory_lock(4202613)');
 try {
   await pool.query('UPDATE portal_admin_grants SET revoked_at=NULL');
   const response=await system.http('/api/admin/v1/overview',{headers:{authorization:`Bearer ${await token()}`}});
   assert.equal(response.status,200);const data=await response.json();
   assert.equal(data.observedAt,old);assert.ok(Date.parse(data.fetchedAt)>Date.parse(old));
 }finally{await holder.query('SELECT pg_advisory_unlock(4202613)');holder.release();system.db.forgetStats();}
});

test('management JSON and HTML use the same independent admin grant boundary',async()=>{
 for(const path of ['/api/admin/v1/management','/api/admin/v1/management/view']){
  assert.equal((await system.http(path,{headers:{authorization:'Bearer ordinary-member-token'}})).status,401);
  await pool.query('UPDATE portal_admin_grants SET revoked_at=now()');
  const response=await system.http(path,{headers:{authorization:`Bearer ${await token()}`}});
  assert.equal(response.status,403);assert.match(response.headers.get('cache-control'),/no-store/);
 }
});

test('source delegation remains valid after awaited audit for overview, management JSON and management HTML',async()=>{
 const originalQuery=pool.query,originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const url=String(input);if(!url.startsWith('https://baink.money/'))return originalFetch(input,init);if(url.endsWith('/management/status'))return Response.json({total:1,active:1});if(url.endsWith('/funding/policy'))return Response.json({schema:'baink/project-funding-readiness/v1',status:'fixture'});if(url.endsWith('/initial-tasks/summary'))return Response.json({schema:'uain/initial-task-readiness/v1',available:true,projects:1,drafts:1,payable:0,held:1});throw Error('Unexpected public aggregate source');};
 try{
  for(const path of ['/api/admin/v1/overview','/api/admin/v1/management','/api/admin/v1/management/view']){
   for(const change of ['revoke','expire']){
    await originalQuery.call(pool,'UPDATE portal_admin_grants SET revoked_at=NULL');let audited=false;
    const expires=Math.floor(Date.now()/1000)+3;
    const delegation=await new SignJWT({actor:{issuer:'https://id.test',subject:'operator'},product:'uain',capability:'overview:read',grantVersion:1}).setProtectedHeader({alg:'EdDSA',typ:'admin-delegation+jwt'}).setIssuer('https://master.test').setAudience('uain-admin').setSubject('operator').setIssuedAt().setExpirationTime(change==='expire'?expires:Math.floor(Date.now()/1000)+90).sign(pair.privateKey);
    pool.query=async function(query,...args){const result=await originalQuery.call(this,query,...args);if(typeof query==='string'&&query.startsWith('INSERT INTO portal_admin_audit')){audited=true;if(change==='revoke')await originalQuery.call(this,"UPDATE portal_admin_grants SET revoked_at=now() WHERE actor_issuer='https://id.test' AND actor_subject='operator'");else await new Promise(resolve=>setTimeout(resolve,Math.max(0,expires*1000+50-Date.now())));}return result;};
    const response=await system.http(path,{headers:{authorization:'Bearer '+delegation}}),body=await response.json();assert.equal(audited,true,'Revocation/expiry occurred inside the actual awaited audit');assert.equal(response.status,change==='revoke'?403:401,path+' '+change);assert.match(response.headers.get('cache-control'),/no-store/);assert.deepEqual(body,{error:'admin_access_unavailable'});pool.query=originalQuery;
   }
  }
 }finally{pool.query=originalQuery;globalThis.fetch=originalFetch;await originalQuery.call(pool,'UPDATE portal_admin_grants SET revoked_at=NULL');}
});
