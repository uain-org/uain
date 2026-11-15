/** Other native flows must not race an unresolved pilot send for this holder.
 * This is a local journal fence, not a network sequence lock. */
export function hasPendingPilotSend(state, member) {
  return Object.values(state.nativeProjectPilotIntents ?? {}).some(intent =>
    intent.member === member && intent.sendAttemptedAt &&
    !['finalized', 'expired_unincluded'].includes(intent.status));
}
