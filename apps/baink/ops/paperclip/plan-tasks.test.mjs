import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli=fileURLToPath(new URL('./plan-tasks.mjs',import.meta.url));
const proposal=()=>[{project:{id:'synthetic-project',sourceSha256:'b'.repeat(64),workflow:'native'},task:{id:'synthetic-task',title:'Review the bounded open research gap',class:'neutral',criteria:'',priorArt:{basis:'',searches:[]},creditReward:'0',karmaReward:0}}];
const run=input=>spawnSync(process.execPath,[cli],{input,encoding:'utf8',timeout:5000,maxBuffer:3*1024*1024});
test('CLI deterministically plans only: unknown research remains draft, no payout',()=>{
 const input=JSON.stringify(proposal()),a=run(input),b=run(input);
 assert.equal(a.status,0);assert.equal(a.stderr,'');assert.equal(a.stdout,b.stdout);
 const result=JSON.parse(a.stdout);assert.equal(result.plans[0].status,'needs-research');assert.equal(result.executionAvailable,false);assert.equal(result.plans[0].reward.paid,null);
});
test('CLI refuses malformed, oversized and authority-bearing JSON without echoing it',()=>{
 for(const input of ['{invalid-secret-input',' '.repeat(256*1024+1),JSON.stringify([{privateKey:'not-a-real-key'}]),JSON.stringify([])]){
 const r=run(input);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'Task planning refused invalid or oversized input.\n');
 }
});
test('CLI rejects invalid UTF8 rather than silently rewriting signed/source text',()=>{
 const input=Buffer.from(JSON.stringify(proposal()));const start=input.indexOf('Review');input[start]=0xff;
 const r=run(input);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'Task planning refused invalid or oversized input.\n');
});
