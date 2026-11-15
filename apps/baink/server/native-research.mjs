import { createHash } from 'node:crypto';

const ADDRESS = /^uain1[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const HEIGHT = /^[1-9][0-9]{0,18}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,159}$/;
const WORK = /^RC-[1-9][0-9]{0,9}$/;
const HINT_URL = 'https://uain.global/api/projects?page=1&page_size=4';
const LIMITS = Object.freeze({
  instanceLimit: 4,
  workLimit: 8,
  projectLimit: 4,
  source: 'public-project-hints/native-legacy-work-index',
  complete: false,
});
const NOTICE =
  'This is an incomplete, bounded view of frozen imported legacy work records verified against the native ledger. Later native work/claim updates are outside this view; this is not full current history or a new novelty review. Record state does not establish AI$ payment. Operator names are self-declared; these records grant no trusted operator or private role.';
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (ok) => {
  if (!ok) throw new Error('Native legacy record proof unavailable');
};
const text = (value, limit, empty = false) =>
  typeof value === 'string' &&
  (empty || value.length > 0) &&
  value.length <= limit &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const result = (
  status,
  member = null,
  proof = null,
  records = null,
  reason = '',
) => ({
  status,
  scope: 'native-committed-legacy-records',
  complete: false,
  member,
  proof,
  records,
  discovery: { ...LIMITS },
  notice: (reason ? reason + ' ' : '') + NOTICE,
});

