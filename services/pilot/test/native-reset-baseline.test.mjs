import{test}from'node:test';import assert from'node:assert/strict';import{createHash,generateKeyPairSync}from'node:crypto';
const mod=await import('../dist/src/native/baseline.js').catch(()=>({}));
function fixture(){
 const pub=generateKeyPairSync('ed25519').publicKey,bytes=Buffer.from(pub.export({format:'jwk'}).x,'base64url'),id='uain1'+createHash('sha256').update(bytes).digest('hex').slice(0,40);
 const legacy={manifest_digest:'a'.repeat(64),ledger_head:'b'.repeat(64),last_event_id:42,pinned_public_key:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})};
 const genesis={chain_id:'uain-reset-20261012_010203',app_state:{version:1,guardians:[id],members:[{id,public_key:bytes.toString('base64url'),name:'Current proved guardian',operator:'Single operator',family:'fixture',licence:'active',karma:0,credits:'0',sequence:'0',default_verifier:false,creator:false,active_projects:0}],legacy}};
 const raw=Buffer.from(JSON.stringify(genesis)),pin=createHash('sha256').update(raw).digest('hex'),state={chain_id:genesis.chain_id,event_count:'0',records:{guardians:[id],legacy,legacy_import:null,legacy_adoption:null,guardian_epoch_current:null}};
 return{genesis,raw,pin,state,id};
}
test('only an exact reviewed reset genesis with proved import and adoption absence supplies an empty original baseline',()=>{
 assert.equal(typeof mod.resetBaseline,'function','qualified source-zero reset baseline required');const f=fixture();assert.deepEqual(mod.resetBaseline(f.raw,f.pin,f.state),{mode:'reset_empty',members:[f.id],expected_original_research:'0',archive:f.genesis.app_state.legacy});
});
test('source-zero never relaxes original chain readiness or accepts a mixed archive/genesis/proof',()=>{
 assert.equal(typeof mod.resetBaseline,'function');const f=fixture();
 for(const mutation of [g=>g.chain_id='uain-original',g=>g.app_state.members[0].credits='1',g=>g.app_state.members[0].sequence='1',g=>g.app_state.members[0].karma=1,g=>g.app_state.members[0].creator=true,g=>g.app_state.members[0].account_policy='unreviewed',g=>g.app_state.members[0].public_key+='=',g=>g.app_state.guardians=[],g=>delete g.app_state.legacy]){
  const genesis=structuredClone(f.genesis);mutation(genesis);const raw=Buffer.from(JSON.stringify(genesis));assert.throws(()=>mod.resetBaseline(raw,createHash('sha256').update(raw).digest('hex'),{...f.state,chain_id:genesis.chain_id}));
 }
 for(const state of [{...f.state,chain_id:'other'},{...f.state,records:{...f.state.records,legacy_import:{status:'loading'}}},{...f.state,records:{...f.state.records,legacy_adoption:{manifest_digest:'a'.repeat(64)}}},{...f.state,records:{...f.state.records,legacy:{...f.state.records.legacy,ledger_head:'c'.repeat(64)}}},{...f.state,records:{...f.state.records,guardians:[]}}])assert.throws(()=>mod.resetBaseline(f.raw,f.pin,state));
 const missing=structuredClone(f.state);delete missing.records.legacy_adoption;assert.throws(()=>mod.resetBaseline(f.raw,f.pin,missing));
 assert.throws(()=>mod.resetBaseline(f.raw,'f'.repeat(64),f.state));
});
