import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {executeRemote} from './house-remote-solver-runtime.mjs';
const prompt='Isolated fixture prompt',value={verdict:'NO_FINDING',evidence:'',selfCheck:'fixture only'};
const request={schema:'uain-house-remote-request-v1',executionId:'runtime-fixture',role:'solver',projectId:'house-fleet',prompt,promptDigest:createHash('sha256').update(prompt).digest('hex')};
test('sandbox runtime carries subscription policy into verified primitive and returns bound accounting proof',async()=>{
 const authentication={loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'};let calls=0;
 const result=await executeRemote({...request,usageSource:'subscription'},{ensurePrivateDirectory:async p=>assert.equal(p,'/var/lib/uain-house-solver/home'),runStructured:async options=>{
  calls++;assert.equal(options.usageSource,'subscription');assert.equal(options.prompt,prompt);assert.equal(options.tools,'WebSearch,WebFetch');assert.equal(options.timeoutMs,1200000);assert.equal(options.executable,'/var/lib/uain-house-solver/claude');assert.match(options.sha256,/^[a-f0-9]{64}$/);assert.deepEqual(options.validateOutput(value),value);
  return {value,metadata:{usageSource:'subscription',costUsd:3.25,costBasis:'api-equivalent-estimate',authentication,nativeRawDigest:'a'.repeat(64)}};
 }});
 assert.equal(calls,1);assert.deepEqual(result,{schema:'uain-house-remote-result-v1',executionId:request.executionId,role:request.role,projectId:request.projectId,promptDigest:request.promptDigest,value,usageSource:'subscription',costUsd:3.25,costBasis:'api-equivalent-estimate',authentication,nativeRawDigest:'a'.repeat(64)});
});
test('omitted usage source stays API guarded; invalid mode refuses before primitive',async()=>{
 let calls=0;const deps={ensurePrivateDirectory:async()=>{},runStructured:async options=>{calls++;assert.equal(options.usageSource,'api');return {value,metadata:{usageSource:'api',costUsd:0.01,costBasis:'api-reported-cost',nativeRawDigest:'b'.repeat(64)}};}};
 assert.equal((await executeRemote(request,deps)).usageSource,'api');
 await assert.rejects(executeRemote({...request,usageSource:'unlimited'},deps));assert.equal(calls,1);
});
