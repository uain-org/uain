import{test}from'node:test';import assert from'node:assert/strict';
const mod=await import('../dist/src/native/public-read.js');
// Shapes measured on production on 15 November 2026 (docs/security/todos.md, Pilot and site):
// the native reader served these fields as stored text; the ledger committed the parsed form.
test('legacy check and contribution fields are served in the committed form',()=>{
 const stored={id:'RC-1',reproduction:'{"steps":["a"]}',sources:'["S-1"]',source_checks:'[{"id":"S-1","ok":true}]',meta:null,verifications:[
  {verifier:'a',against_claim_history:'[{"event_id":7,"revision":1}]',reproduction_receipt:'{"ok":true}',novelty_checked:'["x"]',revised_claim:'',novelty_event_id:'42'},
  {verifier:'b',against_claim_history:'[]',reproduction_receipt:'',novelty_checked:'',revised_claim:'New claim',novelty_event_id:null}]};
 const c=mod.committedResearchForm(stored);
 assert.deepEqual(c.reproduction,{steps:['a']});assert.deepEqual(c.sources,['S-1']);assert.deepEqual(c.source_checks,[{id:'S-1',ok:true}]);
 const[a,b]=c.verifications;
 assert.deepEqual(a.against_claim_history,[{event_id:7,revision:1}]);assert.deepEqual(a.reproduction_receipt,{ok:true});assert.deepEqual(a.novelty_checked,['x']);assert.equal(a.revised_claim,null);assert.equal(a.novelty_event_id,42);
 assert.deepEqual(b.against_claim_history,[]);assert.equal(b.reproduction_receipt,null);assert.equal(b.novelty_checked,null);assert.equal(b.revised_claim,'New claim');assert.equal(b.novelty_event_id,null);
 assert.equal(stored.verifications[0].revised_claim,'','the stored row is not mutated');
});
test('structured values pass through unchanged and unparseable text is kept',()=>{
 const native={id:'RC-2',reproduction:null,sources:['S-2'],source_checks:[],verifications:[{verifier:'n',against_claim_history:[{event_id:1}],reproduction_receipt:{ok:false},novelty_checked:null,revised_claim:null,novelty_event_id:9}]};
 assert.deepEqual(mod.committedResearchForm(native),native);
 assert.equal(mod.committedResearchForm({sources:'not json',verifications:[]}).sources,'not json');
});
test('the committed check digest recomputes from the served form',async()=>{
 const{createHash}=await import('node:crypto');
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const digest=r=>createHash('sha256').update(JSON.stringify(canonical({version:1,...r}))).digest('hex');
 const pilot={record:'check',revised_claim:null,reproduction_receipt:{ok:true}};
 const v=mod.committedResearchForm({verifications:[{revised_claim:'',reproduction_receipt:'{"ok":true}'}]}).verifications[0];
 assert.equal(digest({record:'check',revised_claim:v.revised_claim??null,reproduction_receipt:v.reproduction_receipt??null}),digest(pilot));
});
