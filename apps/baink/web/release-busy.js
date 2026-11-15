import { useLayoutEffect, useRef } from 'react';
import { setReleaseBusy } from './release-update.js';
/** Include local signing/holder work that is not an HTTP API write. */
export function useReleaseBusy(busy) {
  const token = useRef(Symbol('release-action'));
  useLayoutEffect(() => {
    setReleaseBusy(token.current, Boolean(busy));
    return () => setReleaseBusy(token.current, false);
  }, [busy]);
}
