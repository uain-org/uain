import { nativeProofFreshness, watchNativeProof } from './native-balance.js';

const FIELDS = ['projectId', 'taskId', 'workId', 'authorInstanceId'];
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set([
  'draft',
  'contested',
  'rejected',
  'believed',
  'superseded',
  'stale',
]);
const ACTIONS = new Set(['create', 'edit', 'retract', 'assert']);
const REVISION = ['id', 'base', 'state', 'action', 'statement', 'sources'];
const PROOF = [
  'authority',
  'chainId',
  'height',
  'appHash',
  'headerTime',
  'maxAgeSeconds',
  'epoch',
  'genesisSha256',
  'verifierSha256',
];
const TOP = [
  'status',
  'scope',
  'complete',
  'actorAddress',
  'binding',
  'association',
  'claim',
  'proof',
  'aiDollarPayment',
  'trust',
  'notice',
];
const NOTICE =
  'Selected claim provenance only. Complete history, trust, scientific confirmation and AI$ payment are not established.';
const enc = new TextEncoder();
const exact = (pattern, value) =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
function check(value) {
  if (!value)
    throw Error('Claim provenance does not match this holder and selection.');
}
function shaped(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        fields.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
        'value' in Object.getOwnPropertyDescriptor(value, key),
    )
  );
}
const validText = (value, max) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  enc.encode(value).length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
function selection(value) {
  check(
    shaped(value, FIELDS) && FIELDS.every((key) => exact(SELECTOR, value[key])),
  );
  return Object.fromEntries(FIELDS.map((key) => [key, value[key]]));
}
export function nativeWorkClaimPath(actorAddress, profileAddress, binding) {
  check(exact(ADDRESS, actorAddress) && actorAddress === profileAddress);
  return '/api/work/claim?' + new URLSearchParams(selection(binding));
}
const unknown = () => ({
  available: false,
  status: 'unavailable',
  scope: 'native-selected-work-claim',
  complete: false,
  actorAddress: null,
  binding: null,
  association: null,
  claim: null,
  proof: null,
  expiresAt: null,
  aiDollarPayment: 'not-established-by-this-record',
  trust: 'not-evaluated',
  notice: NOTICE,
});
function revision(value) {
  check(
    shaped(value, REVISION) &&
      exact(ID, value.id) &&
      (value.base === '' ||
        (exact(ID, value.base) && value.base !== value.id)) &&
      STATES.has(value.state) &&
      ACTIONS.has(value.action) &&
      validText(value.statement, 4000) &&
      Array.isArray(value.sources) &&
      value.sources.length <= 32 &&
      value.sources.every((source) => exact(ID, source)) &&
      new Set(value.sources).size === value.sources.length,
  );
  return {
    id: value.id,
    base: value.base,
    state: value.state,
    action: value.action,
    statement: value.statement,
    sources: [...value.sources],
  };
}
function claimView(value, binding) {
  check(
    shaped(value, [
      'id',
      'projectId',
      'sourceKey',
      'associationSourceKey',
      'associatedRevisionId',
      'associatedRevision',
      'believedRevision',
    ]) &&
      exact(ID, value.id) &&
      value.projectId === binding.projectId &&
      [`legacy_claim/${value.id}`, `legacy/claim/${value.id}`].includes(
        value.sourceKey,
      ) &&
      value.associationSourceKey === `legacy_answer_claim/${binding.workId}` &&
      exact(ID, value.associatedRevisionId),
  );
  const associatedRevision = revision(value.associatedRevision);
  check(
    associatedRevision.id === value.associatedRevisionId &&
      associatedRevision.sources.includes(binding.workId),
  );
  const believedRevision =
    value.believedRevision === null ? null : revision(value.believedRevision);
  check(believedRevision === null || believedRevision.state === 'believed');
  if (associatedRevision.state === 'believed')
    check(believedRevision?.id === associatedRevision.id);
  if (believedRevision?.id === associatedRevision.id)
    check(
      JSON.stringify(believedRevision) === JSON.stringify(associatedRevision),
    );
  return {
    id: value.id,
    projectId: value.projectId,
    sourceKey: value.sourceKey,
    associationSourceKey: value.associationSourceKey,
    associatedRevisionId: value.associatedRevisionId,
    associatedRevision,
    believedRevision,
  };
}
export function nativeWorkClaimView(
  payload,
  actorAddress,
  binding,
  { now = Date.now() } = {},
) {
  try {
    const expected = selection(binding);
    nativeWorkClaimPath(actorAddress, actorAddress, expected);
    check(
      shaped(payload, TOP) &&
        payload.scope === 'native-selected-work-claim' &&
        payload.complete === false &&
        payload.actorAddress === actorAddress &&
        ['available', 'unavailable'].includes(payload.status) &&
        shaped(payload.binding, FIELDS) &&
        FIELDS.every((key) => payload.binding[key] === expected[key]) &&
        payload.aiDollarPayment === 'not-established-by-this-record' &&
        payload.trust === 'not-evaluated' &&
        validText(payload.notice, 2048),
    );
    if (payload.status === 'unavailable') {
      check(
        payload.association === null &&
          payload.claim === null &&
          payload.proof === null,
      );
      return unknown();
    }
    const proof = payload.proof;
    check(
      shaped(proof, PROOF) &&
        exact(SELECTOR, proof.chainId) &&
        exact(/^[1-9][0-9]{0,18}$/, proof.height) &&
        [
          proof.appHash,
          proof.epoch,
          proof.genesisSha256,
          proof.verifierSha256,
        ].every((value) => exact(HASH, value)) &&
        proof.epoch === proof.genesisSha256,
    );
    const freshness = nativeProofFreshness(proof, { now });
    check(freshness.fresh);
    let claim = null;
    if (payload.association === 'absent') check(payload.claim === null);
    else {
      check(payload.association === 'present');
      claim = claimView(payload.claim, expected);
    }
    return {
      available: true,
      status: 'available',
      scope: 'native-selected-work-claim',
      complete: false,
      actorAddress,
      binding: expected,
      association: payload.association,
      claim,
      proof: Object.fromEntries(PROOF.map((key) => [key, proof[key]])),
      expiresAt: freshness.expiresAt,
      aiDollarPayment: 'not-established-by-this-record',
      trust: 'not-evaluated',
      notice: payload.notice,
    };
  } catch {
    return unknown();
  }
}

