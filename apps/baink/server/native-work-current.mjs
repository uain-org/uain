import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ADDRESS = /^uain1[a-f0-9]{40}$/,
  HASH = /^[a-f0-9]{64}$/;
const FIELDS = ['projectId', 'taskId', 'workId', 'authorInstanceId'];
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
const NOTICE =
  'This is one selected native operational work-status snapshot, not complete history, a current scientific novelty assessment, execution eligibility or an AI$ payment. Claim belief is not evaluated. Frozen imported history remains a separate view.';
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, empty = false) =>
  typeof x === 'string' &&
  (empty || x.length > 0) &&
  x.length <= 80 &&
  !/[\x00-\x1f\x7f]/.test(x);
const requireProof = (ok) => {
  if (!ok) throw new Error('Native current work proof unavailable');
};
export class NativeWorkCurrentError extends Error {
  constructor(status, code) {
    super('Current native work status could not be read.');
    this.status = status;
    this.code = code;
  }
}
function input(actor, query) {
  if (
    !object(query) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(query)) ||
    Object.keys(query).length !== 4 ||
    !FIELDS.every(
      (k) =>
        Object.hasOwn(query, k) &&
        typeof query[k] === 'string' &&
        ID.test(query[k]),
    )
  )
    throw new NativeWorkCurrentError(400, 'invalid_query');
  if (
    !ADDRESS.test(actor?.address ?? '') ||
    typeof actor?.publicKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(actor.publicKey)
  )
    throw new NativeWorkCurrentError(400, 'invalid_actor');
  const bytes = Buffer.from(actor.publicKey, 'base64');
  if (
    bytes.length !== 32 ||
    bytes.toString('base64') !== actor.publicKey ||
    'uain1' + createHash('sha256').update(bytes).digest('hex').slice(0, 40) !==
      actor.address
  )
    throw new NativeWorkCurrentError(400, 'invalid_actor');
  return {
    address: actor.address,
    publicKey: actor.publicKey,
    nativeKey: bytes.toString('base64url'),
    binding: Object.fromEntries(FIELDS.map((k) => [k, query[k]])),
  };
}
function answer(t, work = null, task = null, project = null, proof = null) {
  return {
    status: proof ? 'available' : 'unavailable',
    scope: 'native-current-work-status',
    complete: false,
    actorAddress: t.address,
    binding: { ...t.binding },
    work,
    task,
    project,
    proof,
    claimBelief: 'not-evaluated',
    aiDollarPayment: 'not-established-by-this-record',
    notice: NOTICE,
  };
}
function fresh(proof, clock) {
  if (typeof proof?.headerTime !== 'string') return false;
  const match = proof.headerTime.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.map(Number);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return false;
  const current = clock(),
    header = Date.parse(proof.headerTime);
  return (
    Number.isInteger(proof.maxAgeSeconds) &&
    proof.maxAgeSeconds >= 1 &&
    proof.maxAgeSeconds <= 120 &&
    Number.isFinite(current) &&
    Number.isFinite(header) &&
    header <= current + 60000 &&
    current < header + proof.maxAgeSeconds * 1000
  );
}
function keysFor(t) {
  const {
    address: a,
    binding: { projectId: p, taskId: k, workId: w, authorInstanceId: i },
  } = t;
  return [
    `member/${a}`,
    'legacy_import',
    `legacy/account/${a}`,
    `legacy_account_claimed/${a}`,
    `legacy_project/${p}`,
    `legacy/project/${p}`,
    `legacy_task/${k}`,
    `legacy/task/${k}`,
    `legacy_work_status/${w}`,
    `legacy_work/${w}`,
    `legacy/work/${w}`,
    `instance/${i}`,
    `legacy_actor/${i}`,
    `legacy/actor/${i}`,
  ];
}
function typedText(raw, key, empty = false) {
  const value = raw[key] === undefined && empty ? '' : raw[key];
  requireProof(text(value, empty));
  return value;
}
function list(raw, key, limit, required = false) {
  const value = raw[key];
  if (!required && (value === undefined || value === null)) return [];
  requireProof(
    Array.isArray(value) &&
      value.length <= limit &&
      value.every((v) => typeof v === 'string' && ID.test(v)),
  );
  return value;
}
function effective(records, mutable, frozen) {
  const key = records[mutable] === null ? frozen : mutable,
    value = records[key];
  requireProof(object(value));
  return { key, value };
}
function contextProof(context, t, keys, pins, clock) {
  const { state: s, proof: p } = context ?? {},
    r = s?.records;
  requireProof(
    object(s) &&
      object(r) &&
      object(p) &&
      p.authority === 'native' &&
      p.chainId === pins.chainId &&
      p.epoch === pins.epoch &&
      p.genesisSha256 === pins.epoch &&
      p.verifierSha256 === pins.verifierSha256 &&
      /^[1-9][0-9]{0,18}$/.test(p.height ?? '') &&
      HASH.test(p.appHash ?? '') &&
      text(p.headerTime) &&
      fresh(p, clock),
  );
  requireProof(
    s.chain_id === p.chainId &&
      s.height === p.height &&
      s.app_hash === p.appHash &&
      s.header_time === p.headerTime &&
      keys.every((k) => Object.hasOwn(r, k)),
  );
  const member = s.member,
    selected = r[`member/${t.address}`];
  requireProof(
    object(member) &&
      object(selected) &&
      member.id === t.address &&
      member.public_key === t.nativeKey &&
      [
        'id',
        'public_key',
        'name',
        'family',
        'operator',
        'licence',
        'sequence',
      ].every((k) => member[k] === selected[k]),
  );
  // No active-licence requirement: this is a holder's source-status read.
  const imported = r.legacy_import,
    account = r[`legacy/account/${t.address}`],
    claimed = r[`legacy_account_claimed/${t.address}`];
  requireProof(
    imported?.policy === 'legacy-preservation-v1' &&
      imported.status === 'ready' &&
      HASH.test(imported.manifest_digest ?? '') &&
      object(account) &&
      account.id === t.address &&
      account.public_key === t.nativeKey &&
      Array.isArray(account.instances) &&
      account.instances.length <= 4096 &&
      object(claimed) &&
      claimed.manifest_digest === imported.manifest_digest &&
      Number.isSafeInteger(claimed.instances) &&
      claimed.instances === account.instances.length,
  );
  return Object.fromEntries(PROOF.map((k) => [k, p[k]]));
}
function projectView(context, t, pins, clock) {
  const r = context.state.records,
    { projectId: p, taskId: k, workId: w, authorInstanceId: i } = t.binding;
  const full = effective(r, `legacy_work/${w}`, `legacy/work/${w}`),
    work = full.value;
  requireProof(
    work.id === w &&
      work.project === p &&
      work.task === k &&
      work.author === i &&
      work.member === t.address &&
      work.kind === 'work',
  );
  requireProof(
    (work.checks === undefined ||
      work.checks === null ||
      (Array.isArray(work.checks) && work.checks.length <= 32)) &&
      (work.claimed === undefined ||
        (Number.isSafeInteger(work.claimed) &&
          work.claimed >= 0 &&
          work.claimed <= 1000000)),
  );
  const fullFlags = {
    state: typedText(work, 'state'),
    pending: typedText(work, 'pending', true),
    withheld: typedText(work, 'withheld', true),
    comparison: list(work, 'reconciles', 128).length > 0,
    paid: work.paid === undefined ? false : work.paid,
  };
  requireProof(typeof fullFlags.paid === 'boolean');
  let flags = fullFlags,
    statusSourceKey = full.key;
  const compact = r[`legacy_work_status/${w}`];
  if (compact !== null) {
    requireProof(
      object(compact) &&
        compact.id === w &&
        compact.project === p &&
        compact.task === k &&
        compact.member === t.address &&
        compact.kind === work.kind &&
        typeof compact.comparison === 'boolean' &&
        typeof compact.paid === 'boolean',
    );
    flags = {
      state: typedText(compact, 'state'),
      pending: typedText(compact, 'pending', true),
      withheld: typedText(compact, 'withheld', true),
      comparison: compact.comparison,
      paid: compact.paid,
    };
    if (full.key === `legacy_work/${w}`)
      requireProof(
        Object.keys(fullFlags).every((key) => fullFlags[key] === flags[key]),
      );
    statusSourceKey = `legacy_work_status/${w}`;
  }
  const project = effective(r, `legacy_project/${p}`, `legacy/project/${p}`),
    task = effective(r, `legacy_task/${k}`, `legacy/task/${k}`),
    actor = effective(r, `legacy_actor/${i}`, `legacy/actor/${i}`),
    instance = r[`instance/${i}`];
  requireProof(
    project.value.id === p &&
      list(project.value, 'work_ids', 128, true).includes(w),
  );
  for (const key of ['claim_ids', 'task_ids', 'participant_ids'])
    list(project.value, key, 128);
  requireProof(
    task.value.id === k &&
      task.value.project === p &&
      list(task.value, 'contributions', 128, true).includes(w),
  );
  list(task.value, 'claim_ids', 128);
  requireProof(
    actor.value.id === i &&
      actor.value.member === t.address &&
      object(instance) &&
      instance.id === i &&
      instance.member === t.address,
  );
  list(actor.value, 'projects', 128);
  // Post-import instances need not appear in the immutable import inventory.
  // Current actor/instance ownership binds the author; inactivity grants nothing.
  if (actor.value.source_state !== undefined)
    typedText(actor.value, 'source_state', true);
  if (instance.state !== undefined) typedText(instance, 'state', true);
  const proof = contextProof(context, t, keysFor(t), pins, clock);
  return answer(
    t,
    {
      id: w,
      projectId: p,
      taskId: k,
      authorInstanceId: i,
      memberAddress: t.address,
      kind: 'work',
      state: flags.state,
      pending: flags.pending,
      withheld: flags.withheld,
      statusSourceKey,
      recordSourceKey: full.key,
    },
    {
      id: k,
      state: typedText(task.value, 'state'),
      kind: typedText(task.value, 'kind'),
      outcome: typedText(task.value, 'outcome', true),
      sourceKey: task.key,
    },
    { id: p, state: typedText(project.value, 'state'), sourceKey: project.key },
    proof,
  );
}

