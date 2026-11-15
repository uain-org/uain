import { createHash } from 'node:crypto';

const ADDRESS = /^uain1[a-f0-9]{40}$/,
  HASH = /^[a-f0-9]{64}$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,159}$/,
  INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
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
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const MAX_MAPPING_BYTES = 512 * 1024;
const invalidMapping = () => {
  throw new Error('Invalid native project lead configuration.');
};
/** Operator input only. A tuple restricts an existing Viewer grant; it grants nothing. */
export function validateNativeProjectLeads(raw = {}) {
  try {
    if (
      !object(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Object.keys(raw).length > 1000 ||
      Buffer.byteLength(JSON.stringify(raw)) > MAX_MAPPING_BYTES
    ) invalidMapping();
    const mappings = new Map();
    for (const [projectId, tuple] of Object.entries(raw)) {
      if (
        !PROJECT.test(projectId) ||
        !object(tuple) ||
        Object.keys(tuple).length !== 2 ||
        !Object.hasOwn(tuple, 'instanceId') ||
        !Object.hasOwn(tuple, 'memberAddress') ||
        typeof tuple.instanceId !== 'string' ||
        !INSTANCE.test(tuple.instanceId) ||
        typeof tuple.memberAddress !== 'string' ||
        !ADDRESS.test(tuple.memberAddress)
      ) invalidMapping();
      mappings.set(projectId, Object.freeze({
        instanceId: tuple.instanceId,
        memberAddress: tuple.memberAddress,
      }));
    }
    return mappings;
  } catch {
    return invalidMapping();
  }
}
export function nativeProjectLeadsFromEnv(env = {}) {
  const value = env.BAINK_PAPERCLIP_NATIVE_LEADS_JSON;
  if (value === undefined) return {};
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_MAPPING_BYTES)
      invalidMapping();
    return Object.fromEntries(validateNativeProjectLeads(JSON.parse(value)));
  } catch {
    return invalidMapping();
  }
}
const answer = (reason, proof = null) => ({
  allowed: reason === 'verified-current-lead',
  reason,
  proof,
});
const unavailable = () => answer('proof-unavailable');
const valid = (ok) => {
  if (!ok) throw new Error('Native project read proof unavailable');
};
const addressOf = (bytes) =>
  'uain1' + createHash('sha256').update(bytes).digest('hex').slice(0, 40);
function fresh(p, now) {
  const age = now() - Date.parse(p?.headerTime);
  return (
    Number.isInteger(p?.maxAgeSeconds) &&
    p.maxAgeSeconds >= 1 &&
    p.maxAgeSeconds <= 120 &&
    Number.isFinite(age) &&
    age >= -60000 &&
    age <= p.maxAgeSeconds * 1000
  );
}
function inputOf(input) {
  const { projectId, expectedInstanceId, expectedMember, actor } = input ?? {};
  if (
    typeof projectId !== 'string' ||
    typeof expectedInstanceId !== 'string' ||
    typeof expectedMember !== 'string' ||
    !PROJECT.test(projectId) ||
    !INSTANCE.test(expectedInstanceId) ||
    !ADDRESS.test(expectedMember) ||
    actor?.address !== expectedMember ||
    typeof actor.publicKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(actor.publicKey)
  )
    return null;
  const bytes = Buffer.from(actor.publicKey, 'base64');
  if (
    bytes.length !== 32 ||
    bytes.toString('base64') !== actor.publicKey ||
    addressOf(bytes) !== expectedMember
  )
    return null;
  return {
    projectId,
    expectedInstanceId,
    expectedMember,
    publicKey: actor.publicKey,
    nativeKey: bytes.toString('base64url'),
  };
}
function proofOf(context, tuple, keys, pins, now) {
  const { state: s, proof: p } = context ?? {},
    r = s?.records;
  valid(
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
      fresh(p, now),
  );
  valid(
    s.chain_id === p.chainId &&
      s.height === p.height &&
      s.app_hash === p.appHash &&
      s.header_time === p.headerTime &&
      [...keys, 'legacy_import', `member/${tuple.expectedMember}`].every(
        (key) => Object.hasOwn(r, key),
      ),
  );
  const member = s.member,
    selected = r[`member/${tuple.expectedMember}`];
  valid(
    object(member) &&
      object(selected) &&
      member.id === tuple.expectedMember &&
      member.public_key === tuple.nativeKey &&
      [
        'id',
        'public_key',
        'licence',
        'name',
        'family',
        'operator',
        'sequence',
      ].every((field) => member[field] === selected[field]),
  );
  return Object.fromEntries(PROOF.map((field) => [field, p[field]]));
}
function currentLead(context, t) {
  const r = context.state.records,
    p =
      r[`legacy_project/${t.projectId}`] === null
        ? r[`legacy/project/${t.projectId}`]
        : r[`legacy_project/${t.projectId}`],
    instance = r[`instance/${t.expectedInstanceId}`],
    actor =
      r[`legacy_actor/${t.expectedInstanceId}`] === null
        ? r[`legacy/actor/${t.expectedInstanceId}`]
        : r[`legacy_actor/${t.expectedInstanceId}`],
    account = r[`legacy/account/${t.expectedMember}`],
    claimed = r[`legacy_account_claimed/${t.expectedMember}`],
    imported = r.legacy_import;
  return (
    r[`project/${t.projectId}`] === null &&
    context.state.member.licence === 'active' &&
    object(p) &&
    p.id === t.projectId &&
    p.lead === t.expectedInstanceId &&
    ['active', 'verifying'].includes(p.state) &&
    ['work_ids', 'claim_ids', 'task_ids', 'participant_ids'].every(
      (key) =>
        p[key] == null || (Array.isArray(p[key]) && p[key].length <= 128),
    ) &&
    object(instance) &&
    instance.id === t.expectedInstanceId &&
    instance.member === t.expectedMember &&
    instance.state === 'active' &&
    (instance.account_policy ?? '') === '' &&
    object(actor) &&
    actor.id === t.expectedInstanceId &&
    actor.member === t.expectedMember &&
    actor.source_state === 'active' &&
    Array.isArray(actor.projects) &&
    actor.projects.length <= 128 &&
    actor.projects.includes(t.projectId) &&
    imported?.policy === 'legacy-preservation-v1' &&
    imported.status === 'ready' &&
    HASH.test(imported.manifest_digest ?? '') &&
    object(claimed) &&
    claimed.manifest_digest === imported.manifest_digest &&
    object(account) &&
    account.id === t.expectedMember &&
    account.public_key === t.nativeKey &&
    Array.isArray(account.instances) &&
    account.instances.length <= 4096 &&
    Number.isSafeInteger(claimed.instances) &&
    claimed.instances === account.instances.length &&
    account.instances.some(
      (i) =>
        object(i) &&
        i.id === t.expectedInstanceId &&
        i.member === t.expectedMember,
    )
  );
}

