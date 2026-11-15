/** Local send admission only. Native signatures/sequences remain authoritative.
 * Call inside the SAME durable transaction that writes sendAttemptedAt.
 * A CheckTx refusal or elapsed wall-clock time is not proof of noninclusion.
 */
export function hasPendingNativeSend(state,member){
 for(const key of ['nativeIntents','nativeInstanceIntents','nativeEarningIntents','centralEarningIntents','nativeProjectPilotIntents']){
  for(const row of Object.values(state[key]??{})){
   const signer=row?.command?.member??row?.member;
   if(signer===member&&row.sendAttemptedAt&&!['finalized','expired-unused','expired_unincluded'].includes(row.status))return true;
  }
 }
 // Browser sends (server-send.mjs): a signed attempt that is neither final nor
 // proved unincluded holds the payer's sequence.
 for(const row of Object.values(state.serverSendIntents??{})){
  if(row?.intent?.from!==member)continue;
  const a=row.attempts?.at(-1);
  if(a?.sendAttemptedAt&&!['finalized','expired-unused'].includes(a.status))return true;
 }
 return false;
}
