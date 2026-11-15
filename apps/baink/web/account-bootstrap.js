import {
  clearNativeAuthority,
  nativeBalanceView,
  nativeProofFreshness,
} from './native-balance.js';
function ownedAccount(account, identity) {
  if (
    !account ||
    account.address !== identity.address ||
    account.publicKey !== identity.publicKeyBase64
  )
    throw Error('Account response does not match this identity.');
  return account;
}
function metadataAccount(response, identity) {
  const account = ownedAccount(response?.account, identity);
  const allowed = new Set([
    'address',
    'publicKey',
    'displayName',
    'createdAt',
    'updatedAt',
    'currency',
    'balance',
    'nativeRegistration',
  ]);
  if (
    response.nativeStatus !== 'not-requested' ||
    Object.keys(account).some((key) => !allowed.has(key)) ||
    account.currency !== 'AI$' ||
    account.balance !== null ||
    account.nativeRegistration !== 'unavailable' ||
    typeof account.displayName !== 'string'
  )
    throw Error('Account metadata must not establish native authority.');
  return clearNativeAuthority(account);
}
/** Metadata authenticates local workspace access; only a missing local account follows existing creation. */
export function createAccountEntryLoader(request) {
  let generation = 0;
  let pending = null;
  return {
    invalidate() {
      pending?.abort();
      generation++;
    },
    async load(identity, displayName, isNew = false) {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const current = ++generation;
      const ownership = { signal: controller.signal, isCurrent: () => current === generation };
      try {
        const create = async () => {
          const created = await request('/api/account', {
            identity,
            ...ownership,
            method: 'POST',
            body: { displayName },
          });
          if (current !== generation) return null;
          if (created?.nativeStatus !== undefined) {
            return {account: metadataAccount(created, identity), needsNativeRefresh: true};
          }
          return {account: ownedAccount(created?.account, identity), needsNativeRefresh: false};
        };
        if (isNew === true) return await create();
        let response;
        try {
          response = await request('/api/account/metadata', { identity, ...ownership });
        } catch (error) {
          if (current !== generation) return null;
          if (error.code !== 'account_missing') throw error;
          return await create();
        }
        return current === generation
          ? {
              account: metadataAccount(response, identity),
              needsNativeRefresh: true,
            }
          : null;
      } catch (error) {
        if (current !== generation) return null;
        throw error;
      }
    },
  };
}
/** Initial hydration, refresh controls and visibility/timer refreshes share one owned in-flight proof. */
export function createNativeAccountRefresh(request, publish) {
  let current = null;
  return {
    activate(identity) {
      current?.controller.abort();
      current = { identity, pending: null, controller: new AbortController() };
    },
    invalidate() {
      current?.controller.abort();
      current = null;
    },
    isCurrent(identity) {
      return current !== null && current.identity === identity;
    },
    refresh() {
      const context = current;
      if (!context) return Promise.resolve();
      if (context.pending) return context.pending;
      publish({ kind: 'native-pending' });
      const job = (async () => {
        try {
          const response = await Promise.resolve().then(() =>
            request('/api/account', { identity: context.identity, signal: context.controller.signal, isCurrent: () => current === context }),
          );
          const account = ownedAccount(response?.account, context.identity);
          if (current === context) publish({ kind: 'native', account });
        } catch (error) {
          if (current === context) publish({ kind: 'native-error', error });
        } finally {
          context.pending = null;
        }
      })();
      context.pending = job;
      return job;
    },
  };
}
/** Activity rows publish separately; a slow proof or one failed activity read cannot withhold another. */
export async function hydrateAccountActivity(
  request,
  identity,
  { allPage, incomingPage },
  publish,
  isCurrent,
) {
  await Promise.allSettled(
    [
      [
        'requests',
        `/api/requests?page=${allPage}&pageSize=50&direction=all&status=all`,
      ],
      ['history', '/api/history'],
      [
        'incoming',
        `/api/requests?page=${incomingPage}&pageSize=50&direction=incoming&status=open`,
      ],
    ].map(async ([kind, path]) => {
      if (isCurrent()) publish({ kind: 'activity-pending', source: kind });
      try {
        const data = await request(path, { identity, isCurrent });
        const page = kind === 'incoming' ? incomingPage : allPage;
        if (
          kind === 'history'
            ? !Array.isArray(data?.history)
            : !Array.isArray(data?.requests) ||
              !Number.isSafeInteger(data.count) ||
              data.count < 0 ||
              data.page !== page ||
              data.pageSize !== 50 ||
              data.pages !== Math.max(1, Math.ceil(data.count / 50)) ||
              data.requests.length !==
                Math.min(50, Math.max(0, data.count - (page - 1) * 50))
        )
          throw Error('This activity response could not be verified.');
        if (isCurrent()) publish({ kind, data });
      } catch (error) {
        if (isCurrent())
          publish({ kind: 'activity-error', source: kind, error });
      }
    }),
  );
}
const activityLabels = {
  incoming: 'Incoming requests',
  requests: 'Payment requests',
  history: 'Account activity',
};
export function initialActivityReadiness() {
  return Object.fromEntries(
    Object.keys(activityLabels).map((kind) => [kind, { status: 'pending' }]),
  );
}
export function reduceActivityReadiness(readiness, event) {
  const source = Object.hasOwn(activityLabels, event.kind)
    ? event.kind
    : event.source;
  if (!Object.hasOwn(activityLabels, source)) return readiness;
  const status =
    event.kind === 'activity-pending'
      ? 'pending'
      : event.kind === 'activity-error'
        ? 'error'
        : 'ready';
  return { ...readiness, [source]: { status } };
}
export function activityReadView(readiness, source, data) {
  const status = readiness?.[source]?.status ?? 'pending',
    ready = status === 'ready';
  return {
    ready,
    loading: status === 'pending',
    count: ready
      ? source === 'history'
        ? data.history.length
        : data.count
      : undefined,
    message:
      status === 'error'
        ? `${activityLabels[source]} ${source === 'history' ? 'is' : 'are'} temporarily unavailable. Try again.`
        : `Loading ${activityLabels[source].toLowerCase()}…`,
  };
}
export function accountBalanceView(account, pending = false) {
  if (pending && !nativeProofFreshness(account?.native?.proof).fresh)
    return {
      ...nativeBalanceView(clearNativeAuthority(account)),
      state: 'checking',
      label: 'Checking native network status…',
      message:
        'Your local account is open. Native membership and balance have not been verified yet.',
    };
  return nativeBalanceView(account);
}
