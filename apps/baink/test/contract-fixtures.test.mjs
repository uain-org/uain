// Language-neutral golden contract fixtures (fixtures/contracts), BAINK consumer.
// The same JSON files are asserted by chain/client, the Go chain, the project
// organization service and Python custody.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {centralEarningSigningBytes,centralPayload,CENTRAL_LIFETIME_UNITS,CENTRAL_PROJECT_UNITS} from '../server/central-earning-command.mjs';
import {canonicalJSON,nativeFinancialSigningBytes} from '../server/native-financial-command.mjs';

const fixture=name=>JSON.parse(readFileSync(new URL('../../../fixtures/contracts/'+name,import.meta.url),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const ME='js-baink';
const outcome=f=>{try{return {value:f()};}catch(e){return {error:e instanceof SyntaxError?'SyntaxError':e.message};}};
function expectOutcome(name,want,run,key){
 assert.ok(want!==undefined,`${name}: no ${ME} outcome`);
 const got=outcome(run);
 if(want==='refused'){assert.ok('error' in got,`${name}: accepted, want refusal`);return;}
 if(want==='accepted'){assert.ok(!('error' in got),`${name}: refused ${got.error}`);return;}
 if('refused' in want){assert.equal(got.error,want.refused,name);return;}
 assert.ok(!('error' in got),`${name}: refused ${got.error}`);
 assert.equal(Buffer.isBuffer(got.value)?got.value.toString('utf8'):got.value,want[key],name);
}

test('chain canonical JSON vectors match byte for byte',()=>{
 const {chain}=fixture('canonical-json.json');
 assert.ok(chain.vectors.length>0&&chain.edge_inputs.length>0);
 for(const v of chain.vectors){const c=canonicalJSON(JSON.parse(v.json));assert.equal(c,v.canonical,v.name);assert.equal(sha(c),v.sha256,v.name);}
 for(const v of chain.edge_inputs)expectOutcome(v.name,v.outcomes[ME],()=>canonicalJSON(JSON.parse(v.json)),'canonical');
});

test('central earning signing bytes are unchanged for every golden command',()=>{
 const f=fixture('command-signing.json');
 assert.ok(f.vectors.length>0);
 for(const v of f.vectors){const b=centralEarningSigningBytes(v.command);assert.equal(b.toString('utf8'),v.signing_bytes,v.name);assert.equal(sha(b),v.sha256,v.name);}
 for(const v of f.edge_commands)expectOutcome(v.name,v.outcomes[ME],()=>centralEarningSigningBytes(v.command),'signing_bytes');
});

test('duplicate, unknown and miscased fields keep their refusals',()=>{
 const f=fixture('field-rejections.json');
 for(const v of f.commands)expectOutcome(v.name,v.outcomes[ME],()=>centralEarningSigningBytes(JSON.parse(v.json)),'signing_bytes');
 for(const v of f.payloads)expectOutcome(v.name,v.outcomes[ME],()=>centralPayload(v.operation,v.payload),'payload');
});

test('five-KPI plan and fund round rules',()=>{
 const {vectors}=fixture('five-kpi-plan.json');
 assert.ok(vectors.some(v=>v.valid)&&vectors.some(v=>!v.valid));
 for(const v of vectors)assert.equal(!('error' in outcome(()=>centralPayload(v.operation,v.payload))),v.valid,v.name);
});

test('integer amount constants and boundaries are exact',()=>{
 const f=fixture('amounts.json'),signing=fixture('command-signing.json');
 assert.equal(CENTRAL_LIFETIME_UNITS.toString(),f.constants.lifetime_ceiling_units);
 assert.equal(CENTRAL_PROJECT_UNITS.toString(),f.constants.project_allocation_units);
 assert.equal(BigInt(f.constants.lifetime_ceiling_units),1000000000n*BigInt(f.constants.units_per_aid));
 const task=signing.vectors.find(v=>v.command.operation==='central_task_open').command.payload;
 for(const p of f.task_amount_pairs)assert.equal(!('error' in outcome(()=>centralPayload('central_task_open',{...task,solver_amount:p.solver_amount,reviewer_amount:p.reviewer_amount}))),p.valid,JSON.stringify(p));
 // Each single amount, paired with the smallest other amount, so only the value under test can fail.
 for(const v of f.task_amounts){
  const ok=!('error' in outcome(()=>centralPayload('central_task_open',{...task,solver_amount:v.value,reviewer_amount:'1'})));
  const fits=v.positive&&BigInt(v.value)+1n<=BigInt(f.constants.lifetime_ceiling_units);
  assert.equal(ok,fits,JSON.stringify(v.value));
 }
 const quote=amount=>({version:1,chain_id:'uain-shadow-20261008-1',member:signing.vectors[0].command.member,sequence:'1',expires_height:'2',operation:'coin_quote',payload:{task:'T-contract.1',open_event:'00000000000000000001',amount,evidence_digest:'a'.repeat(64)}});
 for(const v of f.coin_units)assert.equal(!('error' in outcome(()=>nativeFinancialSigningBytes(quote(v.value)))),v.positive,v.value);
});
