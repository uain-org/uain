import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,member} from './http-fixture.mjs';
test('central earning HTTP requires signed holder control and cannot expose a privileged award operation',async t=>{
 const f=await fixture(t);
 for(const path of ['/api/native/central/status','/api/native/central/awards','/api/native/central/tasks','/api/native/central/intents','/api/native/central/tasks/CT-1','/api/native/central/submissions/CS-1'])assert.equal((await f.request(null,'GET',path)).status,401,path);
 for(const path of ['/api/native/central/prepare','/api/native/central/intents/00000000-0000-4000-8000-000000000000/submit','/api/native/central/intents/00000000-0000-4000-8000-000000000000/reconcile'])assert.equal((await f.request(null,'POST',path,{})).status,401,path);
 const owner=member();await f.request(owner,'POST','/api/account',{displayName:'Central fixture'});
 const config=await f.request(null,'GET','/api/config');assert.equal(config.body.centralEarning.enabled,false);assert.deepEqual(config.body.centralEarning.holderOperations,['project_join','central_submit']);
 const list=await f.request(owner,'GET','/api/native/central/intents');assert.equal(list.status,200);assert.deepEqual(list.body,{intents:[]});
 assert.equal((await f.request(owner,'GET','/api/native/central/intents?owner=other')).status,400);
 // Open-first listing: only the two known orders and states pass the route; everything else is a 400.
 for(const q of ['order=oldest','state=closed','order=newest&state=open&owner=other','limit=13&state=open'])assert.equal((await f.request(owner,'GET','/api/native/central/tasks?'+q)).status,400,q);
 assert.notEqual((await f.request(owner,'GET','/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0')).status,400);
 for(const q of ['?cursor=01','?limit=51','?limit=0','?other=1'])assert.equal((await f.request(owner,'GET','/api/native/central/awards'+q)).status,400,q);
 assert.equal((await f.request(owner,'POST','/api/native/central/prepare',{operation:'central_review',payload:{}})).status,400);
});

test('submission detail selectors are signed and closed before proof loading',async t=>{const f=await fixture(t),owner=member();await f.request(owner,'POST','/api/account',{displayName:'History fixture'});for(const suffix of ['?owner=other','?executionId=../bad'])assert.equal((await f.request(owner,'GET','/api/native/central/submissions/CS-1'+suffix)).status,400);});
