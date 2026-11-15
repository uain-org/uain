import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const earning=readFileSync(new URL('./NativeEarning.jsx',import.meta.url),'utf8');
const main=readFileSync(new URL('./main.jsx',import.meta.url),'utf8');
function recovery(){const start=earning.indexOf('const RECOVERY_SCHEMA'),end=earning.indexOf('\nfunction resultLabel',start);return runInNewContext(`(()=>{${earning.slice(start,end)};return recoveredIntent;})()`);}
const original={id:'original',command:{operation:'coin_quote',sequence:'7',expires_height:'100'},commandDigest:'d'.repeat(64),transactionHash:'e'.repeat(64),sendAttemptedAt:'2026-11-04T17:00:00Z',envelope:{command:{operation:'coin_quote'},signature:'original signature'}};
function answer(){return {intent:{...original,status:'expired-unused',recovery:{schema:'baink-native-earning-recovery-v1',verified:true,status:'expired-unused',paid:false,proof:{verified:true},commandDigest:original.commandDigest,sequence:'7',expiresHeight:'100',recordPresent:false}}};}
test('actual earning UI accepts service proof field for unchanged expired-unused intent',()=>{const value=answer();assert.equal(recovery()(original,value),value.intent);});
test('actual earning UI refuses altered command, paid recovery, and absent proof',()=>{for(const mutate of [x=>x.intent.command={...original.command,sequence:'8'},x=>x.intent.recovery.paid=true,x=>delete x.intent.recovery.proof,x=>x.intent.recovery.commandDigest='other',x=>x.intent.recovery.status='paid',x=>x.intent.recovery.recordPresent=true,x=>x.intent.recovery.sequence='8',x=>x.intent.recovery.expiresHeight='101',x=>x.intent.commandDigest='other',x=>x.intent.transactionHash='other',x=>x.intent.sendAttemptedAt='changed',x=>x.intent.envelope={signature:'changed'}]){const value=answer();mutate(value);assert.throws(()=>recovery()(original,value),/could not be checked/);}});
function payment(){const start=main.indexOf('  const preparePayment = async'),end=main.indexOf('  // Ends the current buyer review',start),updates=[],calls=[];const scope={api:async(...a)=>{calls.push(a);return{};},money:x=>String(x),navigate:x=>updates.push(['navigate',x]),setToast:x=>updates.push(['toast',x])};return{run:runInNewContext(`(()=>{${main.slice(start,end)};return preparePayment;})()`,scope),updates,calls};}

test('paying a request goes to Send money, where the member signs; no device-wallet payment is prepared',async()=>{
 const p=payment();assert.equal(await p.run({id:'r1',amount:'3'},{expectedTradeDigest:'a'.repeat(64),confirmTradeReview:true}),true);
 assert.deepEqual(p.updates[0],['navigate','Send money']);assert.match(p.updates[1][1],/Requests to pay/);assert.equal(p.calls.length,0,'no /pay call');
 const late=payment();assert.equal(await late.run({id:'r1',amount:'3'},{},{isCurrent:()=>false}),false);assert.equal(late.updates.length,0,'a closed review navigates nowhere');
});
