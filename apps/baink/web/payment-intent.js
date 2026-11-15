/** Keep one idempotency key for an unchanged payment intent until acknowledged success. */
export function createPaymentIntent() {
  let pending = null;
  return {
    invalidate() {
      pending = null;
    },
    prepare(fields) {
      const snapshot = {
        to: fields.to,
        amount: fields.amount,
        memo: fields.memo,
      };
      const fingerprint = JSON.stringify(snapshot);
      if (!pending || pending.fingerprint !== fingerprint)
        pending = {
          fingerprint,
          body: { ...snapshot, clientRequestId: crypto.randomUUID() },
        };
      const intent = pending;
      return {
        async run(send) {
          const result = await send({ ...intent.body });
          // A network or server error above retains the key; only acknowledged success completes it.
          if (pending === intent) pending = null;
          return result;
        },
      };
    },
  };
}
