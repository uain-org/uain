import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {nativeState} from '../dist/src/api/native-routes.js';
test('cancelled public proof releases a queued permit and active verifier capacity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-proof-cancel-')),controllers=[new AbortController(),new AbortController()];let pending=[];
 try{const binary=join(root,'reader'),genesis=join(root,'genesis'),script=`#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>setTimeout(()=>fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({ok:true}),{mode:384}),250));\n`;
  await writeFile(binary,script,{mode:0o700});await writeFile(genesis,'{}');const config={binary,binaryHash:createHash('sha256').update(script).digest('hex'),genesis,genesisHash:createHash('sha256').update('{}').digest('hex'),rpc:'http://127.0.0.1:1'};
  pending=controllers.map(c=>nativeState({keys:[]},config,{signal:c.signal}).catch(()=>({aborted:true})));
  const start=Date.now();await assert.rejects(()=>nativeState({keys:[]},config,{signal:AbortSignal.timeout(20)}),/abort/i);assert.ok(Date.now()-start<200,'cancelled queued proof occupied the semaphore');
  controllers.forEach(c=>c.abort());for(const result of await Promise.all(pending))assert.equal(result.aborted,true);
  assert.deepEqual(await nativeState({keys:[]},config),{ok:true},'aborted active verifiers leaked capacity');
 }finally{controllers.forEach(c=>c.abort());await Promise.all(pending);await rm(root,{recursive:true,force:true})}
});
