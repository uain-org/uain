import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPendingPilotSend} from '../server/native-pilot-sequence.mjs';
test('only unresolved own pilot sends block other native services',()=>{
 const intent={member:'owner',sendAttemptedAt:'now',status:'unknown'},state={nativeProjectPilotIntents:{a:intent}};
 assert.equal(hasPendingPilotSend(state,'owner'),true);assert.equal(hasPendingPilotSend(state,'other'),false);
 for(const status of ['finalized','expired_unincluded']){intent.status=status;assert.equal(hasPendingPilotSend(state,'owner'),false);}
 for(const status of ['accepted','refused','broadcasting']){intent.status=status;assert.equal(hasPendingPilotSend(state,'owner'),true);}
 intent.sendAttemptedAt=null;assert.equal(hasPendingPilotSend(state,'owner'),false);
});
