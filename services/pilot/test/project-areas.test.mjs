import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PROJECT_AREAS,projectArea} from '../dist/src/native/project-areas.js';

test('pilot search areas match every OPP and PRB catalogue entry',async()=>{
 const dir=new URL('../../../apps/baink/catalogue/',import.meta.url);let n=0;
 for(const file of (await readdir(dir)).filter(f=>/^domain-\d+\.json$/.test(f))){
  for(const row of JSON.parse(await readFile(new URL(file,dir),'utf8'))){
   assert.equal(projectArea(row.id),row.summary,row.id);
   assert.equal(projectArea('P-'+row.id),row.summary,'P-'+row.id);n++;
  }
 }
 assert.equal(n,21600);assert.equal(PROJECT_AREAS.length,450);
 for(const id of ['P-OPP-00000','OPP-10801','P-xxx-00009',null,'T-OPP-00009-1'])assert.equal(projectArea(id),'');
});