/** One selected holder-bound read using the caller's existing shared adapter.
 * No HTTP discovery, child process, claim graph or native mutation exists here. */
export function createNativeWorkCurrent({
  native,
  now = Date.now,
  timeoutMs = 8000,
} = {}) {
  if (
    typeof now !== 'function' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 8000
  )
    throw new RangeError('Bounded current-work reader configuration required.');
  const cache = new Map(),
    pending = new Map(),
    coldReads = new Map();
  let active = 0;
  const configured = () =>
    native?.configured === true &&
    typeof native.publicState === 'function' &&
    /^[A-Za-z0-9._-]{1,96}$/.test(native.pins?.chainId ?? '') &&
    HASH.test(native.pins?.epoch ?? '') &&
    HASH.test(native.pins?.verifierSha256 ?? '');
  const samePins = (p) =>
    configured() &&
    p.chainId === native.pins.chainId &&
    p.epoch === native.pins.epoch &&
    p.verifierSha256 === native.pins.verifierSha256;
  const deliver = (value, pins, t) =>
    structuredClone(
      samePins(pins) && (!value.proof || fresh(value.proof, now))
        ? value
        : answer(t),
    );
  return Object.freeze({
    async get(actor, query) {
      const t = input(actor, query);
      if (!configured()) return answer(t);
      const pins = {
        chainId: native.pins.chainId,
        epoch: native.pins.epoch,
        verifierSha256: native.pins.verifierSha256,
      };
      const key = JSON.stringify([pins, t.address, t.publicKey, t.binding]),
        saved = cache.get(key),
        clock = now();
      if (
        saved &&
        clock < saved.expires &&
        (!saved.value.proof || fresh(saved.value.proof, now)) &&
        samePins(pins)
      )
        return deliver(saved.value, pins, t);
      cache.delete(key);
      if (pending.has(key))
        return deliver(await pending.get(key).response, pins, t);
      if (active >= 1)
        throw new NativeWorkCurrentError(503, 'current_work_busy');
      for (const [address, bucket] of coldReads)
        if (clock - bucket.start >= 60000) coldReads.delete(address);
      let bucket = coldReads.get(t.address);
      if (!bucket) {
        if (coldReads.size >= 128)
          throw new NativeWorkCurrentError(503, 'current_work_busy');
        bucket = { start: clock, count: 0 };
        coldReads.set(t.address, bucket);
      }
      if (bucket.count >= 6)
        throw new NativeWorkCurrentError(429, 'current_work_rate_limited');
      bucket.count++;
      const duration = Math.min(
          timeoutMs,
          Number.isInteger(native.timeoutMs) && native.timeoutMs > 0
            ? native.timeoutMs
            : 8000,
        ),
        entry = {},
        deadline = Date.now() + duration;
      let timer;
      active++;
      const job = Promise.resolve().then(async () => {
        requireProof(Date.now() < deadline);
        const context = await native.publicState(
          { member: t.address, keys: keysFor(t) },
          { timeoutMs: duration },
        );
        requireProof(Date.now() <= deadline);
        contextProof(context, t, keysFor(t), pins, now);
        return projectView(context, t, pins, now);
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), duration);
      });
      entry.response = Promise.race([job, timeout])
        .catch(() => answer(t))
        .then((value) => {
          if (!samePins(pins) || (value.proof && !fresh(value.proof, now)))
            value = answer(t);
          const expires = value.proof
            ? Math.min(
                now() + 20000,
                Date.parse(value.proof.headerTime) +
                  value.proof.maxAgeSeconds * 1000,
              )
            : now() + 2000;
          cache.set(key, { value, expires });
          while (cache.size > 32) cache.delete(cache.keys().next().value);
          return value;
        })
        .finally(() => clearTimeout(timer));
      pending.set(key, entry);
      // An ignored caller deadline never releases the actual shared-reader job.
      const release = () => {
        active--;
        if (pending.get(key) === entry) pending.delete(key);
      };
      job.then(release, release);
      return deliver(await entry.response, pins, t);
    },
  });
}

// Pure validation reuse only; current reader behavior and response stay unchanged.
export const nativeWorkCurrentValidation = Object.freeze({
  input, keysFor, contextProof, projectView, fresh,
});
