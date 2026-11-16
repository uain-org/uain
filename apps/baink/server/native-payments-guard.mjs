/** The device-wallet payment service with the shared request guard in front of `prepare`
 * (`/api/native/payments/prepare`, `/api/requests/:id/pay`).
 *
 * `native-payments.mjs` is part of the custody payment service's and the review broker's
 * pinned source closures (`ops/custody/private_payment_service.py` SOURCE_FILES), so it
 * must not gain an import: a new one would be missing from those releases. The guard is
 * therefore applied here, where BAINK composes its services.
 *
 * `prepare` keeps its own checks inside its transaction (its lock, the send lock, a
 * finalized send), which cover two payments racing each other. This guard adds what a
 * lock map cannot show: a payment on either path that landed or may still land although
 * no lock names it. Those states do not come and go between this read and that
 * transaction, so reading first is enough.
 */
import { NativePaymentError } from './native-payments.mjs';
import { assertRequestUnpaid } from './request-payment-guard.mjs';

const check = (ok, status, code, message) => { if (!ok) throw new NativePaymentError(status, code, message); };

export function withRequestGuard(service, store) {
  return Object.freeze(Object.create(service, {
    prepare: {
      enumerable: true,
      async value(user, body) {
        if (typeof body?.requestId === 'string') {
          const state = store.read();
          // A repeat of the caller's own prepare is answered by the service from its journal.
          const replay = Object.values(state.nativePaymentIntents ?? {}).some((i) => i.payer === user?.address && i.clientRequestId === body.clientRequestId);
          if (!replay) assertRequestUnpaid(state, body.requestId, check);
        }
        return service.prepare(user, body);
      },
    },
  }));
}
