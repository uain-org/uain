// Language-neutral golden contract fixtures (fixtures/contracts), chain client
// consumer. Skips only in a chain-only copy that has no repository fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonicalJSON,signingBytes} from './signing.mjs';

const dir=new URL('../../fixtures/contracts/',import.meta.url);
const skip=!existsSync(dir)&&'contract fixtures absent (chain-only copy)';
const fixture=name=>JSON.parse(readFileSync(new URL(name,dir),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const ME='js-chain-client';
function expectOutcome(name,want,run,key){
 assert.ok(want!==undefined,`${name}: no ${ME} outcome`);
 let value,error;try{value=run();}catch(e){error=e;}
 if(want==='refused'){assert.ok(error,`${name}: accepted, want refusal`);return;}
 assert.ifError(error);
 assert.equal(Buffer.isBuffer(value)?value.toString('utf8'):value,want[key],name);
}

test('chain canonical JSON vectors match byte for byte',{skip},()=>{
 const {chain}=fixture('canonical-json.json');
 for(const v of chain.vectors){const c=canonicalJSON(JSON.parse(v.json));assert.equal(c,v.canonical,v.name);assert.equal(sha(c),v.sha256,v.name);}
 for(const v of chain.edge_inputs)expectOutcome(v.name,v.outcomes[ME],()=>canonicalJSON(JSON.parse(v.json)),'canonical');
});

test('client signing bytes match every golden command',{skip},()=>{
 const f=fixture('command-signing.json');
 for(const v of f.vectors){const b=signingBytes(v.command);assert.equal(b.toString('utf8'),v.signing_bytes,v.name);assert.equal(sha(b),v.sha256,v.name);}
 for(const v of f.edge_commands)expectOutcome(v.name,v.outcomes[ME],()=>signingBytes(v.command),'signing_bytes');
});
