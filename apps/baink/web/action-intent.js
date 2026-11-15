import { canonical } from './identity.js';
/** One unchanged public metadata action keeps its ID until acknowledgement. */
export function createActionIntent() {
  let pending = null;
  return {
    prepare(fields, context = '') {
      const snapshot = structuredClone(fields),
        fingerprint = canonical({ context, snapshot });
      if (!pending || pending.fingerprint !== fingerprint)
        pending = {
          fingerprint,
          body: { ...snapshot, clientRequestId: crypto.randomUUID() },
        };
      const reviewed = pending;
      return {
        async run(send) {
          const result = await send(structuredClone(reviewed.body));
          if (pending === reviewed) pending = null;
          return result;
        },
      };
    },
  };
}