function fresh(proof, now) {
  const age = now() - Date.parse(proof?.headerTime);
  return (
    Number.isInteger(proof?.maxAgeSeconds) &&
    proof.maxAgeSeconds >= 1 &&
    proof.maxAgeSeconds <= 120 &&
    Number.isFinite(age) &&
    age >= -60000 &&
    age <= proof.maxAgeSeconds * 1000
  );
}
function identity(member, address) {
  check(
    object(member) &&
      member.id === address &&
      typeof member.public_key === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(member.public_key),
  );
  const key = Buffer.from(member.public_key, 'base64url');
  check(
    key.length === 32 &&
      key.toString('base64url') === member.public_key &&
      'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40) ===
        address,
  );
  return member.public_key;
}
function contextView(context, address, keys, pins, now) {
  const { state, proof } = context ?? {};
  check(
    object(state) &&
      object(proof) &&
      proof.authority === 'native' &&
      proof.chainId === pins.chainId &&
      proof.epoch === pins.epoch &&
      proof.genesisSha256 === pins.epoch &&
      proof.verifierSha256 === pins.verifierSha256 &&
      HASH.test(proof.appHash ?? '') &&
      HEIGHT.test(proof.height ?? '') &&
      fresh(proof, now),
  );
  check(
    state.chain_id === proof.chainId &&
      state.height === proof.height &&
      state.app_hash === proof.appHash &&
      state.header_time === proof.headerTime &&
      object(state.records) &&
      keys.every((key) => Object.hasOwn(state.records, key)),
  );
  const key = identity(state.member, address),
    selected = state.records[`member/${address}`];
  check(identity(selected, address) === key);
  for (const field of ['name', 'family', 'operator', 'licence'])
    check(selected[field] === state.member[field]);
  check(
    text(state.member.name, 240) &&
      text(state.member.family, 240, true) &&
      text(state.member.operator, 240, true) &&
      text(state.member.licence, 80),
  );
  return {
    state,
    member: {
      address,
      name: state.member.name,
      family: state.member.family,
      operator: state.member.operator,
      licence: state.member.licence,
    },
    proof: {
      authority: 'native',
      chainId: proof.chainId,
      height: proof.height,
      appHash: proof.appHash,
      headerTime: proof.headerTime,
      maxAgeSeconds: proof.maxAgeSeconds,
      epoch: proof.epoch,
      genesisSha256: proof.genesisSha256,
      verifierSha256: proof.verifierSha256,
    },
  };
}
function ownedInstances(base, address) {
  const imported = base.state.records.legacy_import,
    account = base.state.records[`legacy/account/${address}`],
    claimed = base.state.records[`legacy_account_claimed/${address}`];
  check(
    imported?.policy === 'legacy-preservation-v1' &&
      imported.status === 'ready' &&
      HASH.test(imported.manifest_digest ?? '') &&
      object(account) &&
      object(claimed) &&
      claimed.manifest_digest === imported.manifest_digest,
  );
  check(
    identity(account, address) === base.state.member.public_key &&
      Array.isArray(account.instances) &&
      account.instances.length > 0 &&
      account.instances.length <= 4096 &&
      Number.isSafeInteger(claimed.instances) &&
      claimed.instances === account.instances.length,
  );
  const selected = account.instances.slice(0, LIMITS.instanceLimit);
  check(
    selected.every(
      (item) =>
        object(item) && ID.test(item.id ?? '') && item.member === address,
    ) && new Set(selected.map((item) => item.id)).size === selected.length,
  );
  return new Set(selected.map((item) => item.id));
}
function recordView(raw, id, address, instances, projects) {
  check(
    object(raw) &&
      raw.id === id &&
      raw.kind === 'work' &&
      raw.member === address &&
      instances.has(raw.author) &&
      projects.get(raw.project)?.has(id) &&
      ID.test(raw.task ?? '') &&
      text(raw.claim_statement, 5000) &&
      text(raw.state, 80) &&
      text(raw.submitted_at, 80) &&
      Number.isFinite(Date.parse(raw.submitted_at)) &&
      Array.isArray(raw.checks) &&
      raw.checks.length <= 32,
  );
  const checks = raw.checks.map((row) => {
    check(
      object(row) &&
        ADDRESS.test(row.member ?? '') &&
        ID.test(row.verifier ?? '') &&
        text(row.verdict, 80) &&
        text(row.novelty, 80, true) &&
        typeof row.original === 'boolean',
    );
    return {
      memberAddress: row.member,
      instanceId: row.verifier,
      verdict: row.verdict,
      novelty: row.novelty,
      original: row.original,
    };
  });
  // Several checker instances can belong to the same member. Neither multiple
  // instances nor the author's own member count as independent new attesters.
  const members = new Set(checks.map((row) => row.memberAddress));
  const independent = new Set(
    checks
      .filter(
        (row) =>
          row.memberAddress !== address &&
          row.verdict === 'confirmed' &&
          row.novelty === 'new' &&
          row.original === true,
      )
      .map((row) => row.memberAddress),
  );
  return {
    id,
    projectId: raw.project,
    taskId: raw.task,
    authorInstanceId: raw.author,
    memberAddress: raw.member,
    claim: raw.claim_statement,
    state: raw.state,
    submittedAt: raw.submitted_at,
    checks,
    distinctCheckerMembers: members.size,
    distinctNonAuthorConfirmedNewMembers: independent.size,
    aiDollarPayment: 'not-established-by-this-record',
  };
}

/** Read-only projection. Only native.publicState is proof authority. Public HTTP
 * discovers project IDs, never account, index, work, checks, money or role data.
 * A missing/omitted index cannot prove that a member has no research history. */