/** Preparatory operator policy for private MIRROR READ only. The caller must
 * first authenticate its actor, apply its explicit project Viewer allowlist and
 * supply the trusted configured tuple. Effective project/actor precedence follows
 * legacy_research.go legacyProject/legacyActor: mutable overlay, then imported
 * capsule only on proven absence. Instance state comes from instance/<id>.
 * Compact-instance metadata policies require separate qualification and deny.
 * New-format project collisions are deliberately outside this legacy-only policy.
 * This proves current native links, not operator verification,
 * holder consent, role delegation, command rights, spending or fund allocation.
 * No grant, network fetch or native mutation exists in this module. */
export function createNativeProjectAccess({ native, now = Date.now } = {}) {
  const cache = new Map(),
    pending = new Map();
  let active = 0;
  const duration = Number.isInteger(native?.timeoutMs)
    ? Math.max(1, Math.min(8000, native.timeoutMs))
    : 8000;
  const configured = () =>
    native?.configured === true &&
    typeof native.publicState === 'function' &&
    typeof now === 'function' &&
    /^[A-Za-z0-9._-]{1,96}$/.test(native.pins?.chainId ?? '') &&
    HASH.test(native.pins?.epoch ?? '') &&
    HASH.test(native.pins?.verifierSha256 ?? '');
  const samePins = (p) =>
    configured() &&
    native.pins.chainId === p.chainId &&
    native.pins.epoch === p.epoch &&
    native.pins.verifierSha256 === p.verifierSha256;
  return Object.freeze({
    check(input) {
      const t = inputOf(input);
      if (!t) return Promise.resolve(answer('not-authorized'));
      if (!configured()) return Promise.resolve(unavailable());
      const pins = { ...native.pins },
        key = JSON.stringify([
          pins.chainId,
          pins.epoch,
          pins.verifierSha256,
          t.projectId,
          t.expectedInstanceId,
          t.expectedMember,
          t.publicKey,
        ]),
        cached = cache.get(key);
      if (
        cached &&
        now() < cached.expires &&
        (!cached.value.proof || fresh(cached.value.proof, now))
      )
        return Promise.resolve(structuredClone(cached.value));
      cache.delete(key);
      if (pending.has(key))
        return pending.get(key).response.then(structuredClone);
      if (active >= 2) return Promise.resolve(unavailable());
      const keys = [
          `legacy_project/${t.projectId}`,
          `legacy/project/${t.projectId}`,
          `project/${t.projectId}`,
          `instance/${t.expectedInstanceId}`,
          `legacy_actor/${t.expectedInstanceId}`,
          `legacy/actor/${t.expectedInstanceId}`,
          `legacy/account/${t.expectedMember}`,
          `legacy_account_claimed/${t.expectedMember}`,
        ],
        entry = {},
        deadline = Date.now() + duration;
      let timer;
      active++;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), duration);
      });
      const job = Promise.resolve().then(async () => {
        valid(Date.now() < deadline);
        const context = await native.publicState(
          { member: t.expectedMember, keys },
          { timeoutMs: Math.max(1, Math.min(duration, deadline - Date.now())) },
        );
        valid(Date.now() < deadline);
        const proof = proofOf(context, t, keys, pins, now);
        return answer(
          currentLead(context, t) ? 'verified-current-lead' : 'not-authorized',
          proof,
        );
      });
      entry.response = Promise.race([job, timeout])
        .catch(unavailable)
        .then((value) => {
          if (!samePins(pins) || (value.proof && !fresh(value.proof, now)))
            value = unavailable();
          cache.set(key, {
            value,
            expires: now() + (value.proof ? 20000 : 2000),
          });
          while (cache.size > 64) cache.delete(cache.keys().next().value);
          return value;
        })
        .finally(() => clearTimeout(timer));
      pending.set(key, entry);
      // Caller deadline does not release actual work that ignores cancellation.
      const release = () => {
        active--;
        if (pending.get(key) === entry) pending.delete(key);
      };
      job.then(release, release);
      return entry.response.then(structuredClone);
    },
  });
}
