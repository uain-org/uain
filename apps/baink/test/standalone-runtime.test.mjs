import {SERVER_SOURCE_FOLDERS} from '../deploy/runtime-sources.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),app=fileURLToPath(new URL('..',import.meta.url));

test('standalone release imports and starts without repository-external signing modules',async t=>{
 const root=await mkdtemp(join(tmpdir(),'baink-standalone-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // app.mjs treats the directory three levels above server/ as the source
 // repository and refuses a data directory inside it. Nest the package so that
 // directory is this test's own temp root, and keep data in a separate one
 // (with TMPDIR=/cache/tmp in the CI sandbox, a flat copy made it /cache).
 const pkg=join(root,'repo','baink'),dataRoot=await mkdtemp(join(tmpdir(),'baink-standalone-data-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));
 // These are the runtime source folders collected by package-release.mjs.
 // Deliberately do not copy the repository's chain/client or a parent workspace.
 for(const folder of SERVER_SOURCE_FOLDERS)await cp(join(app,folder),join(pkg,folder),{recursive:true,filter:path=>!path.endsWith('.test.mjs')&&!path.endsWith('.test.js')&&!path.endsWith('.md')});
 const script=`
 import{createBainkServer}from'./server/app.mjs';
 let app;
 try{
  if(process.platform==='linux'){
   app=await createBainkServer({dataDir:${JSON.stringify(join(dataRoot,'data'))},projectsSource:null,catalogueDir:null,managementEnabled:false});
   await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
   const r=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/config');
   if(r.status!==200)throw Error('Packaged runtime config refused');
   const config=await r.json();if(config.centralEarning.policy!=='central-earning-five-kpi-fund-v2')throw Error('Wrong packaged policy');
  }
  console.log('STANDALONE_RUNTIME_OK');
 }finally{await app?.close();}`;
 const result=await run(process.execPath,['--input-type=module','--eval',script],{cwd:pkg,timeout:30000,maxBuffer:65536,env:{PATH:process.env.PATH}});
 assert.match(result.stdout,/STANDALONE_RUNTIME_OK/);
});
