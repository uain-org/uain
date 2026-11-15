/** One modal lifetime and one pending identity operation own publication rights.
 * Invalidate synchronously on dismissal, and from effect cleanup on unmount.
 * React's effect setup may activate a fresh lifetime after cleanup; old tokens
 * never become valid again. Check a token after every asynchronous boundary.
 */
export function createIdentitySessionGate() {
  let active = false;
  let generation = 0;
  return {
    activate() {
      active = true;
      generation++;
    },
    invalidate() {
      active = false;
      generation++;
    },
    begin() {
      if (!active) return null;
      const operation = ++generation;
      return {
        isCurrent: () => active && operation === generation,
      };
    },
  };
}
