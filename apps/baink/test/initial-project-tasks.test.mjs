import test from 'node:test';import assert from 'node:assert/strict';
import {loadCatalogue}from'../server/catalogue.mjs';
import * as tasks from '../server/initial-project-tasks.mjs';
test('every source project receives stable evidence-bound draft tasks without invented bounty or funds',async()=>{
 assert.equal(typeof tasks.createInitialProjectTasks,'function');
 const catalogue=await loadCatalogue(new URL('../catalogue/',import.meta.url).pathname),service=tasks.createInitialProjectTasks(catalogue),summary=service.summary();
 assert.equal(summary.projects,21600);assert.equal(summary.drafts,43200);assert.equal(summary.payable,0);assert.equal(summary.held,43200);
 const ids=new Set();for(let page=1;page<=216;page++){const result=service.list({page,pageSize:100});for(const p of result.projects){assert.equal(p.tasks.length,2);for(const t of p.tasks){assert.ok(!ids.has(t.id));ids.add(t.id);assert.match(t.sourceDigest,/^[a-f0-9]{64}$/);assert.equal(t.payable,false);assert.equal(t.reward,null);assert.ok(t.criteria.includes(p.projectId));assert.equal(t.reviewAuthority,'UAIN');}}}
 assert.equal(ids.size,43200);const one=service.project('OPP-00001');assert.deepEqual(one,service.project('OPP-00001'));assert.equal(service.project('OPP-99999'),null);assert.throws(()=>service.list({page:0}));assert.throws(()=>service.list({page:1,pageSize:101}));
});
