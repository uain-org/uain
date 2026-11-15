import test from 'node:test';import assert from 'node:assert/strict';
import {hasPendingNativeSend} from '../server/native-sequence-fence.mjs';
const owner='uain1'+'a'.repeat(40),other='uain1'+'b'.repeat(40);
test('every native public command journal fences another unresolved send for the same signer',()=>{
 for(const journal of ['nativeIntents','nativeInstanceIntents','nativeEarningIntents','centralEarningIntents','nativeProjectPilotIntents']){
  const state={[journal]:{i:{id:'i',member:owner,command:{member:owner},sendAttemptedAt:'2026-11-05T00:00:00Z',status:'unknown'}}};assert.equal(hasPendingNativeSend(state,owner),true,journal);assert.equal(hasPendingNativeSend(state,other),false,journal);
 }
});
test('only proved terminal phases release the local sequence fence',()=>{
 for(const status of ['prepared','accepted','refused','broadcasting','unknown','expired'])assert.equal(hasPendingNativeSend({centralEarningIntents:{i:{member:owner,sendAttemptedAt:'now',status}}},owner),true,status);
 for(const status of ['finalized','expired-unused','expired_unincluded'])assert.equal(hasPendingNativeSend({centralEarningIntents:{i:{member:owner,sendAttemptedAt:'now',status}}},owner),false,status);
 assert.equal(hasPendingNativeSend({centralEarningIntents:{i:{member:owner,status:'prepared'}}},owner),false);
});
test('fence follows the actual signed command member rather than a different metadata owner',()=>{
 assert.equal(hasPendingNativeSend({nativeEarningIntents:{i:{member:other,command:{member:owner},sendAttemptedAt:'now',status:'accepted'}}},owner),true);
 assert.equal(hasPendingNativeSend({nativeEarningIntents:{i:{member:owner,command:{member:other},sendAttemptedAt:'now',status:'accepted'}}},owner),false);
});