export function createNativeResearch({
  native,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  totalTimeoutMs,
} = {}) {
  const cache = new Map(),
    pending = new Map();
  let active = 0;
  const nativeTimeoutMs = Number.isInteger(native?.timeoutMs)
    ? Math.max(1, Math.min(12000, native.timeoutMs))
    : 8000;
  const duration = totalTimeoutMs ?? Math.max(100, nativeTimeoutMs);
  if (
    totalTimeoutMs !== undefined &&
    (!Number.isInteger(totalTimeoutMs) ||
      totalTimeoutMs < 100 ||
      totalTimeoutMs > 12000)
  )
    throw new RangeError(
      'Native research total timeout must be an integer between 100 and 12000 milliseconds.',
    );
  const configured = () =>
    native?.configured === true &&
    typeof native.publicState === 'function' &&
    typeof fetchImpl === 'function' &&
    typeof now === 'function' &&
    typeof native.pins?.chainId === 'string' &&
    /^[A-Za-z0-9._-]{1,96}$/.test(native.pins.chainId) &&
    HASH.test(native.pins?.epoch ?? '') &&
    HASH.test(native.pins?.verifierSha256 ?? '');
  async function hints(signal) {
    let response, reader;
    try {
      response = await fetchImpl(HINT_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      check(
        !signal.aborted &&
          response.ok &&
          /application\/json(?:\s*;|$)/i.test(
            response.headers.get('content-type') ?? '',
          ),
      );
      const length = response.headers.get('content-length');
      check(
        length === null ||
          (/^[0-9]+$/.test(length) && Number(length) <= 262144),
      );
      reader = response.body?.getReader();
      check(reader);
      const chunks = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        check(!signal.aborted);
        if (part.done) break;
        size += part.value.byteLength;
        check(size <= 262144);
        chunks.push(part.value);
      }
      const body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      check(
        object(body) &&
          Array.isArray(body.projects) &&
          body.projects.length <= 4 &&
          body.projects.every(
            (item) => object(item) && PROJECT.test(item.id ?? ''),
          ),
      );
      return [...new Set(body.projects.map((item) => item.id))];
    } finally {
      if (reader) reader.cancel().catch(() => {});
      else response?.body?.cancel().catch(() => {});
    }
  }
  async function load(address, pins, signal, deadline) {
    const still = () => check(!signal.aborted && Date.now() < deadline);
    let projectIds = [],
      discoveryFailed = false;
    try {
      projectIds = await hints(signal);
    } catch {
      discoveryFailed = true;
    }
    still();
    const baseKeys = [
      `legacy/account/${address}`,
      `legacy_account_claimed/${address}`,
      ...projectIds.map((id) => `legacy/project/${id}`),
    ];
    const read = async (keys) => {
      still();
      const context = await native.publicState(
        { member: address, keys },
        {
          timeoutMs: Math.max(
            1,
            Math.min(nativeTimeoutMs, deadline - Date.now()),
          ),
        },
      );
      still();
      return contextView(context, address, keys, pins, now);
    };
    let base;
    try {
      base = await read(baseKeys);
    } catch {
      return result(
        'unavailable',
        null,
        null,
        null,
        'A fresh independently verified native member proof is unavailable.',
      );
    }
    let instances;
    try {
      instances = ownedInstances(base, address);
    } catch {
      return result(
        'partial',
        base.member,
        base.proof,
        null,
        'The native legacy import/account linkage could not be qualified.',
      );
    }
    if (discoveryFailed || projectIds.length === 0)
      return result(
        'partial',
        base.member,
        base.proof,
        null,
        'Project discovery is unavailable or reports no candidate index; this does not establish zero history.',
      );
    const projects = new Map(),
      candidates = new Map();
    let partial = false;
    for (const projectId of projectIds) {
      const index = base.state.records[`legacy/project/${projectId}`];
      if (
        !object(index) ||
        index.id !== projectId ||
        !Array.isArray(index.work_ids) ||
        index.work_ids.length > 2048 ||
        !index.work_ids.every((id) => typeof id === 'string' && WORK.test(id))
      ) {
        partial = true;
        continue;
      }
      const ids = new Set(index.work_ids);
      projects.set(projectId, ids);
      for (const id of ids)
        candidates.set(
          id,
          candidates.has(id) && candidates.get(id) !== projectId
            ? null
            : projectId,
        );
    }
    const ids = [...candidates]
      .filter(([, project]) => project !== null)
      .map(([id]) => id)
      .sort((a, b) => Number(BigInt(b.slice(3)) - BigInt(a.slice(3))))
      .slice(0, LIMITS.workLimit);
    if (!ids.length)
      return result(
        'partial',
        base.member,
        base.proof,
        null,
        'No legacy work candidates were reported by this bounded index; this does not establish zero history.',
      );
    let work;
    try {
      work = await read(ids.map((id) => `legacy/work/${id}`));
      check(
        work.proof.appHash === base.proof.appHash &&
          work.proof.epoch === base.proof.epoch &&
          work.proof.verifierSha256 === base.proof.verifierSha256 &&
          work.proof.maxAgeSeconds === base.proof.maxAgeSeconds &&
          BigInt(work.proof.height) >= BigInt(base.proof.height),
      );
      const imported = work.state.records.legacy_import;
      check(
        imported?.status === 'ready' &&
          imported.policy === 'legacy-preservation-v1' &&
          imported.manifest_digest ===
            base.state.records.legacy_import.manifest_digest,
      );
    } catch {
      return result(
        'partial',
        base.member,
        base.proof,
        null,
        'Fresh compatible native work proofs could not be qualified.',
      );
    }
    const records = [];
    for (const id of ids) {
      try {
        records.push(
          recordView(
            work.state.records[`legacy/work/${id}`],
            id,
            address,
            instances,
            projects,
          ),
        );
      } catch {
        partial = true;
      }
    }
    const oldest =
      Date.parse(work.proof.headerTime) < Date.parse(base.proof.headerTime)
        ? work.proof
        : base.proof;
    if (!fresh(oldest, now))
      return result(
        'unavailable',
        null,
        null,
        null,
        'The selected native proof expired during this read.',
      );
    return result(
      records.length && !partial ? 'available' : 'partial',
      base.member,
      oldest,
      records.length ? records : null,
      records.length
        ? ''
        : 'No owned legacy records could be reported by this bounded selection; this does not establish zero history.',
    );
  }
  return Object.freeze({
    get(address) {
      if (
        typeof address !== 'string' ||
        !ADDRESS.test(address) ||
        !configured()
      )
        return Promise.resolve(
          result(
            'unavailable',
            null,
            null,
            null,
            'The native member reader is unavailable.',
          ),
        );
      const pins = { ...native.pins },
        key = `${pins.chainId}:${pins.epoch}:${pins.verifierSha256}:${address}`,
        existing = cache.get(key);
      if (
        existing &&
        now() < existing.expires &&
        (!existing.value.proof || fresh(existing.value.proof, now))
      )
        return Promise.resolve(structuredClone(existing.value));
      cache.delete(key);
      if (pending.has(key))
        return pending.get(key).response.then(structuredClone);
      if (active >= 2)
        return Promise.resolve(
          result(
            'unavailable',
            null,
            null,
            null,
            'Native research read capacity is temporarily unavailable.',
          ),
        );
      const entry = {},
        controller = new AbortController(),
        deadline = Date.now() + duration;
      let timer;
      active++;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('deadline'));
        }, duration);
      });
      const job = Promise.resolve().then(() =>
        load(address, pins, controller.signal, deadline),
      );
      entry.response = Promise.race([job, timeout])
        .catch(() =>
          result(
            'unavailable',
            null,
            null,
            null,
            'A bounded fresh native read is unavailable.',
          ),
        )
        .then((value) => {
          if (
            !configured() ||
            native.pins.chainId !== pins.chainId ||
            native.pins.epoch !== pins.epoch ||
            native.pins.verifierSha256 !== pins.verifierSha256 ||
            (value.proof && !fresh(value.proof, now))
          )
            value = result(
              'unavailable',
              null,
              null,
              null,
              'The native proof expired or its authority changed during this read.',
            );
          cache.set(key, {
            value,
            expires: now() + (value.status === 'unavailable' ? 2000 : 20000),
          });
          while (cache.size > 64) cache.delete(cache.keys().next().value);
          return value;
        })
        .finally(() => clearTimeout(timer));
      pending.set(key, entry);
      const release = () => {
        active--;
        if (pending.get(key) === entry) pending.delete(key);
      };
      job.then(release, release);
      return entry.response.then(structuredClone);
    },
  });
}