/** Selection and expiry never fetch. Each explicit read owns one signed GET. */
export function createNativeWorkClaimReader({
  request,
  publish,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let current = null;
  const emit = (context) => {
    if (current === context)
      publish({
        owner: context.identity,
        path: context.path,
        loading: context.loading,
        view: context.view,
        error: context.error,
        requested: context.requested,
      });
  };
  const expire = (context) => {
    if (
      current !== context ||
      !context.view.available ||
      nativeProofFreshness(context.view.proof, { now: now() }).fresh
    )
      return;
    context.token = null;
    context.clearTimer();
    context.clearTimer = () => {};
    context.view = unknown();
    context.loading = false;
    context.error =
      'The claim-provenance proof expired. Read the selected claim again.';
    emit(context);
  };
  const dispose = () => {
    if (current) {
      current.clearTimer();
      current.token = null;
    }
    current = null;
  };
  return {
    select(identity, profileAddress, binding) {
      dispose();
      const path = nativeWorkClaimPath(
        identity?.address,
        profileAddress,
        binding,
      );
      current = {
        identity,
        path,
        profileAddress,
        binding: selection(binding),
        view: unknown(),
        loading: false,
        error: '',
        requested: false,
        pending: null,
        token: null,
        clearTimer: () => {},
      };
      emit(current);
    },
    read() {
      const context = current;
      if (!context) return Promise.resolve();
      if (context.pending) return context.pending;
      const token = {};
      context.token = token;
      const live = () => current === context && context.token === token;
      context.clearTimer();
      context.clearTimer = () => {};
      context.view = unknown();
      context.loading = true;
      context.error = '';
      context.requested = true;
      emit(context);
      const job = Promise.resolve().then(async () => {
        try {
          if (!live()) return;
          const payload = await request(context.path, {
            identity: context.identity,
            method: 'GET',
          });
          if (!live()) return;
          const view = nativeWorkClaimView(
            payload,
            context.identity.address,
            context.binding,
            { now: now() },
          );
          context.view = view;
          context.loading = false;
          context.error = view.available
            ? ''
            : 'Claim provenance is unavailable for this selection. No current claim or belief is inferred.';
          if (view.available)
            context.clearTimer = watchNativeProof(
              view.proof,
              () => expire(context),
              { now, setTimer, clearTimer },
            );
          emit(context);
        } catch {
          if (!live()) return;
          context.view = unknown();
          context.loading = false;
          context.error =
            'Selected claim provenance could not be read. Try again.';
          emit(context);
        } finally {
          context.pending = null;
        }
      });
      context.pending = job;
      return job;
    },
    checkFreshness() {
      if (current) expire(current);
    },
    dispose,
  };
}
