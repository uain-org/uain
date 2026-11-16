import test from 'node:test';import assert from 'node:assert/strict';
import {ReviewError,classifyReviewError} from './errors.mjs';
import {NativeReaderError} from '../server/native-asset.mjs';
test('typed review errors map to distinct HTTP status and code; unknown errors are 500 and reported',()=>{
 const table=[
  [new ReviewError('review_gateway_missing'),404,'public_review_missing',false],
  [new ReviewError('review_gateway_artifact_not_ready'),409,'public_review_not_ready',false],
  [new ReviewError('review_gateway_capacity'),429,'public_review_busy',false],
  [new ReviewError('review_vault_busy'),429,'public_review_busy',false],
  [new ReviewError('review_gateway_proof'),503,'public_review_unavailable',true],
  [new ReviewError('review_gateway_vault_unavailable'),503,'public_review_unavailable',true],
  [new ReviewError('review_gateway_phase'),409,'public_review_refused',false],
  [new ReviewError('review_gateway_context_expired'),409,'public_review_refused',false],
  // Data loss in the vault is not "missing": it is an internal error operators must see.
  [new ReviewError('review_vault_missing'),500,'public_review_error',true],
  [new ReviewError('review_adapter_uncertain'),500,'public_review_error',true],
  [new TypeError("Cannot read properties of undefined (reading 'x')"),500,'public_review_error',true],
  [Object.assign(Error('The operation was aborted'),{name:'AbortError'}),500,'public_review_error',true],
  // A plain Error whose MESSAGE looks like a known code is not trusted: only the type counts.
  [Error('review_gateway_missing'),500,'public_review_error',true],
  [new NativeReaderError(1,null,'rpc_connection_refused'),503,'public_review_unavailable',true],
 ];
 for(const [error,status,code,report] of table){const r=classifyReviewError(error);assert.deepEqual([r.status,r.code,r.report],[status,code,report],String(error.message));}
 assert.equal(classifyReviewError(new ReviewError('review_worker_auth_refused'),{worker:true}).status,401);
 assert.equal(classifyReviewError(new ReviewError('review_worker_auth_refused')).status,409);
 assert.equal(new ReviewError('review_vault_busy').retryable,true);assert.equal(new ReviewError('review_gateway_phase').retryable,false);
});
