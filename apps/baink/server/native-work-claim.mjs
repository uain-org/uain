import { nativeWorkCurrentValidation as shared } from './native-work-current.mjs';
const { keysFor, contextProof, projectView, fresh } = shared;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATES = new Set(['draft', 'contested', 'rejected', 'believed', 'superseded', 'stale']);
const ACTIONS = new Set(['create', 'edit', 'retract', 'assert']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const requireProof = ok => { if (!ok) throw new Error('Selected claim proof unavailable'); };
const safeID = x => typeof x === 'string' && ID.test(x);
export class NativeWorkClaimError extends Error {
  constructor(status, code) { super('The selected native claim could not be read.'); this.status = status; this.code = code; }
}
function input(actor, query) {
  try { return shared.input(actor, query); }
  catch (error) { if (error?.status === 400) throw new NativeWorkClaimError(400, error.code); throw error; }
}
const NOTICE = 'This is a bounded selected native claim/revision provenance snapshot, not complete history, independent scientific validation, trusted identity, execution eligibility or AI$ payment. A believed retraction is not positive confirmation. Frozen imported history remains separate.';
function answer(t, association = null, claim = null, proof = null) {
  return {status: proof ? 'available' : 'unavailable', scope: 'native-selected-work-claim', complete: false,
    actorAddress: t.address, binding: {...t.binding}, association, claim, proof,
    aiDollarPayment: 'not-established-by-this-record', trust: 'not-evaluated', notice: NOTICE};
}
function association(raw, t) {
  if (raw === null) return null;
  requireProof(object(raw) && raw.contribution === t.binding.workId && safeID(raw.claim) && safeID(raw.revision));
  return {contribution: raw.contribution, claim: raw.claim, revision: raw.revision};
}
function claimView(records, marker, t) {
  const mutable = `legacy_claim/${marker.claim}`, frozen = `legacy/claim/${marker.claim}`;
  const sourceKey = records[mutable] === null ? frozen : mutable, raw = records[sourceKey];
  requireProof(object(raw) && raw.id === marker.claim && raw.project === t.binding.projectId && Array.isArray(raw.revisions) && raw.revisions.length > 0 && raw.revisions.length <= 128);
  const revisions = raw.revisions.map(r => {
    requireProof(object(r) && safeID(r.id) && (r.base === '' || r.base === undefined || safeID(r.base)) && STATES.has(r.state) && ACTIONS.has(r.action));
    const projected = r.id === marker.revision || r.state === 'believed';
    // Go preserves zero-value text/slices in older imported revisions. Only
    // unprojected history may use those values; all raw bodies stay bounded.
    const statement = !projected && (r.statement === undefined || r.statement === null) ? '' : r.statement;
    const sources = !projected && (r.sources === undefined || r.sources === null) ? [] : r.sources;
    requireProof(typeof statement === 'string' && (statement.trim().length > 0 || (!projected && statement === '')) && Buffer.byteLength(statement, 'utf8') <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(statement));
    requireProof(Array.isArray(sources) && sources.length <= 32 && sources.every(safeID) && new Set(sources).size === sources.length);
    requireProof(r.reviews === undefined || r.reviews === null || (Array.isArray(r.reviews) && r.reviews.length <= 32));
    return {id:r.id, base:r.base ?? '', state:r.state, action:r.action, ...(projected ? {statement, sources:[...sources]} : {})};
  });
  const ids = new Set(revisions.map(r => r.id));
  requireProof(ids.size === revisions.length);
  for (const r of revisions) {
    requireProof(!r.base || (ids.has(r.base) && r.base !== r.id));
    const visited = new Set([r.id]); let base = r.base;
    while (base) { requireProof(!visited.has(base)); visited.add(base); base = revisions.find(row => row.id === base)?.base; }
  }
  const associatedRevision = revisions.find(r => r.id === marker.revision), believed = revisions.filter(r => r.state === 'believed');
  requireProof(associatedRevision && associatedRevision.sources.includes(t.binding.workId) && believed.length <= 1);
  return {id:raw.id,projectId:raw.project,sourceKey,associationSourceKey:`legacy_answer_claim/${t.binding.workId}`,
    associatedRevisionId:marker.revision,associatedRevision,believedRevision:believed[0] ?? null};
}
/** Holder-bound read only. The actual shared native adapter limits all consumers;
 * this consumer independently retains one actual job across both proof phases. */
export function createNativeWorkClaim({
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
    throw new RangeError('Bounded claim reader configuration required.');
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
        throw new NativeWorkClaimError(503, 'claim_read_busy');
      for (const [address, bucket] of coldReads)
        if (clock - bucket.start >= 60000) coldReads.delete(address);
      let bucket = coldReads.get(t.address);
      if (!bucket) {
        if (coldReads.size >= 128)
          throw new NativeWorkClaimError(503, 'claim_read_busy');
        bucket = { start: clock, count: 0 };
        coldReads.set(t.address, bucket);
      }
      if (bucket.count >= 6)
        throw new NativeWorkClaimError(429, 'claim_read_rate_limited');
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
        const associationKey = `legacy_answer_claim/${t.binding.workId}`;
        const firstKeys = [...keysFor(t), associationKey];
        const context = await native.publicState(
          { member: t.address, keys: firstKeys },
          { timeoutMs: Math.max(1, deadline - Date.now()) },
        );
        requireProof(Date.now() <= deadline && samePins(pins));
        const firstProof = contextProof(context, t, firstKeys, pins, now);
        projectView(context, t, pins, now);
        const marker = association(context.state.records[associationKey], t);
        if (marker === null) return answer(t, 'absent', null, firstProof);
        const finalKeys = [...firstKeys, `legacy_claim/${marker.claim}`, `legacy/claim/${marker.claim}`];
        requireProof(Date.now() < deadline);
        const final = await native.publicState(
          { member: t.address, keys: finalKeys },
          { timeoutMs: Math.max(1, deadline - Date.now()) },
        );
        requireProof(Date.now() <= deadline && samePins(pins));
        const proof = contextProof(final, t, finalKeys, pins, now);
        projectView(final, t, pins, now);
        const current = association(final.state.records[associationKey], t);
        requireProof(current !== null && JSON.stringify(current) === JSON.stringify(marker));
        return answer(t, 'present', claimView(final.state.records, current, t), proof);
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
