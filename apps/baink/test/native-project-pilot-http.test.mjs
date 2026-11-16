import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,member} from './http-fixture.mjs';
test('pilot routes enforce signed owner, exact query and disabled deployment without exposing a broadcaster',async t=>{
 const f=await fixture(t),owner=member();
 assert.equal((await f.request(null,'GET','/api/native/project-pilot')).status,401);
 assert.equal((await f.request(null,'POST','/api/native/project-pilot/prepare',{})).status,401);
 await f.request(owner,'POST','/api/account',{displayName:'Pilot fixture'});
 const config=await f.request(null,'GET','/api/config');assert.equal(config.body.nativeProjectPilot,null);
 assert.deepEqual((await f.request(owner,'GET','/api/native/project-pilot')).body,{config:null,intents:[]});
 assert.equal((await f.request(owner,'GET','/api/native/project-pilot?owner=another')).status,400);
 const prepared=await f.request(owner,'POST','/api/native/project-pilot/prepare',{});assert.equal(prepared.status,503);assert.equal(prepared.body.error.code,'native_pilot_disabled');
 assert.equal((await f.request(owner,'POST','/api/native/project-pilot/00000000-0000-4000-8000-000000000000/submit',{envelope:{}})).status,503);
 assert.equal((await f.request(owner,'POST','/api/native/project-pilot/broadcast',{envelope:{}})).status,404);
});
test('configured source keeps old notes readable but refuses new parallel local review intake',async t=>{
 const who=member(),prior_art={basis:'Synthetic fixture prior-art basis for a strictly isolated route test.',searches:['Fixture source one','Fixture source two']};
 const pilot={sourceId:'OPP-00002',sourceDigest:'a'.repeat(64),projectId:'fixture-pilot',taskId:'fixture-task',creatorAddress:who.address,creatorInstance:'fixture-instance',chainId:'fixture',epoch:'b'.repeat(64),projectPayload:{id:'fixture-pilot',title:'Synthetic route fixture',class:'neutral',prior_art},taskPayload:{id:'fixture-task',project:'fixture-pilot',title:'Synthetic task fixture',class:'neutral',prior_art,criteria:'Synthetic route validation only, never a production research task.',kind:'instant',karma_reward:0,credit_reward:'0'}};
 const f=await fixture(t,{managementEnabled:true,catalogueDir:new URL('../catalogue/',import.meta.url).pathname,nativeProjectPilotEnabled:true,nativeProjectPilotConfig:pilot});
 await f.request(who,'POST','/api/account',{displayName:'Pilot route fixture'});
 const path='/api/management/projects/OPP-00002/evidence';
 const denied=await f.request(who,'POST',path,{});assert.equal(denied.status,409);assert.equal(denied.body.error.code,'native_project_pilot_required');
 assert.equal((await f.request(who,'GET',path)).status,200);
 assert.equal((await f.request(who,'GET','/api/management/projects/OPP-00002/chat')).status,200);
 const other=await f.request(who,'POST','/api/management/projects/OPP-00003/evidence',{});assert.notEqual(other.body.error?.code,'native_project_pilot_required');
});
