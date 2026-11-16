import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeBootstrapPublicHandler,NATIVE_BOOTSTRAP_RETIRED} from '../dist/src/api/native-bootstrap-public-routes.js';

// Retired 9 Nov 2026: no downloads. Every bootstrap path answers 410 and names the kit.
test('the retired verifier bootstrap serves no artifact and points to the kit',async()=>{
 const handler=createNativeBootstrapPublicHandler({env:{UAIN_AUTHORITY:'native'}});
 for(const path of ['/api/native/bootstrap','/api/native/bootstrap/uain-state-linux-amd64','/api/native/bootstrap/genesis.json','/api/native/bootstrap/x']){
  let reply;const headers={};
  assert.equal(await handler({method:'GET'},{setHeader:(k,v)=>{headers[k]=v;}},new URL('https://uain.test'+path),(_,status,body)=>{reply={status,body};}),true);
  assert.equal(reply.status,410,path);assert.equal(reply.body.error,'native_bootstrap_retired');assert.equal(reply.body.kit,'https://baink.money/uain-agent.mjs');assert.equal(headers['cache-control'],'no-store');
 }
 assert.equal(await createNativeBootstrapPublicHandler({env:{}})({method:'GET'},{setHeader(){}},new URL('https://uain.test/api/native/bootstrap'),()=>{}),false,'only under native authority');
 assert.equal(await handler({method:'GET'},{setHeader(){}},new URL('https://uain.test/api/native/state'),()=>{}),false);
 assert.ok(Object.isFrozen(NATIVE_BOOTSTRAP_RETIRED));
});
