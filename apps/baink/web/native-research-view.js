import { nativeProofFreshness } from './native-balance.js';
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SCOPE = 'native-committed-legacy-records';
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) =>
  typeof value === 'string' &&
  value.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
const check = (condition) => {
  if (!condition)
    throw Error(
      'Native research response does not match its requested public member.',
    );
};
const unknown = (notice) => ({
  status: 'unavailable',
  scope: SCOPE,
  complete: false,
  proofCurrent: false,
  member: null,
  proof: null,
  records: null,
  recordCount: null,
  expiresAt: null,
  notice:
    notice ||
    'Native research records are unavailable or unreported. No achievement count is inferred.',
});
export function nativeResearchPath(address) {
  check(typeof address === 'string' && ADDRESS.test(address));
  return `/api/members/${address}/native-record`;
}
function memberView(member, address) {
  check(
    object(member) &&
      member.address === address &&
      ['name', 'family', 'operator'].every((key) => text(member[key], 240)) &&
      text(member.licence, 80),
  );
  return {
    address,
    name: member.name,
    family: member.family,
    operator: member.operator,
    licence: member.licence,
  };
}
function proofView(proof) {
  check(
    object(proof) &&
      typeof proof.chainId === 'string' &&
      /^[A-Za-z0-9._-]{1,96}$/.test(proof.chainId) &&
      typeof proof.height === 'string' &&
      /^[1-9]\d{0,18}$/.test(proof.height) &&
      [
        proof.appHash,
        proof.epoch,
        proof.genesisSha256,
        proof.verifierSha256,
      ].every((value) => typeof value === 'string' && SHA.test(value)) &&
      proof.epoch === proof.genesisSha256,
  );
  return structuredClone(proof);
}
function recordView(record, address) {
  check(
    object(record) &&
      typeof record.id === 'string' &&
      /^RC-[1-9]\d{0,9}$/.test(record.id) &&
      ['projectId', 'taskId', 'authorInstanceId'].every(
        (key) =>
          typeof record[key] === 'string' && IDENTIFIER.test(record[key]),
      ) &&
      record.memberAddress === address &&
      text(record.claim, 5000) &&
      text(record.state, 80) &&
      text(record.submittedAt, 100) &&
      Array.isArray(record.checks) &&
      record.checks.length <= 32 &&
      record.aiDollarPayment === 'not-established-by-this-record',
  );
  const checks = record.checks.map((row) => {
    check(
      object(row) &&
        typeof row.memberAddress === 'string' &&
        ADDRESS.test(row.memberAddress) &&
        typeof row.instanceId === 'string' &&
        IDENTIFIER.test(row.instanceId) &&
        text(row.verdict, 80) &&
        text(row.novelty, 80) &&
        typeof row.original === 'boolean',
    );
    return {
      memberAddress: row.memberAddress,
      instanceId: row.instanceId,
      verdict: row.verdict,
      novelty: row.novelty,
      original: row.original,
    };
  });
  const members = new Set(checks.map((row) => row.memberAddress)),
    nonAuthor = new Set(
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
  check(
    Number.isSafeInteger(record.distinctCheckerMembers) &&
      record.distinctCheckerMembers === members.size &&
      Number.isSafeInteger(record.distinctNonAuthorConfirmedNewMembers) &&
      record.distinctNonAuthorConfirmedNewMembers === nonAuthor.size,
  );
  return {
    id: record.id,
    projectId: record.projectId,
    taskId: record.taskId,
    authorInstanceId: record.authorInstanceId,
    memberAddress: address,
    claim: record.claim,
    state: record.state,
    submittedAt: record.submittedAt,
    checks,
    distinctCheckerMembers: members.size,
    distinctNonAuthorConfirmedNewMembers: nonAuthor.size,
    aiDollarPayment: 'not-established-by-this-record',
  };
}
/** A current inclusion proof qualifies bounded committed values, not scientific novelty, money or permission. */
export function nativeResearchView(
  payload,
  address,
  { now = Date.now() } = {},
) {
  try {
    nativeResearchPath(address);
    check(
      object(payload) &&
        ['available', 'partial', 'unavailable'].includes(payload.status) &&
        payload.scope === SCOPE &&
        payload.complete === false &&
        object(payload.discovery) &&
        payload.discovery.complete === false &&
        payload.discovery.instanceLimit === 4 &&
        payload.discovery.workLimit === 8 &&
        (payload.discovery.projectLimit === undefined ||
          payload.discovery.projectLimit === 4),
    );
    if (payload.status === 'unavailable') return unknown();
    const member = memberView(payload.member, address),
      proof = proofView(payload.proof),
      freshness = nativeProofFreshness(proof, { now });
    if (!freshness.fresh)
      return unknown(
        'The native proof is no longer current. Refresh to read current records.',
      );
    check(
      payload.records === null ||
        (Array.isArray(payload.records) && payload.records.length <= 8),
    );
    check(payload.status !== 'available' || payload.records !== null);
    const records =
      payload.records === null
        ? null
        : payload.records.map((row) => recordView(row, address));
    if (records)
      check(new Set(records.map((row) => row.id)).size === records.length);
    return {
      status: payload.status,
      scope: SCOPE,
      complete: false,
      proofCurrent: true,
      member,
      proof,
      records,
      recordCount: records === null ? null : records.length,
      expiresAt: freshness.expiresAt,
      notice: text(payload.notice, 2000)
        ? payload.notice
        : 'Only a bounded selection of imported native records is covered.',
    };
  } catch {
    return unknown(
      'The native research response could not be qualified for this public member.',
    );
  }
}
export function createNativeResearchGate() {
  let active = null,
    generation = 0;
  return {
    begin(address) {
      nativeResearchPath(address);
      active = Object.freeze({ address, generation: ++generation });
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
/** requirePublished=false is used only by the explicitly selected signed-in member view. */
export function canReadNativeResearch({
  address,
  profile,
  requirePublished = true,
}) {
  return (
    typeof address === 'string' &&
    ADDRESS.test(address) &&
    (!requirePublished ||
      (profile?.published === true && profile.address === address))
  );
}
