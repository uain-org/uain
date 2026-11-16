import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeState} from '../dist/src/api/native-routes.js';

// The verifier pin is hashed once per on-disk identity (10 Nov 2026), not on every proof.
// Any change to the file after it was verified must still be refused before it runs.
test('native pins are re-verified whenever the pinned file changes on disk',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'uain-pin-cache-'));try{
  const binary=join(dir,'reader'),genesis=join(dir,'genesis'),log=join(dir,'runs');
  const script=`#!${process.execPath}\nconst fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},'run\\n');process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(a[a.indexOf('--out')+1],'{"ok":true}',{mode:384,flag:'wx'}));\n`;
  await writeFile(binary,script);await chmod(binary,0o700);await writeFile(genesis,'{}');
  const config={binary,binaryHash:createHash('sha256').update(script).digest('hex'),genesis,genesisHash:createHash('sha256').update('{}').digest('hex'),rpc:'http://127.0.0.1:1'};
  for(let i=0;i<3;i++)assert.deepEqual(await nativeState({keys:[]},config),{ok:true});
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,3);
  // Same path and size, different bytes: the write moves ctime, so the pin is checked again.
  await writeFile(binary,script.replace("'run","'RUN"));
  await assert.rejects(nativeState({keys:[]},config),/native artifact differs from independent pin/);
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,3,'a changed verifier must not run');
  // A replacement by rename (new inode) holding the pinned bytes is verified and accepted.
  await writeFile(binary+'.new',script);await chmod(binary+'.new',0o700);await rename(binary+'.new',binary);
  assert.deepEqual(await nativeState({keys:[]},config),{ok:true});
  // A changed pin never reuses an earlier match.
  await assert.rejects(nativeState({keys:[]},{...config,binaryHash:'c'.repeat(64)}),/native artifact differs from independent pin/);
  // The genesis pin is held to the same rule.
  await writeFile(genesis,'{ }');
  await assert.rejects(nativeState({keys:[]},config),/native artifact differs from independent pin/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
