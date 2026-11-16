import {test} from 'node:test';import assert from 'node:assert/strict';
const {readWithRetry,retryableRead,WARM_READ_ATTEMPTS}=await import('../dist/src/native/read-retry.js');
const {NativePublicProjectionPending}=await import('../dist/src/native/public-catch-up.js');
const none=async()=>{};
test('a read the chain advanced under is retried as a fresh read until it is consistent',async()=>{
 let n=0;const value=await readWithRetry(async()=>{if(++n<3)throw Error('native public state advanced during read; retry');return 'ok'},{pause:none});
 assert.equal(value,'ok');assert.equal(n,3);
 let m=0;assert.equal(await readWithRetry(async()=>{if(++m<2)throw new NativePublicProjectionPending('native public projection catching up');return 1},{pause:none}),1);
 assert.equal(retryableRead(Error('native public visibility changed during read; retry')),true);
 assert.equal(retryableRead(Error('native public proof checkpoint changed')),true);
});
test('proof failures and other errors are never retried, and retries are bounded',async()=>{
 let n=0;await assert.rejects(readWithRetry(async()=>{n++;throw Error('native wallet binding proof differs')},{pause:none}),/proof differs/);assert.equal(n,1);
 let k=0;await assert.rejects(readWithRetry(async()=>{k++;throw Error('native public state advanced during read; retry')},{pause:none}),/advanced/);assert.equal(k,WARM_READ_ATTEMPTS);
});

test('a page whose proof checkpoint changed mid-read is answered by a fresh read instead of failing',async()=>{
 let n=0;const page=await readWithRetry(async()=>{if(++n===1)throw Error('native public proof checkpoint changed');return{status:200,body:{count:1}}},{attempts:3,pause:none});
 assert.equal(page.status,200);assert.equal(n,2);
});
