/** Read-only native reader for the project-organization adapters (`native.mjs`, `status.mjs`,
 * `pricing.mjs`). It adds no authority of its own: every value comes from the injected
 * transport, which in production is BAINK's pinned reader
 * (`createNativeAssetAdapter(...)` from `apps/baink/server/native-asset.mjs`, whose
 * `publicState(selection, {timeoutMs})` runs the pinned `uain-state` verifier and checks the
 * genesis/verifier pins and proof freshness). Tests inject a fake with the same shape.
 *
 * Transport contract:
 * - `publicState({member?, keys?, receipt?}, {timeoutMs})` -> `{state, proof?}` where `state`
 *   is the gateway snapshot (`chain_id`, `height`, `header_time`, `app_hash`, `signed_header`,
 *   `event_count`, `member`, `records`, `receipt?`) and every selected key is present in
 *   `records` (`null` = proven absence). At most 32 keys per call; this reader chunks.
 * - `broadcast(envelope, {timeoutMs})` -> integer code or `{code}`; or BAINK's
 *   `broadcastCentral` (which only accepts `central_submit` / `project_join`).
 * - Optional injected `broadcaster` (`createOperatorBroadcast(...)` from `broadcast.mjs`),
 *   used in preference to the transport's own broadcast for the fleet operations. Only its
 *   definite first-send CheckTx refusal is relayed as `definite` (with its `rejection`
 *   evidence); a transport's own broadcast never is, because it does not track first sends. And an
 *   optional `reviewSource` (`createReviewSource(...)` from `review-source.mjs`) whose
 *   `executionIds(submissionId)` supplies the review candidates.
 *
 * Finality is never fabricated: a proof is `finalized` only when the transport supplied
 * `finalized: true`, or the committed `app_hash` together with its `signed_header`. This
 * reader relays that evidence; it does not verify the header signatures itself (the
 * pinned verifier behind the transport does).
 *
 * Native has no per-project task index and no review index (chain/federation/
 * central_earning.go): tasks are found through the global `central_task_count` /
 * `central_task_index/<n>` entries, and reviews (`central_review/<sub>/<sha256(execution)>`)
 * only from candidate execution IDs supplied by `reviewExecutionIds(submissionId)`, checked
 * for completeness against the `central_review` events in the event log. */
import { ADDRESS, HASH, NATIVE_ID, need, plain, refuse, sha256 } from './common.mjs';
import { SUPPLY_CAP_UNITS } from './pricing.mjs';

const CHAIN = /^[A-Za-z0-9._-]{1,96}$/;
const KEY = /^[A-Za-z0-9_./:-]{1,512}$/;
const HEIGHT = /^[1-9][0-9]{0,18}$/;
const UINT = /^(0|[1-9][0-9]{0,19})$/;
const APP_HASH = /^[A-Fa-f0-9]{64}$/;
const COIN = /^(0|[1-9][0-9]{0,20})$/;
const KEYS_PER_CALL = 32;
const MAX_KEYS_PER_READ = 512;
const pad = (n) => String(n).padStart(20, '0');
const codeOf = (e) => (typeof e?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(e.code) ? e.code : null);

