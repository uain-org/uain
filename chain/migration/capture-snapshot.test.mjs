import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureSnapshot} from './capture.mjs';
test('migration capture refuses unsafe snapshot before opening a transaction',async()=>{
 for(const exportedSnapshot of ['',"00000001-00000002-1';COMMIT",'../snapshot',123,null]){
  const calls=[];await assert.rejects(captureSnapshot({query:async q=>{calls.push(q);throw Error('query should not run');}},{exportedSnapshot}),/exported snapshot/);assert.deepEqual(calls,[]);
 }
});
test('migration capture imports exact MVCC snapshot before any source query',async()=>{
 const calls=[];await assert.rejects(captureSnapshot({query:async q=>{calls.push(q);return {rows:[]};}},{exportedSnapshot:'00000003-0000000A-1'}),/schema drift/);
 assert.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls[1],"SET TRANSACTION SNAPSHOT '00000003-0000000A-1'");assert.equal(calls.at(-1),'ROLLBACK');
});
test('ordinary migration capture keeps its existing independent transaction',async()=>{
 const calls=[];await assert.rejects(captureSnapshot({query:async q=>{calls.push(q);return {rows:[]};}}),/schema drift/);assert.ok(!calls.some(q=>q.startsWith('SET TRANSACTION SNAPSHOT')));
});
