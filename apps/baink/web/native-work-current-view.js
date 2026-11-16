import { nativeProofFreshness, watchNativeProof } from './native-balance.js';
const ADDRESS = /^uain1[a-f0-9]{40}$/,
  ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,
  HASH = /^[a-f0-9]{64}$/;
const FIELDS = ['projectId', 'taskId', 'workId', 'authorInstanceId'];
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, empty = false) =>
  typeof value === 'string' &&
  (empty || value.length > 0) &&
  value.length <= 80 &&
  !/[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
function check(value) {
  if (!value)
    throw Error(
      'Current native work status does not match this holder and selection.',
    );
}
function selection(binding) {
  check(
    object(binding) &&
      Object.keys(binding).length === 4 &&
      FIELDS.every(
        (key) => typeof binding[key] === 'string' && ID.test(binding[key]),
      ),
  );
  return Object.fromEntries(FIELDS.map((key) => [key, binding[key]]));
}
export function nativeWorkCurrentPath(actorAddress, profileAddress, binding) {
  check(
    typeof actorAddress === 'string' &&
      ADDRESS.test(actorAddress) &&
      actorAddress === profileAddress,
  );
  return '/api/work/current?' + new URLSearchParams(selection(binding));
}
const unknown = () => ({
  available: false,
  status: 'unavailable',
  work: null,
  task: null,
  project: null,
  proof: null,
  expiresAt: null,
  claimBelief: 'not-evaluated',
  aiDollarPayment: 'not-established-by-this-record',
});
export function nativeWorkCurrentView(
  payload,
  actorAddress,
  binding,
  { now = Date.now() } = {},
) {
  try {
    const expected = selection(binding);
    nativeWorkCurrentPath(actorAddress, actorAddress, expected);
    check(
      object(payload) &&
        payload.scope === 'native-current-work-status' &&
        payload.complete === false &&
        payload.actorAddress === actorAddress &&
        ['available', 'unavailable'].includes(payload.status) &&
        object(payload.binding) &&
        Object.keys(payload.binding).length === 4 &&
        FIELDS.every((key) => payload.binding[key] === expected[key]) &&
        payload.claimBelief === 'not-evaluated' &&
        payload.aiDollarPayment === 'not-established-by-this-record',
    );
    if (payload.status === 'unavailable') return unknown();
    const { work, task, project, proof } = payload;
    check(
      object(proof) &&
        typeof proof.chainId === 'string' &&
        ID.test(proof.chainId) &&
        typeof proof.height === 'string' &&
        /^[1-9][0-9]{0,18}$/.test(proof.height) &&
        [
          proof.appHash,
          proof.epoch,
          proof.genesisSha256,
          proof.verifierSha256,
        ].every((value) => typeof value === 'string' && HASH.test(value)) &&
        proof.epoch === proof.genesisSha256,
    );
    const freshness = nativeProofFreshness(proof, { now });
    check(freshness.fresh);
    const records = [
      `legacy_work/${expected.workId}`,
      `legacy/work/${expected.workId}`,
    ];
    check(
      object(work) &&
        work.id === expected.workId &&
        work.projectId === expected.projectId &&
        work.taskId === expected.taskId &&
        work.authorInstanceId === expected.authorInstanceId &&
        work.memberAddress === actorAddress &&
        work.kind === 'work' &&
        text(work.state) &&
        text(work.pending, true) &&
        text(work.withheld, true) &&
        records.includes(work.recordSourceKey) &&
        [
          `legacy_work_status/${expected.workId}`,
          work.recordSourceKey,
        ].includes(work.statusSourceKey),
    );
    check(
      object(task) &&
        task.id === expected.taskId &&
        text(task.state) &&
        text(task.kind) &&
        text(task.outcome, true) &&
        [
          `legacy_task/${expected.taskId}`,
          `legacy/task/${expected.taskId}`,
        ].includes(task.sourceKey),
    );
    check(
      object(project) &&
        project.id === expected.projectId &&
        text(project.state) &&
        [
          `legacy_project/${expected.projectId}`,
          `legacy/project/${expected.projectId}`,
        ].includes(project.sourceKey),
    );
    return {
      available: true,
      status: 'available',
      actorAddress,
      binding: expected,
      work: Object.fromEntries(
        [
          'id',
          ...FIELDS.filter((key) => key !== 'workId'),
          'memberAddress',
          'kind',
          'state',
          'pending',
          'withheld',
          'statusSourceKey',
          'recordSourceKey',
        ].map((key) => [key, work[key]]),
      ),
      task: {
        id: task.id,
        state: task.state,
        kind: task.kind,
        outcome: task.outcome,
        sourceKey: task.sourceKey,
      },
      project: {
        id: project.id,
        state: project.state,
        sourceKey: project.sourceKey,
      },
      proof: Object.fromEntries(
        [
          'authority',
          'chainId',
          'height',
          'appHash',
          'headerTime',
          'maxAgeSeconds',
          'epoch',
          'genesisSha256',
          'verifierSha256',
        ].map((key) => [key, proof[key]]),
      ),
      expiresAt: freshness.expiresAt,
      claimBelief: 'not-evaluated',
      aiDollarPayment: 'not-established-by-this-record',
    };
  } catch {
    return unknown();
  }
}
export function createNativeWorkCurrentGate() {
  let active = null,
    generation = 0;
  return {
    begin(actorAddress, profileAddress, binding) {
      nativeWorkCurrentPath(actorAddress, profileAddress, binding);
      active = Object.freeze({
        actorAddress,
        binding: Object.freeze(selection(binding)),
        generation: ++generation,
      });
      return active;
    },
    invalidate() {
      active = null;
      generation++;
    },
    isCurrent(context) {
      return context !== null && active === context;
    },
    apply(context, update) {
      if (context === null || active !== context) return false;
      update();
      return true;
    },
  };
}
/** Selection never fetches. Only an explicit read starts one signed current-status request. */
export function createNativeWorkCurrentReader({
  request,
  publish,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let current = null;
  const gate = createNativeWorkCurrentGate();
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
    gate.invalidate();
    context.clearTimer();
    context.view = unknown();
    context.loading = false;
    context.error = 'The current-status proof expired. Read the status again.';
    emit(context);
  };
  const dispose = () => {
    if (current) current.clearTimer();
    current = null;
    gate.invalidate();
  };
  return {
    select(identity, profileAddress, binding) {
      dispose();
      const path = nativeWorkCurrentPath(
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
        clearTimer: () => {},
      };
      emit(current);
    },
    read() {
      const context = current;
      if (!context) return Promise.resolve();
      if (context.pending) return context.pending;
      const token = gate.begin(
        context.identity.address,
        context.profileAddress,
        context.binding,
      );
      context.clearTimer();
      context.view = unknown();
      context.loading = true;
      context.error = '';
      context.requested = true;
      emit(context);
      const job = Promise.resolve().then(async () => {
        try {
          const payload = await request(context.path, {
            identity: context.identity,
          });
          const view = nativeWorkCurrentView(
            payload,
            context.identity.address,
            context.binding,
            { now: now() },
          );
          if (current !== context) return;
          gate.apply(token, () => {
            context.view = view;
            context.loading = false;
            context.error = view.available
              ? ''
              : 'Current native status is unavailable for this selection. No current state is inferred.';
            if (view.available)
              context.clearTimer = watchNativeProof(
                view.proof,
                () => expire(context),
                { now, setTimer, clearTimer },
              );
            emit(context);
          });
        } catch {
          if (current !== context) return;
          gate.apply(token, () => {
            context.view = unknown();
            context.loading = false;
            context.error =
              'Current native status could not be read. Try again.';
            emit(context);
          });
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