export function createNativeReader({
  transport, chainId, productionChainId, timeoutMs = 8000, now = () => Date.now(), retries = 2,
  startEvent = '0', maxEventsPerScan = 512, maxIndexedEvents = 250000, maxTaskIndex = 10000,
  reviewExecutionIds = null, allowProductionBroadcast = false, broadcaster = null, reviewSource = null,
} = {}) {
  need(transport && typeof transport.publicState === 'function', 'invalid_native_reader_configuration', 'transport.publicState required');
  need(typeof chainId === 'string' && CHAIN.test(chainId), 'invalid_native_reader_configuration', 'chainId');
  need(typeof productionChainId === 'string' && CHAIN.test(productionChainId), 'invalid_native_reader_configuration', 'productionChainId');
  need(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000 && Number.isInteger(retries) && retries >= 0 && retries <= 4,
    'invalid_native_reader_configuration');
  need(typeof startEvent === 'string' && UINT.test(startEvent), 'invalid_native_reader_configuration', 'startEvent');
  for (const n of [maxEventsPerScan, maxIndexedEvents, maxTaskIndex]) need(Number.isSafeInteger(n) && n >= 1, 'invalid_native_reader_configuration');
  need(reviewExecutionIds === null || typeof reviewExecutionIds === 'function', 'invalid_native_reader_configuration');
  need(reviewSource === null || (typeof reviewSource?.executionIds === 'function' && reviewExecutionIds === null),
    'invalid_native_reader_configuration', 'reviewSource needs executionIds() and excludes reviewExecutionIds');
  if (reviewSource !== null) reviewExecutionIds = (submissionId) => reviewSource.executionIds(submissionId);
  need(broadcaster === null || (typeof broadcaster?.broadcast === 'function' && broadcaster.chainId === chainId),
    'invalid_native_reader_configuration', 'broadcaster must be bound to the reader chain');
  // A transport pinned to another chain is refused outright (BAINK exposes `pins.chainId`).
  if (typeof transport.pins?.chainId === 'string') need(transport.pins.chainId === chainId, 'native_reader_chain_mismatch');
  const production = chainId === productionChainId;

  /** One transport call; returns the validated state and its own finality evidence. */
  async function once(selection) {
    let out;
    try {
      out = await transport.publicState(structuredClone(selection), { timeoutMs });
    } catch (error) {
      refuse('native_read_failed', codeOf(error) ?? 'transport read failed');
    }
    need(plain(out) && plain(out.state), 'invalid_native_proof');
    const s = out.state;
    const p = out.proof ?? null;
    need(s.chain_id === chainId, 'native_chain_mismatch');
    need(typeof s.height === 'string' && HEIGHT.test(s.height) && Number.isFinite(Date.parse(s.header_time)) && plain(s.records), 'invalid_native_proof');
    for (const k of selection.keys ?? []) need(Object.hasOwn(s.records, k), 'native_record_unproven', k);
    if (selection.member) need(s.member === null || s.member === undefined || (plain(s.member) && s.member.id === selection.member), 'invalid_native_proof');
    if (s.event_count !== undefined) need(typeof s.event_count === 'string' && UINT.test(s.event_count), 'invalid_native_proof');
    if (p !== null)
      need(plain(p) && p.authority === 'native' && p.chainId === chainId && p.height === s.height && (p.appHash === undefined || p.appHash === s.app_hash),
        'native_proof_mismatch');
    const appHash = typeof s.app_hash === 'string' && APP_HASH.test(s.app_hash) ? s.app_hash : null;
    const finalized = s.finalized === true || p?.finalized === true || (appHash !== null && plain(s.signed_header));
    return { s, p, appHash, finalized };
  }

  const consistent = (parts) => parts.every((x) => x.s.chain_id === parts[0].s.chain_id &&
    (parts[0].appHash !== null ? x.appHash === parts[0].appHash : x.s.height === parts[0].s.height) &&
    x.s.event_count === parts[0].s.event_count && (x.s.member?.sequence ?? null) === (parts[0].s.member?.sequence ?? null));

  function compose(parts, member, immutable) {
    // Immutable records (events, task index) may come from successive heights; cite the latest.
    const base = immutable ? parts.reduce((a, x) => (BigInt(x.s.height) > BigInt(a.s.height) ? x : a)) : parts[0];
    const records = {};
    for (const x of parts) Object.assign(records, x.s.records);
    const finalized = parts.every((x) => x.finalized);
    const genesis = typeof base.p?.genesisSha256 === 'string' && HASH.test(base.p.genesisSha256) ? base.p.genesisSha256
      : typeof base.s.epoch === 'string' && HASH.test(base.s.epoch) ? base.s.epoch : null;
    const state = {
      chain_id: base.s.chain_id, height: base.s.height, header_time: base.s.header_time,
      ...(base.appHash !== null ? { app_hash: base.appHash } : {}),
      ...(plain(base.s.signed_header) ? { signed_header: structuredClone(base.s.signed_header) } : {}),
      ...(base.s.event_count !== undefined ? { event_count: base.s.event_count } : {}),
      ...(parts.every((x) => x.s.finalized === true || x.p?.finalized === true) ? { finalized: true } : {}),
      member: member ? structuredClone(base.s.member ?? null) : null,
      records: structuredClone(records),
      fetchedAt: new Date(now()).toISOString(),
      proof: {
        authority: 'native', chainId, height: base.s.height, appHash: base.appHash, headerTime: base.s.header_time, finalized, production,
        ...(genesis ? { genesisSha256: genesis } : {}),
        ...(typeof base.p?.verifierSha256 === 'string' && HASH.test(base.p.verifierSha256) ? { verifierSha256: base.p.verifierSha256 } : {}),
        ...(plain(base.s.signed_header) ? { signedHeaderDigest: sha256(JSON.stringify(base.s.signed_header)) } : {}),
      },
    };
    if (base.s.receipt !== undefined) state.receipt = structuredClone(base.s.receipt);
    return state;
  }

  /** `read({member, keys})` as `native.mjs` expects, plus `fetchedAt` and `proof`. Chunks are
   * retried as a whole until they agree on one committed state. */
  const read = (selection) => readWith(selection, false);
  async function readWith({ member = null, keys = [], receipt } = {}, immutable) {
    need(member === null || (typeof member === 'string' && ADDRESS.test(member)), 'invalid_native_selection', 'member');
    need(Array.isArray(keys) && keys.length <= MAX_KEYS_PER_READ && keys.every((k) => typeof k === 'string' && KEY.test(k)), 'invalid_native_selection', 'keys');
    const unique = [...new Set(keys)];
    const chunks = [];
    for (let i = 0; i < unique.length; i += KEYS_PER_CALL) chunks.push(unique.slice(i, i + KEYS_PER_CALL));
    if (!chunks.length) chunks.push([]);
    need(receipt === undefined || chunks.length === 1, 'invalid_native_selection', 'a receipt read takes at most 32 keys');
    for (let attempt = 0; attempt <= retries; attempt++) {
      const parts = [];
      for (const chunk of chunks)
        parts.push(await once({ ...(member ? { member } : {}), keys: chunk, ...(receipt !== undefined ? { receipt } : {}) }));
      if (immutable || consistent(parts)) return compose(parts, member, immutable);
    }
    refuse('native_read_inconsistent', 'chunked reads did not agree on one committed state');
  }

  /** Bounded event-log index, built only from proven `event/<n>` records. */
  const byDigest = new Map();
  const reviewEvents = new Map();
  let scanned = BigInt(startEvent);
  let indexed = 0;
  async function scanTo(count, budget = maxEventsPerScan) {
    const target = count;
    let left = BigInt(budget);
    while (scanned < target && left > 0n) {
      const n = BigInt(Math.min(Number(target - scanned), Number(left), KEYS_PER_CALL * 8));
      const ids = Array.from({ length: Number(n) }, (_, i) => scanned + 1n + BigInt(i));
      const state = await readWith({ keys: ids.map((id) => `event/${pad(id)}`) }, true);
      for (const id of ids) {
        const e = state.records[`event/${pad(id)}`];
        need(plain(e) && e.id === String(id) && typeof e.height === 'string' && HEIGHT.test(e.height) && BigInt(e.height) <= BigInt(state.height) &&
          ADDRESS.test(e.member ?? '') && typeof e.operation === 'string' && /^[a-z_]{1,64}$/.test(e.operation) &&
          typeof e.subject === 'string' && typeof e.command_digest === 'string' && HASH.test(e.command_digest), 'invalid_native_event', `event ${id}`);
        need(indexed < maxIndexedEvents, 'native_event_index_full');
        indexed++;
        if (!byDigest.has(e.command_digest))
          byDigest.set(e.command_digest, { id: e.id, height: e.height, member: e.member, operation: e.operation, subject: e.subject,
            stateHeight: state.height, appHash: state.app_hash ?? null, finalized: state.proof.finalized });
        if (e.operation === 'central_review') reviewEvents.set(e.subject, (reviewEvents.get(e.subject) ?? 0) + 1);
      }
      scanned += n;
      left -= n;
    }
    return scanned >= target;
  }
  async function eventHead() {
    const head = await read({ keys: [] });
    need(typeof head.event_count === 'string', 'native_event_count_unread');
    return head;
  }

  /** Immutable `central_task_index/<n>` entries, cached once proven. */
  const taskIndex = new Map();

  async function supplySnapshot() {
    const state = await read({ keys: ['coin_supply'] });
    const l = state.records.coin_supply;
    need(l !== null, 'native_supply_unavailable', 'native has no coin supply ledger');
    need(plain(l) && ['minted', 'reserved', 'transparent', 'shielded'].every((k) => typeof l[k] === 'string' && COIN.test(l[k])), 'invalid_native_supply');
    const [minted, reserved, transparent, shielded] = ['minted', 'reserved', 'transparent', 'shielded'].map((k) => BigInt(l[k]));
    need(minted + reserved <= SUPPLY_CAP_UNITS && transparent + shielded === minted, 'invalid_native_supply', 'supply conservation');
    return { supply: { cap: SUPPLY_CAP_UNITS.toString(), issued: l.minted, reserved: l.reserved }, height: state.height, fetchedAt: state.fetchedAt, proof: state.proof };
  }

  return Object.freeze({
    chainId,
    production,
    read,

    /** -> `{code, definite, rejection}`. `definite` (and `rejection`) only from the injected
     * operator broadcaster's first-send refusal; `rebroadcast: true` marks a resend of retained
     * bytes, which the broadcaster never classifies as definite. */
    async broadcast(envelope, { rebroadcast = false } = {}) {
      need(plain(envelope) && plain(envelope.command) && envelope.command.chain_id === chainId, 'invalid_native_envelope');
      need(!production || allowProductionBroadcast === true, 'production_broadcast_not_enabled');
      need(typeof rebroadcast === 'boolean', 'invalid_native_envelope');
      const send = broadcaster !== null ? (e, o) => broadcaster.broadcast(e, { ...o, rebroadcast })
        : typeof transport.broadcast === 'function' ? transport.broadcast.bind(transport)
        : typeof transport.broadcastCentral === 'function' ? transport.broadcastCentral.bind(transport) : null;
      need(send, 'native_broadcast_unavailable');
      const reply = await send(envelope, { timeoutMs });
      const code = Number.isInteger(reply) ? reply : plain(reply) && Number.isInteger(reply.code) ? reply.code : null;
      need(code !== null && code >= 0, 'native_broadcast_reply_invalid');
      const definite = broadcaster !== null && code > 0 && !rebroadcast && reply.definite === true && plain(reply.rejection) && reply.rejection.definite === true;
      return Object.freeze({ code, definite, rejection: definite ? structuredClone(reply.rejection) : null });
    },

    /** Finds a command by its signing digest in the event log. `found` carries a proof that is
     * `finalized` only with transport finality evidence (or a finalized gateway receipt when the
     * retained `envelope` is passed). `expired` only after a complete scan past `expiresHeight`. */
    async findCommand({ member, commandDigest, operation, expiresHeight, envelope } = {}) {
      need(typeof member === 'string' && ADDRESS.test(member) && typeof commandDigest === 'string' && HASH.test(commandDigest) &&
        typeof operation === 'string' && /^[a-z_]{1,64}$/.test(operation) && typeof expiresHeight === 'string' && HEIGHT.test(expiresHeight),
      'invalid_command_query');
      let head = null;
      let complete = true;
      if (!byDigest.has(commandDigest)) {
        head = await eventHead();
        complete = await scanTo(BigInt(head.event_count));
      }
      const e = byDigest.get(commandDigest);
      if (e) {
        need(e.member === member && e.operation === operation, 'native_event_mismatch');
        let finalized = e.finalized === true;
        let receipt;
        if (envelope !== undefined) {
          const state = await read({ member, keys: [], receipt: { envelope, event_id: e.id } });
          const r = state.receipt;
          need(plain(r) && r.authority === 'native' && r.chain_id === chainId && plain(r.event) && r.event.id === e.id &&
            r.event.command_digest === commandDigest && r.event.member === member && r.event.operation === operation, 'native_receipt_mismatch');
          finalized = r.finalized === true; // a fetched receipt decides; it never upgrades by default
          receipt = structuredClone(r);
        }
        return {
          found: true,
          proof: {
            authority: 'native', finalized, chain_id: chainId, command_digest: commandDigest, member, operation,
            event_id: e.id, height: e.height, state_height: e.stateHeight, app_hash: e.appHash, production, ...(receipt ? { receipt } : {}),
          },
        };
      }
      const height = head.height;
      if (!complete) return { found: false, expired: false, complete: false, height, scannedThrough: scanned.toString() };
      return { found: false, expired: BigInt(height) > BigInt(expiresHeight), complete: true, height, scannedThrough: scanned.toString() };
    },

    /** All `central_task/<id>` records of one native project, via the global task index. */
    async tasks(nativeProjectId) {
      need(typeof nativeProjectId === 'string' && NATIVE_ID.test(nativeProjectId), 'invalid_native_project');
      const head = await read({ keys: ['central_task_count'] });
      const raw = head.records.central_task_count;
      const count = raw === null ? '0' : raw;
      need(typeof count === 'string' && UINT.test(count), 'invalid_native_task_index');
      need(BigInt(count) <= BigInt(maxTaskIndex), 'native_task_index_too_large', `${count} tasks exceed the scan bound`);
      const missing = [];
      for (let n = 1n; n <= BigInt(count); n++) if (!taskIndex.has(n)) missing.push(n);
      for (let i = 0; i < missing.length; i += MAX_KEYS_PER_READ) {
        const part = missing.slice(i, i + MAX_KEYS_PER_READ);
        const state = await readWith({ keys: part.map((n) => `central_task_index/${pad(n)}`) }, true);
        for (const n of part) {
          const ref = state.records[`central_task_index/${pad(n)}`];
          need(plain(ref) && typeof ref.id === 'string' && NATIVE_ID.test(ref.id) && typeof ref.project === 'string' && NATIVE_ID.test(ref.project),
            'invalid_native_task_index', `index ${n}`);
          taskIndex.set(n, { id: ref.id, project: ref.project });
        }
      }
      const ids = [];
      for (let n = 1n; n <= BigInt(count); n++) {
        const ref = taskIndex.get(n);
        if (ref.project === nativeProjectId) ids.push(ref.id);
      }
      need(new Set(ids).size === ids.length, 'invalid_native_task_index', 'duplicate task id');
      const tasks = [];
      for (let i = 0; i < ids.length; i += MAX_KEYS_PER_READ) {
        const part = ids.slice(i, i + MAX_KEYS_PER_READ);
        const state = await read({ keys: part.map((id) => `central_task/${id}`) });
        for (const id of part) {
          const t = state.records[`central_task/${id}`];
          need(plain(t) && t.id === id && t.project === nativeProjectId, 'invalid_native_task', id);
          tasks.push(t);
        }
      }
      return tasks;
    },

    /** Reviews of one submission. Refuses (unknown) rather than return a partial list: the
     * candidate execution IDs must account for every `central_review` event of the submission. */
    async reviews(submissionId) {
      need(typeof submissionId === 'string' && NATIVE_ID.test(submissionId), 'invalid_native_submission');
      need(reviewExecutionIds !== null, 'native_reviews_unindexed', 'native has no review index; reviewExecutionIds is not configured');
      need(BigInt(startEvent) === 0n, 'native_reviews_unverified', 'review completeness needs the event log from the first event');
      const head = await eventHead();
      need(await scanTo(BigInt(head.event_count)), 'native_reviews_unverified', 'event log scan incomplete');
      if ((reviewEvents.get(submissionId) ?? 0) === 0) return [];
      const candidates = await reviewExecutionIds(submissionId);
      need(Array.isArray(candidates) && candidates.every((x) => typeof x === 'string' && NATIVE_ID.test(x)), 'invalid_review_candidates');
      const unique = [...new Set(candidates)];
      need(unique.length <= MAX_KEYS_PER_READ, 'invalid_review_candidates');
      const keyOf = (x) => `central_review/${submissionId}/${sha256(x)}`;
      const state = await read({ keys: unique.map(keyOf) });
      // Count the review events at the same state the review records were read from.
      need(typeof state.event_count === 'string' && await scanTo(BigInt(state.event_count)), 'native_reviews_unverified', 'event log scan incomplete');
      const expected = reviewEvents.get(submissionId) ?? 0;
      const found = [];
      for (const x of unique) {
        const r = state.records[keyOf(x)];
        if (r === null) continue;
        need(plain(r) && r.submission === submissionId && r.execution_id === x, 'invalid_native_review');
        found.push(r);
      }
      need(found.length === expected, 'native_reviews_incomplete', `${found.length} of ${expected} reviews located`);
      return found;
    },

    supplySnapshot,
    /** `{cap, issued, reserved}` exactly as `validatePricedTask` takes it. */
    async supply() {
      return (await supplySnapshot()).supply;
    },
  });
}
