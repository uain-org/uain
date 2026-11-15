import{test}from'node:test';import assert from'node:assert/strict';
const mod=await import('./artifacts.mjs').catch(()=>({}));
test('artifact census preserves unhosted history and deduplicates only identical commitments',()=>{
 assert.equal(typeof mod.artifactCensus,'function');const manifest={version:1,uri:'https://example.org/public.csv',sha256:'a'.repeat(64),bytes:3,license:'CC0'};
 const rows=[{id:'C1',contributor:'A',artifacts:JSON.stringify([{label:'raw',manifest},{label:'local only'}])},{id:'C2',contributor:'B',artifacts:[{label:'same source',manifest}]}];const result=mod.artifactCensus(rows);assert.equal(result.objects.length,1);assert.equal(result.objects[0].references.length,2);assert.equal(result.unavailable.length,1);assert.equal(result.unavailable[0].contribution,'C1');assert.equal(result.bytes,3);
 rows[1].artifacts[0].manifest={...manifest,bytes:4};assert.throws(()=>mod.artifactCensus(rows),/conflicting/);
});
